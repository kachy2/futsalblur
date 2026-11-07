/**
 * The blur over each head box, as the reference tool measured it: a soft-edged ellipse filling the box grown by `grow` of its
 * size on every side, a Gaussian blur with a standard deviation of `strength` x the box size (at least 2 px), and an edge that
 * fades over 6% of the box size. Boxes are blurred one after another on the same picture, as in the reference tool.
 * `shape: 'rect'` blurs the whole grown box; `style: 'pixelate'` shows coarse blocks (a mosaic) instead of a blur.
 */
import type { Rect } from './tracks';

export interface BlurOptions {
  /** how much each box is grown on every side, as a share of its size (0.2: 1.4 x the box) */
  grow: number;
  /** blur standard deviation (or mosaic block size) as a share of the box size */
  strength: number;
  shape: 'ellipse' | 'rect';
  style: 'blur' | 'pixelate';
}

/** grow 0.15: the shipped model's boxes already reach from the top of the head to the chin; a little more keeps the whole face under the blur */
export const DEFAULT_BLUR: BlurOptions = { grow: 0.15, strength: 0.2, shape: 'ellipse', style: 'blur' };

export interface BlurArea {
  /** the grown box in whole pixels, clipped to the frame */
  x1: number; y1: number; x2: number; y2: number;
  /** ellipse centre and radii */
  cx: number; cy: number; rx: number; ry: number;
  sigma: number;
  /** standard deviation of the fading edge */
  edge: number;
}

export function blurArea(b: Rect, o: BlurOptions, width: number, height: number): BlurArea | null {
  const w = b[2] - b[0];
  const h = b[3] - b[1];
  if (w <= 1 || h <= 1) return null;
  const x1 = Math.max(0, Math.floor(b[0] - o.grow * w));
  const y1 = Math.max(0, Math.floor(b[1] - o.grow * h));
  const x2 = Math.min(width, Math.ceil(b[2] + o.grow * w));
  const y2 = Math.min(height, Math.ceil(b[3] + o.grow * h));
  if (x2 - x1 < 2 || y2 - y1 < 2) return null;
  const size = Math.max(w, h);
  return { x1, y1, x2, y2, cx: (b[0] + b[2]) / 2, cy: (b[1] + b[3]) / 2, rx: Math.max(1, (0.5 + o.grow) * w),
    ry: Math.max(1, (0.5 + o.grow) * h), sigma: Math.max(2, o.strength * size), edge: Math.max(1, 0.06 * size) };
}

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/**
 * Blur `boxes` on the picture already drawn in `ctx` (width x height). `scratch` is a reusable canvas for one area at a time.
 */
export function blurBoxes(ctx: Ctx2D, width: number, height: number, boxes: Rect[], o: BlurOptions, scratch: OffscreenCanvas): void {
  const src = ctx.canvas as CanvasImageSource;
  for (const b of boxes) {
    const a = blurArea(b, o, width, height);
    if (!a) continue;
    const rw = a.x2 - a.x1;
    const rh = a.y2 - a.y1;
    if (scratch.width < rw || scratch.height < rh) {
      scratch.width = Math.max(scratch.width, rw);
      scratch.height = Math.max(scratch.height, rh);
    }
    const s = scratch.getContext('2d')!;
    s.save();
    s.clearRect(0, 0, rw, rh);
    if (o.style === 'pixelate') {
      // blocks of about `sigma` pixels: shrink the area, then enlarge it without smoothing
      const bw = Math.max(1, Math.round(rw / a.sigma));
      const bh = Math.max(1, Math.round(rh / a.sigma));
      s.imageSmoothingEnabled = true;
      s.drawImage(src, a.x1, a.y1, rw, rh, 0, 0, bw, bh);
      s.imageSmoothingEnabled = false;
      s.drawImage(scratch, 0, 0, bw, bh, 0, 0, rw, rh);
    } else {
      // blur a margin around the area too, so the picture outside it (not transparency) feeds the edge of the blur
      const pad = Math.ceil(3 * a.sigma);
      s.filter = `blur(${a.sigma}px)`;
      s.drawImage(src, a.x1 - pad, a.y1 - pad, rw + 2 * pad, rh + 2 * pad, -pad, -pad, rw + 2 * pad, rh + 2 * pad);
      s.filter = 'none';
    }
    if (o.shape === 'ellipse') {
      // soft-edged ellipse: opaque inside, half at the ellipse, gone 2 edge-deviations outside it
      const k = a.edge / Math.min(a.rx, a.ry);
      const r = 1 + 2 * k;
      s.globalCompositeOperation = 'destination-in';
      s.translate(a.cx - a.x1, a.cy - a.y1);
      s.scale(a.rx, a.ry);
      const g = s.createRadialGradient(0, 0, 0, 0, 0, r);
      g.addColorStop(Math.max(0, 1 - 2 * k) / r, 'rgba(0,0,0,1)');
      g.addColorStop(1 / r, 'rgba(0,0,0,0.5)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      s.fillStyle = g;
      s.fillRect(-(a.cx - a.x1) / a.rx, -(a.cy - a.y1) / a.ry, rw / a.rx, rh / a.ry);
    }
    s.restore();
    ctx.drawImage(scratch, 0, 0, rw, rh, a.x1, a.y1, rw, rh);
  }
}
