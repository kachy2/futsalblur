/** The shipped defaults: the recommended preset is the default score, and the default blur is the one the model card's figures use. */
import { describe, expect, it } from 'vitest';
import { DEFAULT_BLUR } from '../../src/core/blur';
import { DEFAULT_THRESHOLD, PRESETS, formatThreshold } from '../../src/core/settings';

describe('defaults', () => {
  it('the balanced preset is the default score', () => {
    expect(PRESETS.find((p) => p.id === 'balanced')?.threshold).toBe(DEFAULT_THRESHOLD);
    expect(DEFAULT_THRESHOLD).toBe(0.275);
  });
  it('the default blur grows each box by 15%', () => {
    expect(DEFAULT_BLUR.grow).toBe(0.15);
  });
  it('presets rise with the score and stay inside the slider range', () => {
    const t = PRESETS.map((p) => p.threshold);
    expect([...t].sort((a, b) => a - b)).toEqual(t);
    expect(t.every((x) => x >= 0.05 && x <= 0.6)).toBe(true);
  });
  it('the score is shown with the digits it needs', () => {
    expect(formatThreshold(0.275)).toBe('0.275');
    expect(formatThreshold(0.3)).toBe('0.30');
    expect(formatThreshold(0.2)).toBe('0.20');
    expect(formatThreshold(0.28)).toBe('0.28');
  });
});
