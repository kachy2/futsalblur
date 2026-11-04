/**
 * Where the head detector looks: the frame is brought to a working size (1080p detail for 4K, never enlarged) and cut into
 * 640 px tiles that overlap by 96 px, so a head of up to about 90 px lies whole in one of two neighbouring tiles.
 * The same layout as the reference tool the model was trained and measured with.
 */
export const INPUT = 640;
export const OVERLAP = 96;
/** The working size's longer side: 1920 keeps the detail of 1080p, where the detector was checked on 4K recordings. */
export const WORK_SIDE = 1920;

export function tileOrigins(length: number, tile = INPUT, overlap = OVERLAP): number[] {
  if (length <= tile) return [0];
  const step = tile - overlap;
  const out = new Set<number>();
  for (let v = 0; v < length - tile; v += step) out.add(v);
  out.add(length - tile); // the last tile is aligned to the edge
  return [...out].sort((a, b) => a - b);
}

export function tiles(width: number, height: number): [number, number][] {
  const xs = tileOrigins(width);
  return tileOrigins(height).flatMap((y) => xs.map((x): [number, number] => [x, y]));
}

export interface WorkSize { width: number; height: number; scale: number }

/** Working size for a frame of w x h display pixels: the longer side at most `side`, never enlarged. */
export function workSize(w: number, h: number, side = WORK_SIDE): WorkSize {
  const scale = Math.min(1, side / Math.max(w, h));
  return { width: Math.round(w * scale), height: Math.round(h * scale), scale };
}
