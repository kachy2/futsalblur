/**
 * Score thresholds and the other fixed settings of the detector.
 * A box is blurred when the detector's confidence (0-1) is at or above the threshold. Lower thresholds blur more: fewer faces are
 * missed, and more things that are not heads get blurred. Figures measured on 4,056 frames of amateur futsal recordings with the
 * default blur (oval, each box grown by 15%): faces = the 4,395 faces an independent face detector found that lie at least half
 * inside the blur; blurred = share of the frame under the blur.
 *   0.05  faces 100.00%, blurred 1.47% of the frame
 *   0.1   faces 99.82%, blurred 1.08%
 *   0.2   faces 99.80%, blurred 0.75%; about 1.3 blurred areas per frame are not heads (torsos, hands, poles; eye check)
 *   0.275 faces 99.73%, blurred 0.50% (recommended; 10 of the 12 faces left were a face printed on a poster, 1 a false find of
 *         the face detector); about 0.5 blurred areas per frame are not heads
 *   0.3   faces 99.64%, blurred 0.43%
 */
export interface Preset { id: 'max' | 'faces' | 'more' | 'balanced' | 'least'; threshold: number }

export const PRESETS: Preset[] = [
  { id: 'max', threshold: 0.05 },
  { id: 'faces', threshold: 0.1 },
  { id: 'more', threshold: 0.2 },
  { id: 'balanced', threshold: 0.275 },
  { id: 'least', threshold: 0.3 },
];

export const DEFAULT_THRESHOLD = 0.275;
/** detections at or above this score are kept from the analysis, so every preset works without detecting again */
export const MIN_SCORE = 0.05;
/** the detector looks at every 3rd frame; the frames in between get the boxes of the tracks (interpolated) */
export const STRIDE = 3;
/** a head the detector misses in one detection frame keeps its box */
export const KEEP = 1;

/** the threshold as shown: two decimals, three when the value needs them (0.275) */
export function formatThreshold(t: number): string {
  return Math.abs(t * 100 - Math.round(t * 100)) < 1e-6 ? t.toFixed(2) : t.toFixed(3);
}
