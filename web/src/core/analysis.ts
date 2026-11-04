/** What the analysis pass found in one video, and the helpers both passes share. */
export interface Detection {
  /** frame index (presentation order, from 0) */
  frame: number;
  /** [x1, y1, x2, y2, score] in display pixels of the video, score >= minScore */
  boxes: number[][];
}

export interface Analysis {
  name: string;
  bytes: number;
  /** display size (after rotation) */
  width: number;
  height: number;
  rotation: number;
  codec: string;
  hasAudio: boolean;
  /** average bitrate of the video track, bits per second (null if unknown) */
  bitrate: number | null;
  durationS: number;
  /** presentation timestamp (seconds) of every frame, in order */
  timestamps: number[];
  stride: number;
  keep: number;
  workWidth: number;
  workHeight: number;
  minScore: number;
  detections: Detection[];
  backend: string;
  gpuCheck: string | null;
  fallbackReason: string | null;
  threads: number;
  wallS: number;
  detectS: number;
  tiles: number;
}

/** Index of the frame whose timestamp is nearest to t; `hint` (the last answer) makes in-order look-ups O(1). */
export function nearestFrame(ts: number[], t: number, hint = 0): number {
  const n = ts.length;
  if (!n) return 0;
  let i = Math.min(Math.max(hint, 0), n - 1);
  if (ts[i] <= t) {
    while (i + 1 < n && ts[i + 1] <= t) i++;
    return i + 1 < n && ts[i + 1] - t < t - ts[i] ? i + 1 : i;
  }
  // t is before the hint: binary search
  let lo = 0;
  let hi = i;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ts[mid] < t) lo = mid + 1; else hi = mid;
  }
  return lo > 0 && t - ts[lo - 1] <= ts[lo] - t ? lo - 1 : lo;
}

/** The detections as a JSON file: every box at or above `minScore`, so a reader can choose its own threshold. */
export function detectionsJson(a: Analysis, threshold: number): string {
  return JSON.stringify({
    tool: 'FutsalBlur', format: 1,
    video: { name: a.name, width: a.width, height: a.height, frames: a.timestamps.length, durationS: a.durationS },
    detector: { stride: a.stride, workWidth: a.workWidth, workHeight: a.workHeight, minScore: a.minScore, chosenThreshold: threshold },
    note: 'boxes: [x1, y1, x2, y2, score] in pixels of the displayed video; the detector looked at every stride-th frame',
    frames: a.detections.map((d) => ({ frame: d.frame, t: Math.round(a.timestamps[d.frame] * 1e6) / 1e6,
      boxes: d.boxes.map((b) => b.map((v, k) => (k < 4 ? Math.round(v * 10) / 10 : Math.round(v * 1000) / 1000))) })),
  });
}
