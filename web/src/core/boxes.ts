/** Head boxes: [x1, y1, x2, y2, score] in pixels. */
export type Box = [number, number, number, number, number];

/** Model outputs of one tile -> boxes with score >= minScore in tile pixels (the model gives sigmoid logits and cx, cy, w, h / 640). */
export function decodeTile(logits: Float32Array, boxes: Float32Array, queries: number, classes: number, minScore: number,
  input = 640): Box[] {
  const out: Box[] = [];
  for (let q = 0; q < queries; q++) {
    const p = 1 / (1 + Math.exp(-logits[q * classes]));
    if (p < minScore) continue;
    const cx = boxes[q * 4] * input;
    const cy = boxes[q * 4 + 1] * input;
    const w = boxes[q * 4 + 2] * input;
    const h = boxes[q * 4 + 3] * input;
    out.push([cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2, p]);
  }
  return out;
}

/** Greedy non-maximum suppression by score (stable for equal scores): a box overlapping a kept one by IoU > thr is dropped. */
export function nms(boxes: Box[], thr = 0.5): Box[] {
  const order = boxes.map((_, i) => i).sort((a, b) => boxes[b][4] - boxes[a][4] || a - b);
  const keep: Box[] = [];
  const dropped = new Uint8Array(boxes.length);
  for (let oi = 0; oi < order.length; oi++) {
    const i = order[oi];
    if (dropped[i]) continue;
    const a = boxes[i];
    keep.push(a);
    const areaA = (a[2] - a[0]) * (a[3] - a[1]);
    for (let oj = oi + 1; oj < order.length; oj++) {
      const j = order[oj];
      if (dropped[j]) continue;
      const b = boxes[j];
      const iw = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
      const ih = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
      const inter = iw * ih;
      const union = areaA + (b[2] - b[0]) * (b[3] - b[1]) - inter;
      if (union > 0 && inter / Math.max(union, 1e-9) > thr) dropped[j] = 1;
    }
  }
  return keep;
}
