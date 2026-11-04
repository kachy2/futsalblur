/**
 * The web app's detector post-processing, tracking and blur geometry against the reference tool (Python) the blur was
 * measured with. tests/fixtures/parity.json holds random synthetic inputs and the reference outputs.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { nearestFrame } from '../../src/core/analysis';
import { blurArea, DEFAULT_BLUR } from '../../src/core/blur';
import { decodeTile, nms, type Box } from '../../src/core/boxes';
import { tiles, workSize } from '../../src/core/tiles';
import { buildTracks, type Rect } from '../../src/core/tracks';

const fx = JSON.parse(readFileSync(resolve(import.meta.dirname, '../fixtures/parity.json'), 'utf8'));

const close = (a: number[][], b: number[][], tol: number) => {
  expect(a.length).toBe(b.length);
  a.forEach((row, i) => row.forEach((v, k) => expect(Math.abs(v - b[i][k])).toBeLessThanOrEqual(tol)));
};

describe('tiles', () => {
  it('match the reference layout', () => {
    for (const c of fx.tiles) expect(tiles(c.w, c.h)).toEqual(c.origins);
  });
  it('work at 1080p detail for 4K and never enlarge', () => {
    expect(workSize(3840, 2160)).toEqual({ width: 1920, height: 1080, scale: 0.5 });
    expect(workSize(2160, 3840)).toEqual({ width: 1080, height: 1920, scale: 0.5 });
    expect(workSize(1280, 720)).toEqual({ width: 1280, height: 720, scale: 1 });
  });
});

describe('boxes', () => {
  it('decode like the reference', () => {
    const d = fx.decode;
    d.logits.forEach((lg: number[], k: number) => {
      const got = decodeTile(Float32Array.from(lg), Float32Array.from(d.boxes[k]), 300, 1, d.minScore);
      close(got, d.out[k], 2e-3);
    });
  });
  it('merge overlaps like the reference', () => {
    const got = nms(fx.nms.boxes as Box[]);
    close(got, fx.nms.out, 1e-9);
  });
});

describe('tracks', () => {
  it('give every frame the boxes of the reference', () => {
    const t = fx.tracks;
    const dets = t.detections.map((d: { frame: number; boxes: number[][] }) => ({ frame: d.frame, boxes: d.boxes.map((b) => [...b, 1]) }));
    const tr = buildTracks(dets, 0.5, t.stride, t.keep);
    t.at.forEach((want: Rect[], j: number) => {
      const got = tr.at(j);
      // the same boxes; the reference lists them in track order, which may differ: compare sorted
      const key = (r: number[]) => r.map((v) => v.toFixed(6)).join(',');
      expect(got.map(key).sort()).toEqual(want.map(key).sort());
    });
  });
  it('drop boxes under the threshold', () => {
    const tr = buildTracks([{ frame: 0, boxes: [[0, 0, 10, 10, 0.1], [50, 50, 60, 60, 0.3]] }], 0.2, 3, 1);
    expect(tr.at(0)).toEqual([[50, 50, 60, 60]]);
  });
});

describe('blur geometry', () => {
  it('grows and clips the box like the reference', () => {
    const { width, height, cases } = fx.blur;
    for (const c of cases) {
      const a = blurArea(c.box, { ...DEFAULT_BLUR, grow: c.grow }, width, height);
      if (c.region === null) {
        expect(a).toBeNull();
        continue;
      }
      expect([a!.x1, a!.y1, a!.x2, a!.y2]).toEqual(c.region);
      expect(a!.sigma).toBeCloseTo(c.sigma, 9);
      expect(a!.edge).toBeCloseTo(c.edge, 9);
    }
  });
});

describe('nearestFrame', () => {
  const ts = [0, 0.033, 0.067, 0.1, 0.133];
  it('finds the nearest timestamp in order and out of order', () => {
    expect(nearestFrame(ts, 0.07, 0)).toBe(2);
    expect(nearestFrame(ts, 0.12, 2)).toBe(4);
    expect(nearestFrame(ts, 0.01, 4)).toBe(0);
    expect(nearestFrame(ts, 0.045, 4)).toBe(1);
    expect(nearestFrame(ts, 9, 0)).toBe(4);
  });
});
