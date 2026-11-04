/**
 * Score thresholds and the other fixed settings of the detector.
 * A box is blurred when the detector's confidence (0-1) is at or above the threshold. Lower thresholds blur more: fewer faces are
 * missed, and more things that are not heads get blurred. Figures measured on 4,056 frames of amateur futsal recordings
 * (heads checked by eye on a random sample, and every face a face detector found):
 *   0.05  misses no face, about 33 non-head blurs per frame
 *   0.1   misses no face, about 9 non-head blurs per frame
 *   0.2   about 99.7% of faces, 97% of heads, about 1.4 non-head blurs per frame (recommended)
 *   0.3   about 98.4% of faces, 94% of heads, about 0.3 non-head blurs per frame
 */
export interface Preset { id: 'max' | 'faces' | 'balanced' | 'least'; threshold: number }

export const PRESETS: Preset[] = [
  { id: 'max', threshold: 0.05 },
  { id: 'faces', threshold: 0.1 },
  { id: 'balanced', threshold: 0.2 },
  { id: 'least', threshold: 0.3 },
];

export const DEFAULT_THRESHOLD = 0.2;
/** detections at or above this score are kept from the analysis, so every preset works without detecting again */
export const MIN_SCORE = 0.05;
/** the detector looks at every 3rd frame; the frames in between get the boxes of the tracks (interpolated) */
export const STRIDE = 3;
/** a head the detector misses in one detection frame keeps its box */
export const KEEP = 1;
