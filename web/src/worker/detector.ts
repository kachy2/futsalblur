/**
 * The head detector (D-FINE-N fine-tuned to one class, "head"; Apache-2.0 base model) via onnxruntime-web, on the graphics chip
 * (WebGPU) or on CPU threads (WASM). 'auto' (the default) takes WebGPU where the browser offers a real GPU (not a phone, not a
 * software adapter) and keeps whichever of GPU and CPU is faster on a fixed test tile; 'webgpu' insists on the GPU, 'wasm' never
 * touches it. WebGPU is used only if it creates a session, runs the test tile within the time limit and agrees with WASM on it;
 * a backend that fails there, or later during inference, is replaced by WASM and the reason is kept.
 * Input: one 640 x 640 tile of the working frame, RGB / 255 (no mean or std), zero outside the frame.
 */
import * as ort from 'onnxruntime-web/webgpu';
import { decodeTile, type Box } from '../core/boxes';
import { reshapeInitializers } from '../core/onnx-patch';
import { INPUT } from '../core/tiles';

export interface Detector {
  readonly backend: string;
  /** why WebGPU was given up, if it was */
  readonly fallbackReason: string | null;
  /** WebGPU only: largest difference to the WASM results on the test tile, and the time per tile on each */
  readonly gpuCheck: string | null;
  /** WASM threads in use (onnxruntime-web drops to 1 when the page is not cross-origin isolated) */
  readonly threads: number;
  /** Heads in the 640 x 640 tile at (ox, oy) of an RGBA frame of fw x fh pixels, in frame pixels. */
  detect(rgba: Uint8ClampedArray, fw: number, fh: number, ox: number, oy: number, minScore: number): Promise<Box[]>;
  release(): Promise<void>;
}

export interface DetectorOptions {
  /** how long WebGPU may take to create its session and run the test tile (a software adapter needs minutes) */
  webgpuWaitMs?: number;
  /** 'auto' also takes a software adapter (tests only: the container has no real GPU) */
  anyGpu?: boolean;
}

/** onnxruntime-web 1.29's WebGPU backend cannot run a MatMul whose weight is a 1-D tensor ("SizeToDimension ... Invalid dimension of
 * 4294967295"; it computes rank - 2 on an unsigned number). D-FINE's three `integral` layers project the 33 distribution bins with
 * such a weight; one more axis of length 1 gives the same numbers (WASM results differ by < 2e-5). Only the WebGPU session gets this. */
const WEBGPU_FIX: Record<string, number[]> = { '/m/model/decoder/Concat_output_0': [33, 1] };
/** WebGPU must match WASM on the test tile this closely */
const LOGIT_TOL = 0.02;
const BOX_TOL = 0.005;
/** 'auto' keeps the CPU only if it is this much faster than the GPU: the GPU leaves the processor free for decoding */
const CPU_MUST_BE_FASTER = 1.3;

interface Raw { logits: Float32Array; boxes: Float32Array; nq: number; nc: number }

/** A fixed noise tile: the same input for every backend and every run. */
function testTile(): Uint8ClampedArray {
  const px = new Uint8ClampedArray(INPUT * INPUT * 4);
  let s = 12345;
  for (let i = 0; i < px.length; i++) {
    if (i % 4 === 3) { px[i] = 255; continue; }
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    px[i] = s >>> 24;
  }
  return px;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer = 0;
  const limit = new Promise<never>((_, reject) => { timer = self.setTimeout(() => reject(new Error(`timed out after ${Math.round(ms / 1000)} s`)), ms); });
  return Promise.race([p, limit]).finally(() => self.clearTimeout(timer));
}

const maxDiff = (a: Float32Array, b: Float32Array) => a.reduce((m, v, i) => Math.max(m, Math.abs(v - b[i])), 0);

/** A real GPU for 'auto': WebGPU is there, the device is not a phone (little memory, throttled) and the adapter is no software fallback. */
async function hasRealGpu(anyAdapter = false): Promise<boolean> {
  try {
    const gpu = (navigator as unknown as { gpu?: { requestAdapter(): Promise<{ isFallbackAdapter?: boolean; info?: { isFallbackAdapter?: boolean } } | null> } }).gpu;
    if (!gpu || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)) return false;
    const adapter = await gpu.requestAdapter();
    return !!adapter && (anyAdapter || !(adapter.isFallbackAdapter ?? adapter.info?.isFallbackAdapter));
  } catch {
    return false;
  }
}

/** Fill the planar RGB input with the tile at (ox, oy) of the frame; pixels outside the frame stay 0. */
function fillTile(input: Float32Array, rgba: Uint8ClampedArray, fw: number, fh: number, ox: number, oy: number): void {
  const plane = INPUT * INPUT;
  input.fill(0);
  const w = Math.min(INPUT, fw - ox);
  const h = Math.min(INPUT, fh - oy);
  for (let y = 0; y < h; y++) {
    let src = ((oy + y) * fw + ox) * 4;
    let dst = y * INPUT;
    for (let x = 0; x < w; x++, src += 4, dst++) {
      input[dst] = rgba[src] / 255;
      input[plane + dst] = rgba[src + 1] / 255;
      input[2 * plane + dst] = rgba[src + 2] / 255;
    }
  }
}

export async function createDetector(modelUrl: string, prefer: 'auto' | 'webgpu' | 'wasm' = 'auto', threads?: number,
  opts: DetectorOptions = {}): Promise<Detector> {
  // the runtime's .mjs and .wasm are plain files in <app>/ort/ (prepare-assets.mjs copies them); the model is in <app>/models/
  ort.env.wasm.wasmPaths = new URL('../ort/', modelUrl).href;
  const cores = navigator.hardwareConcurrency || 1;
  ort.env.wasm.numThreads = threads ?? (self.crossOriginIsolated ? Math.min(4, Math.max(1, cores >> 1)) : 1);
  const model = new Uint8Array(await (await fetch(modelUrl)).arrayBuffer());
  const input = new Float32Array(3 * INPUT * INPUT);
  const makeSession = (ep: 'webgpu' | 'wasm') =>
    ort.InferenceSession.create(ep === 'webgpu' ? (reshapeInitializers(model, WEBGPU_FIX) ?? model) : model,
      { executionProviders: [ep], graphOptimizationLevel: 'all' });
  const run = async (session: ort.InferenceSession, copy = false): Promise<Raw> => {
    const out = await session.run({ pixel_values: new ort.Tensor('float32', input, [1, 3, INPUT, INPUT]) });
    const logits = out.logits.data as Float32Array; // [1, 300, 1]
    const boxes = out.pred_boxes.data as Float32Array; // [1, 300, 4]
    return { logits: copy ? logits.slice() : logits, boxes: copy ? boxes.slice() : boxes, nq: out.logits.dims[1], nc: out.logits.dims[2] };
  };

  let ep: 'webgpu' | 'wasm' = 'wasm';
  let current: ort.InferenceSession | null = null;
  let standby: ort.InferenceSession | null = null; // the WASM session that proved the WebGPU results, kept for a fallback
  let fallbackReason: string | null = null;
  let gpuCheck: string | null = null;
  const describe = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 400);
  const gpu = { session: null as ort.InferenceSession | null };
  let cpu: ort.InferenceSession | null = null;
  let useGpu = false;
  if (prefer === 'webgpu' ? 'gpu' in navigator : prefer === 'auto' && (await hasRealGpu(opts.anyGpu))) {
    const tile = testTile();
    const load = () => fillTile(input, tile, INPUT, INPUT, 0, 0);
    const timeOf = async (session: ort.InferenceSession) => { // best of two runs after the first (which compiles shaders / warms up)
      let best = Infinity;
      for (let i = 0; i < 2; i++) {
        load();
        const s = performance.now();
        await run(session);
        best = Math.min(best, performance.now() - s);
      }
      return Math.round(best);
    };
    // some adapters only fail (or hang) when a kernel runs, so the session is not trusted before the test tile has been run
    const warmUp = (async () => {
      gpu.session = await makeSession('webgpu');
      load();
      return run(gpu.session, true);
    })();
    try {
      const onGpu = await withTimeout(warmUp, opts.webgpuWaitMs ?? 60_000);
      cpu = await makeSession('wasm');
      load();
      const onCpu = await run(cpu, true);
      const dl = maxDiff(onGpu.logits, onCpu.logits);
      const db = maxDiff(onGpu.boxes, onCpu.boxes);
      gpuCheck = `logits ${dl.toExponential(1)}, boxes ${db.toExponential(1)}`;
      if (!(dl <= LOGIT_TOL && db <= BOX_TOL)) throw new Error(`results differ from WASM (${gpuCheck})`); // also catches NaN
      useGpu = true;
      if (prefer === 'auto') {
        const gpuMs = await timeOf(gpu.session!);
        const cpuMs = await timeOf(cpu);
        gpuCheck += `; per tile: gpu ${gpuMs} ms, cpu ${cpuMs} ms (${ort.env.wasm.numThreads} threads)`;
        useGpu = !(cpuMs * CPU_MUST_BE_FASTER < gpuMs);
      }
    } catch (e) {
      useGpu = false;
      fallbackReason = `webgpu: ${describe(e)}`;
    }
    if (!useGpu) void warmUp.then(() => undefined, () => undefined).then(() => gpu.session?.release()).catch(() => undefined);
  }
  if (useGpu) {
    current = gpu.session;
    standby = cpu;
    ep = 'webgpu';
  } else {
    current = cpu ?? (await makeSession('wasm'));
  }

  const toBoxes = (r: Raw, ox: number, oy: number, minScore: number): Box[] =>
    decodeTile(r.logits, r.boxes, r.nq, r.nc, minScore).map((b): Box => [b[0] + ox, b[1] + oy, b[2] + ox, b[3] + oy, b[4]]);

  return {
    get backend() { return fallbackReason ? 'wasm (webgpu failed)' : ep; },
    get fallbackReason() { return fallbackReason; },
    get gpuCheck() { return gpuCheck; },
    get threads() { return ort.env.wasm.numThreads ?? 1; },
    async detect(rgba, fw, fh, ox, oy, minScore) {
      fillTile(input, rgba, fw, fh, ox, oy);
      try {
        return toBoxes(await run(current!), ox, oy, minScore);
      } catch (e) {
        if (ep !== 'webgpu') throw e;
        // the GPU backend broke while running: continue with WASM from this very tile
        fallbackReason = `webgpu: ${describe(e)}`;
        await current!.release().catch(() => undefined);
        ep = 'wasm';
        current = standby ?? (await makeSession('wasm'));
        standby = null;
        return toBoxes(await run(current), ox, oy, minScore);
      }
    },
    async release() {
      await current?.release().catch(() => undefined);
      await standby?.release().catch(() => undefined);
    },
  };
}
