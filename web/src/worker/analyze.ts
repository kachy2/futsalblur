/// <reference lib="webworker" />
/**
 * Analysis worker: decodes every frame of the video (WebCodecs through Mediabunny) and runs the head detector on every
 * STRIDE-th frame, brought to the working size (display orientation) and cut into overlapping 640 px tiles.
 * The boxes of all tiles are merged (non-maximum suppression) and kept down to MIN_SCORE, in display pixels.
 */
import { ALL_FORMATS, BlobSource, Input, VideoSampleSink } from 'mediabunny';
import type { Analysis, Detection } from '../core/analysis';
import { nms, type Box } from '../core/boxes';
import { KEEP, MIN_SCORE, STRIDE } from '../core/settings';
import { tiles, workSize } from '../core/tiles';
import { createDetector, type Detector } from './detector';

const signal = { cancelled: false };

self.onmessage = async (ev: MessageEvent) => {
  const msg = ev.data;
  if (msg?.type === 'cancel') signal.cancelled = true;
  if (msg?.type !== 'analyze') return;
  signal.cancelled = false;
  let det: Detector | null = null;
  try {
    const t0 = performance.now();
    const file = msg.file as File;
    const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error('no video track');
    if (!(await track.canDecode())) throw new Error(`this browser cannot decode the video (${track.codec ?? 'unknown codec'})`);
    const audio = await input.getPrimaryAudioTrack();
    const first = await track.getFirstTimestamp();
    // the length from the first frame (a clip cut out of a longer recording may keep its timestamps)
    const durationS = Math.max(0, (await input.computeDuration()) - first);
    const stats = await track.computePacketStats(200).catch(() => null);
    const W = track.displayWidth;
    const H = track.displayHeight;
    const ws = workSize(W, H);
    det = await createDetector(msg.modelUrl as string, msg.backend ?? 'auto', msg.threads, { webgpuWaitMs: msg.webgpuWaitMs, anyGpu: msg.anyGpu });
    postMessage({ type: 'status', backend: det.backend, gpuCheck: det.gpuCheck, fallbackReason: det.fallbackReason, threads: det.threads });

    const canvas = new OffscreenCanvas(ws.width, ws.height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.imageSmoothingQuality = 'high';
    const layout = tiles(ws.width, ws.height);
    const timestamps: number[] = [];
    const detections: Detection[] = [];
    let n = 0;
    let detectS = 0;
    let lastPost = 0;
    for await (const sample of new VideoSampleSink(track).samples()) {
      try {
        timestamps.push(sample.timestamp);
        if (n % STRIDE === 0) {
          const s = performance.now();
          sample.drawWithFit(ctx, { fit: 'fill' });
          const rgba = ctx.getImageData(0, 0, ws.width, ws.height).data;
          const found: Box[] = [];
          for (const [x, y] of layout) found.push(...(await det.detect(rgba, ws.width, ws.height, x, y, MIN_SCORE)));
          detections.push({ frame: n, boxes: nms(found).map((b) => [b[0] / ws.scale, b[1] / ws.scale, b[2] / ws.scale, b[3] / ws.scale, b[4]]) });
          detectS += (performance.now() - s) / 1000;
        }
      } finally {
        sample.close();
      }
      n++;
      const now = performance.now();
      if (now - lastPost > 500) {
        lastPost = now;
        postMessage({ type: 'progress', doneS: timestamps[timestamps.length - 1] - first, totalS: durationS, frames: n, wallS: (now - t0) / 1000,
          backend: det.backend });
      }
      if (signal.cancelled) throw new Error('cancelled');
    }
    const result: Analysis = {
      name: file.name, bytes: file.size, width: W, height: H, rotation: track.rotation, codec: track.codec ?? 'unknown',
      hasAudio: !!audio, bitrate: stats?.averageBitrate ?? null, durationS, timestamps, stride: STRIDE, keep: KEEP,
      workWidth: ws.width, workHeight: ws.height, minScore: MIN_SCORE, detections, backend: det.backend, gpuCheck: det.gpuCheck,
      fallbackReason: det.fallbackReason, threads: det.threads, wallS: (performance.now() - t0) / 1000, detectS, tiles: layout.length,
    };
    postMessage({ type: 'done', result });
  } catch (e) {
    postMessage({ type: 'error', message: String((e as Error)?.message ?? e) });
  } finally {
    await det?.release();
  }
};
