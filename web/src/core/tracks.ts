/**
 * Head boxes linked across the frames the detector looked at (every `stride` frames), so every frame in between gets a box:
 * - boxes are linked greedily by centre distance (at most 1.2 x the larger box size) from one detection frame to the next;
 * - a frame between two detections of a head gets the box interpolated;
 * - a head the detector misses in up to `keep` detection frames keeps its last box;
 * - a head is blurred from one stride before its first detection (it may have entered the picture in between).
 * The same rules as the reference tool the blur was measured with.
 */
export type Rect = [number, number, number, number];

interface Track { frames: number[]; boxes: Rect[] }

export class Tracks {
  private items: Track[] = [];
  private last: number[] = [];

  constructor(readonly stride: number, readonly keep: number) {}

  /** Boxes found on detection frame `frame` (frames must come in increasing order). */
  add(frame: number, boxes: Rect[]): void {
    const live = this.items.map((_, i) => i).filter((i) => frame - this.last[i] <= (this.keep + 1) * this.stride);
    const pairs: [number, number, number][] = [];
    for (const ti of live) {
      const t = this.items[ti];
      const lb = t.boxes[t.boxes.length - 1];
      const lcx = (lb[0] + lb[2]) / 2;
      const lcy = (lb[1] + lb[3]) / 2;
      const ls = Math.max(lb[2] - lb[0], lb[3] - lb[1]);
      boxes.forEach((b, bi) => {
        const d = Math.hypot((b[0] + b[2]) / 2 - lcx, (b[1] + b[3]) / 2 - lcy);
        if (d <= 1.2 * Math.max(ls, b[2] - b[0], b[3] - b[1])) pairs.push([d, ti, bi]);
      });
    }
    pairs.sort((p, q) => p[0] - q[0] || p[1] - q[1] || p[2] - q[2]);
    const usedT = new Set<number>();
    const usedB = new Set<number>();
    for (const [, ti, bi] of pairs) {
      if (usedT.has(ti) || usedB.has(bi)) continue;
      usedT.add(ti);
      usedB.add(bi);
      this.items[ti].frames.push(frame);
      this.items[ti].boxes.push([...boxes[bi]] as Rect);
      this.last[ti] = frame;
    }
    boxes.forEach((b, bi) => {
      if (usedB.has(bi)) return;
      this.items.push({ frames: [frame], boxes: [[...b] as Rect] });
      this.last.push(frame);
    });
  }

  /** Index of the tracks, by the range of frames each one covers, for fast look-ups (call after the last add). */
  freeze(): FrozenTracks {
    return new FrozenTracks(this.items.map((t) => ({ ...t, from: t.frames[0] - this.stride,
      to: t.frames[t.frames.length - 1] + (this.keep + 1) * this.stride })));
  }
}

interface Span extends Track { from: number; to: number }

export class FrozenTracks {
  private order: Span[];

  constructor(spans: Span[]) {
    this.order = [...spans].sort((a, b) => a.from - b.from);
  }

  get count(): number { return this.order.length; }

  /** The boxes to blur on frame j. */
  at(j: number): Rect[] {
    const out: Rect[] = [];
    for (const t of this.order) {
      if (t.from > j) break;
      if (j > t.to) continue;
      const ks = t.frames;
      // last detection frame <= j and first >= j
      let lo = 0;
      let hi = ks.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (ks[mid] <= j) lo = mid; else hi = mid - 1;
      }
      const before = ks[lo] <= j ? lo : -1;
      const after = before >= 0 ? (ks[before] === j ? before : before + 1 < ks.length ? before + 1 : -1) : 0;
      if (before >= 0 && after >= 0) {
        const b0 = ks[before];
        const b1 = ks[after];
        const a = b1 === b0 ? 0 : (j - b0) / (b1 - b0);
        const p = t.boxes[before];
        const q = t.boxes[after];
        out.push([(1 - a) * p[0] + a * q[0], (1 - a) * p[1] + a * q[1], (1 - a) * p[2] + a * q[2], (1 - a) * p[3] + a * q[3]]);
      } else {
        out.push([...t.boxes[before >= 0 ? before : after]] as Rect);
      }
    }
    return out;
  }
}

/** Tracks of the detections at or above `threshold`: detections are [frame, boxes] in increasing frame order. */
export function buildTracks(detections: { frame: number; boxes: number[][] }[], threshold: number, stride: number,
  keep = 1): FrozenTracks {
  const tr = new Tracks(stride, keep);
  for (const d of detections) tr.add(d.frame, d.boxes.filter((b) => b[4] >= threshold).map((b) => [b[0], b[1], b[2], b[3]] as Rect));
  return tr.freeze();
}
