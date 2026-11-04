/// <reference lib="webworker" />
/**
 * Export worker: decodes the video again, blurs the head boxes of every frame (the tracks of the detections at the chosen
 * threshold) and encodes it as H.264 in an MP4, straight to the file the user picked (File System Access API) or, where that
 * API is missing, into memory. The audio track is copied as it is. Rotation is baked into the frames (the output has none).
 */
import { ALL_FORMATS, BlobSource, BufferTarget, Conversion, Input, Mp4OutputFormat, Output, QUALITY_HIGH, StreamTarget } from 'mediabunny';
import { nearestFrame, type Analysis } from '../core/analysis';
import { blurBoxes, type BlurOptions } from '../core/blur';
import { buildTracks } from '../core/tracks';

let running: Conversion | null = null;

self.onmessage = async (ev: MessageEvent) => {
  const msg = ev.data;
  if (msg?.type === 'cancel') { void running?.cancel(); return; }
  if (msg?.type !== 'export') return;
  const t0 = performance.now();
  try {
    const a = msg.analysis as Pick<Analysis, 'width' | 'height' | 'timestamps' | 'detections' | 'stride' | 'keep' | 'bitrate'>;
    const blur = msg.blur as BlurOptions;
    const handle = (msg.handle ?? null) as FileSystemFileHandle | null;
    const tracks = buildTracks(a.detections, msg.threshold as number, a.stride, a.keep);
    const input = new Input({ source: new BlobSource(msg.file as File), formats: ALL_FORMATS });
    const writable = handle ? await handle.createWritable() : null;
    const target = writable ? new StreamTarget(writable, { chunked: true }) : new BufferTarget();
    const output = new Output({ format: new Mp4OutputFormat({ fastStart: writable ? false : 'in-memory' }), target });
    const W = a.width;
    const H = a.height;
    const canvas = new OffscreenCanvas(W, H);
    const ctx = canvas.getContext('2d')!;
    const scratch = new OffscreenCanvas(64, 64);
    let j = 0;
    let offset: number | null = null; // the conversion may start the timeline at zero: compare timestamps from the first frame
    let blurred = 0;
    const conversion = await Conversion.init({
      input, output,
      video: {
        forceTranscode: true, allowTransformationMetadata: false, codec: 'avc', processedWidth: W, processedHeight: H,
        // about the bitrate of the original (4K phone recordings: 40-50 Mbps), at least 4 Mbps
        bitrate: a.bitrate ? Math.round(Math.min(60e6, Math.max(4e6, a.bitrate))) : QUALITY_HIGH,
        process: (sample) => {
          if (offset === null) offset = sample.timestamp - a.timestamps[0];
          j = nearestFrame(a.timestamps, sample.timestamp - offset, j);
          sample.drawWithFit(ctx, { fit: 'fill' });
          const boxes = tracks.at(j);
          blurred += boxes.length;
          blurBoxes(ctx, W, H, boxes, blur, scratch);
          return canvas;
        },
      },
    });
    if (!conversion.isValid) {
      throw new Error(`cannot convert: ${conversion.discardedTracks.map((d) => `${d.track.type} ${d.reason}`).join(', ')}`);
    }
    conversion.onProgress = (p) => postMessage({ type: 'progress', share: p, wallS: (performance.now() - t0) / 1000 });
    running = conversion;
    await conversion.execute();
    running = null;
    // self-check: reopen what was written and read its duration
    const blob = handle ? await handle.getFile() : new Blob([(target as BufferTarget).buffer!], { type: 'video/mp4' });
    const check = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
    const checkVideo = await check.getPrimaryVideoTrack();
    const durationS = (await check.computeDuration()) - (checkVideo ? await checkVideo.getFirstTimestamp() : 0);
    const audio = !!(await check.getPrimaryAudioTrack());
    postMessage({ type: 'done', bytes: blob.size, durationS, audio, blurred, wallS: (performance.now() - t0) / 1000,
      blob: handle ? null : blob });
  } catch (e) {
    running = null;
    postMessage({ type: 'error', message: String((e as Error)?.message ?? e) });
  }
};
