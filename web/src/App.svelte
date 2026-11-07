<script lang="ts">
  import { ALL_FORMATS, BlobSource, Input, VideoSampleSink } from 'mediabunny';
  import { APP_ROOT } from './base';
  import { detectionsJson, type Analysis } from './core/analysis';
  import { blurBoxes, DEFAULT_BLUR, type BlurOptions } from './core/blur';
  import { DEFAULT_THRESHOLD, PRESETS, formatThreshold, type Preset } from './core/settings';
  import { buildTracks, type FrozenTracks } from './core/tracks';
  import { strings, type Lang } from './ui/i18n';

  const store = {
    get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
  };
  // English unless the link says ?lang=ko (or en), the page is the static /ko/ one, or the visitor picked a language before
  const isLang = (v: string | null): v is Lang => v === 'ko' || v === 'en';
  const params = new URLSearchParams(location.search);
  const urlLang = params.get('lang');
  const pageLang = document.documentElement.dataset.defaultLang ?? null;
  if (isLang(urlLang)) store.set('lang', urlLang);
  const savedLang = store.get('lang');
  let lang = $state<Lang>(isLang(urlLang) ? urlLang : isLang(pageLang) ? pageLang : isLang(savedLang) ? savedLang : 'en');
  const t = $derived(strings[lang]);
  const envError = $derived(typeof VideoDecoder !== 'undefined' ? '' : isSecureContext ? t.errNoWebCodecs : t.errInsecure);
  $effect(() => {
    document.title = t.docTitle;
    document.documentElement.lang = lang;
  });
  // test overrides: ?threads=N sets the detector's WASM threads, ?gpuwait=S the seconds WebGPU may take to set up,
  // ?gpuany=1 lets 'auto' take a software WebGPU adapter
  const threads = Number(params.get('threads')) || undefined;
  const webgpuWaitMs = (Number(params.get('gpuwait')) || 60) * 1000;
  const anyGpu = params.get('gpuany') === '1' || undefined;
  const modelUrl = new URL('models/head.onnx', APP_ROOT).href;

  let file = $state<File | null>(null);
  let fileInfo = $state<{ width: number; height: number } | null>(null);
  let over = $state(false);
  let error = $state('');
  let backend = $state<'auto' | 'webgpu' | 'wasm'>('auto');
  let analysing = $state(false);
  let progress = $state<{ doneS: number; totalS: number; wallS: number; backend: string } | null>(null);
  let status = $state<{ backend: string; gpuCheck: string | null; fallbackReason: string | null; threads: number } | null>(null);
  let result = $state.raw<Analysis | null>(null);

  let threshold = $state(DEFAULT_THRESHOLD);
  let blur = $state<BlurOptions>({ ...DEFAULT_BLUR });
  let showBoxes = $state(false);
  let frameIdx = $state(0);
  const tracks = $derived<FrozenTracks | null>(result ? buildTracks(result.detections, threshold, result.stride, result.keep) : null);
  const perFrame = $derived(result && result.detections.length
    ? result.detections.reduce((s, d) => s + d.boxes.filter((b) => b[4] >= threshold).length, 0) / result.detections.length : 0);

  let saving = $state(false);
  let saveProgress = $state<{ share: number; wallS: number } | null>(null);
  let saved = $state<{ bytes: number; durationS: number; audio: boolean; url: string | null } | null>(null);

  const analyzer = new Worker(new URL('./worker/analyze.ts', import.meta.url), { type: 'module' });
  analyzer.onmessage = (ev: MessageEvent) => {
    const m = ev.data;
    if (m.type === 'status') status = m;
    else if (m.type === 'progress') progress = m;
    else if (m.type === 'done') {
      result = m.result as Analysis;
      analysing = false;
      frameIdx = firstBusyFrame(result);
    } else if (m.type === 'error') {
      analysing = false;
      if (m.message !== 'cancelled') error = m.message;
    }
  };
  const exporter = new Worker(new URL('./worker/export.ts', import.meta.url), { type: 'module' });
  exporter.onmessage = (ev: MessageEvent) => {
    const m = ev.data;
    if (m.type === 'progress') saveProgress = m;
    else if (m.type === 'done') {
      saving = false;
      saved = { bytes: m.bytes, durationS: m.durationS, audio: m.audio, url: m.blob ? URL.createObjectURL(m.blob as Blob) : null };
    } else if (m.type === 'error') {
      saving = false;
      error = m.message;
    }
  };

  /** A frame with many detections, to show something useful first. */
  function firstBusyFrame(a: Analysis): number {
    let best = 0;
    let most = -1;
    for (const d of a.detections) {
      const n = d.boxes.filter((b) => b[4] >= DEFAULT_THRESHOLD).length;
      if (n > most) { most = n; best = d.frame; }
    }
    return best;
  }

  async function pick(f: File | undefined) {
    if (!f) return;
    error = '';
    result = null;
    saved = null;
    file = f;
    fileInfo = null;
    try {
      const input = new Input({ source: new BlobSource(f), formats: ALL_FORMATS });
      const track = await input.getPrimaryVideoTrack();
      if (!track) throw new Error('no video track');
      fileInfo = { width: track.displayWidth, height: track.displayHeight };
      previewSink = new VideoSampleSink(track);
    } catch (e) {
      error = String((e as Error)?.message ?? e);
      file = null;
    }
  }

  function analyse() {
    if (!file) return;
    error = '';
    result = null;
    saved = null;
    progress = null;
    status = null;
    analysing = true;
    analyzer.postMessage({ type: 'analyze', file, modelUrl, backend, threads, webgpuWaitMs, anyGpu });
  }

  // preview: the chosen frame at full size, blurred with the current settings, shown scaled down
  let previewSink: VideoSampleSink | null = null;
  let previewCanvas = $state<HTMLCanvasElement | null>(null);
  let full: OffscreenCanvas | null = null;
  const scratch = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(64, 64) : null;
  let rendering = false;
  let again = false;
  async function renderPreview() {
    if (rendering) { again = true; return; }
    const a = result;
    const tr = tracks;
    if (!a || !tr || !previewSink || !previewCanvas || !scratch) return;
    rendering = true;
    try {
      const j = Math.min(frameIdx, a.timestamps.length - 1);
      const sample = await previewSink.getSample(a.timestamps[j]);
      if (!sample) return;
      if (!full || full.width !== a.width || full.height !== a.height) full = new OffscreenCanvas(a.width, a.height);
      const ctx = full.getContext('2d')!;
      try { sample.drawWithFit(ctx, { fit: 'fill' }); } finally { sample.close(); }
      blurBoxes(ctx, a.width, a.height, tr.at(j), blur, scratch);
      if (showBoxes) {
        const d = a.detections.find((x) => x.frame >= j - (j % a.stride)) ?? null;
        ctx.lineWidth = Math.max(2, a.width / 960);
        for (const b of d?.boxes ?? []) {
          ctx.strokeStyle = b[4] >= threshold ? '#2ecc71' : 'rgba(255,255,255,0.6)';
          ctx.strokeRect(b[0], b[1], b[2] - b[0], b[3] - b[1]);
        }
      }
      const k = Math.min(1, 1280 / a.width);
      previewCanvas.width = Math.round(a.width * k);
      previewCanvas.height = Math.round(a.height * k);
      previewCanvas.getContext('2d')!.drawImage(full, 0, 0, previewCanvas.width, previewCanvas.height);
    } catch (e) {
      error = String((e as Error)?.message ?? e);
    } finally {
      rendering = false;
      if (again) { again = false; void renderPreview(); }
    }
  }
  $effect(() => {
    // re-render whenever the frame or a setting changes
    void [frameIdx, threshold, blur.grow, blur.strength, blur.shape, blur.style, showBoxes, result, previewCanvas];
    void renderPreview();
  });

  function presetLabel(p: Preset): string {
    return { max: t.presetMax, faces: t.presetFaces, more: t.presetMore, balanced: t.presetBalanced, least: t.presetLeast }[p.id];
  }

  function downloadJson() {
    if (!result) return;
    const url = URL.createObjectURL(new Blob([detectionsJson(result, threshold)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${result.name.replace(/\.[^.]+$/, '')}.heads.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  async function save() {
    if (!file || !result) return;
    error = '';
    saved = null;
    let handle: FileSystemFileHandle | null = null;
    const picker = (window as unknown as { showSaveFilePicker?: (o: unknown) => Promise<FileSystemFileHandle> }).showSaveFilePicker;
    if (picker) {
      try {
        handle = await picker({ suggestedName: `${file.name.replace(/\.[^.]+$/, '')}_blurred.mp4`,
          types: [{ description: 'MP4 video', accept: { 'video/mp4': ['.mp4'] } }] });
      } catch {
        return; // the user closed the dialog
      }
    }
    saving = true;
    saveProgress = null;
    const { width, height, timestamps, detections, stride, keep, bitrate } = result;
    exporter.postMessage({ type: 'export', file, handle, threshold, blur: { ...blur },
      analysis: { width, height, timestamps, detections, stride, keep, bitrate } });
  }
</script>

<main>
  <header class="row">
    <div>
      <h1>{t.title}</h1>
      <p class="muted">{t.tagline}</p>
    </div>
    <span class="spacer"></span>
    <button onclick={() => { lang = lang === 'en' ? 'ko' : 'en'; store.set('lang', lang); }}>{t.langSwitch}</button>
  </header>

  {#if envError}<p class="error">{envError}</p>{/if}

  <section class="card">
    <h2>{t.step1}</h2>
    <label class="drop" class:over ondragover={(e) => { e.preventDefault(); over = true; }} ondragleave={() => (over = false)}
      ondrop={(e) => { e.preventDefault(); over = false; void pick(e.dataTransfer?.files[0]); }}>
      <input type="file" accept="video/mp4,video/quicktime,.mp4,.mov,.m4v" hidden
        onchange={(e) => void pick((e.currentTarget as HTMLInputElement).files?.[0])} />
      {#if file}
        <strong>{file.name}</strong>{#if fileInfo}<span class="muted"> — {t.fileInfo(fileInfo.width, fileInfo.height, file.size / 1e6)}</span>{/if}
      {:else}
        {t.dropHint}
      {/if}
    </label>
  </section>

  {#if file}
    <section class="card">
      <h2>{t.step2}</h2>
      <p class="muted small">{t.findHint}</p>
      <div class="row">
        <button class="primary" onclick={analyse} disabled={analysing || !!envError}>{t.find}</button>
        {#if analysing}<button onclick={() => analyzer.postMessage({ type: 'cancel' })}>{t.cancel}</button>{/if}
        <span class="spacer"></span>
        <label class="small">{t.backend}
          <select bind:value={backend} disabled={analysing}>
            <option value="auto">{t.backendAuto}</option>
            <option value="webgpu">{t.backendGpu}</option>
            <option value="wasm">{t.backendCpu}</option>
          </select>
        </label>
      </div>
      {#if analysing && progress}
        <div class="bar" style="margin-top:10px"><div style="width:{(100 * progress.doneS) / Math.max(1e-6, progress.totalS)}%"></div></div>
        <p class="small muted">{t.progress(progress.doneS, progress.totalS, progress.wallS)} · {progress.backend}</p>
      {/if}
    </section>
  {/if}

  {#if result}
    <section class="card">
      <h2>{t.step3}</h2>
      <canvas class="preview" bind:this={previewCanvas}></canvas>
      <div class="row">
        <input type="range" class="wide" min="0" max={result.timestamps.length - 1} step="1" bind:value={frameIdx} />
      </div>
      <p class="small muted">{t.frame(frameIdx, result.timestamps.length, result.timestamps[frameIdx] - result.timestamps[0])} · {t.perFrame(perFrame)}</p>

      <fieldset>
        <legend>{t.threshold}: <strong>{formatThreshold(threshold)}</strong></legend>
        {#each PRESETS as p (p.id)}
          <label class="choice"><input type="radio" name="preset" checked={Math.abs(threshold - p.threshold) < 1e-9}
            onchange={() => (threshold = p.threshold)} /> {presetLabel(p)}</label>
        {/each}
        <input type="range" min="0.05" max="0.6" step="0.005" bind:value={threshold} />
      </fieldset>

      <div class="grid">
        <label>{t.growLabel(blur.grow)}<input type="range" min="0" max="0.5" step="0.05" bind:value={blur.grow} /></label>
        <label>{t.strengthLabel(blur.strength)}<input type="range" min="0.1" max="0.5" step="0.05" bind:value={blur.strength} /></label>
        <label>{t.style}
          <select bind:value={blur.style}><option value="blur">{t.styleBlur}</option><option value="pixelate">{t.stylePixelate}</option></select>
        </label>
        <label>{t.shape}
          <select bind:value={blur.shape}><option value="ellipse">{t.shapeEllipse}</option><option value="rect">{t.shapeRect}</option></select>
        </label>
        <label class="choice"><input type="checkbox" bind:checked={showBoxes} /> {t.showBoxes}</label>
      </div>
      <div class="row"><button onclick={downloadJson}>{t.downloadJson}</button></div>
    </section>

    <section class="card">
      <h2>{t.step4}</h2>
      <p class="muted small">{t.saveHint}</p>
      <div class="row">
        <button class="primary" onclick={save} disabled={saving}>{t.save}</button>
        {#if saving}<button onclick={() => exporter.postMessage({ type: 'cancel' })}>{t.cancel}</button>{/if}
      </div>
      {#if saving && saveProgress}
        <div class="bar" style="margin-top:10px"><div style="width:{100 * saveProgress.share}%"></div></div>
        <p class="small muted">{t.saving(saveProgress.share, saveProgress.wallS)}</p>
      {/if}
      {#if saved}
        <p>{t.saved(saved.bytes / 1e6, saved.durationS, saved.audio)}
          {#if saved.url}<a href={saved.url} download={`${file?.name.replace(/\.[^.]+$/, '')}_blurred.mp4`}>{t.download}</a>{/if}</p>
      {/if}
      <p class="small warn">{t.limits}</p>
    </section>

    <details class="card small">
      <summary>{t.diagnostics}</summary>
      <pre>{JSON.stringify({ backend: result.backend, threads: result.threads, gpuCheck: result.gpuCheck, fallback: result.fallbackReason,
        width: result.width, height: result.height, codec: result.codec, rotation: result.rotation, hasAudio: result.hasAudio,
        frames: result.timestamps.length, detectionFrames: result.detections.length, tilesPerFrame: result.tiles,
        work: `${result.workWidth}x${result.workHeight}`, durationS: +result.durationS.toFixed(2), wallS: +result.wallS.toFixed(1),
        detectS: +result.detectS.toFixed(1), msPerTile: +((1000 * result.detectS) / Math.max(1, result.detections.length * result.tiles)).toFixed(1),
        speed: `${(result.durationS / Math.max(1e-6, result.wallS)).toFixed(3)}x real time`, tracks: tracks?.count }, null, 1)}</pre>
    </details>
  {/if}

  {#if status && analysing}<p class="small muted">{status.backend}{status.fallbackReason ? ` (${status.fallbackReason})` : ''}</p>{/if}
  {#if error}<p class="error">{t.errorPrefix}{error}</p>{/if}

  <footer class="footer small muted">
    <p>{t.privacy}</p>
    <p><a href="https://github.com/kachy2/futsalblur">{t.source}</a></p>
  </footer>
</main>
