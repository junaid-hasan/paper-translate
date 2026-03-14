import { describe, expect, it } from 'vitest';
import { IMAGE_CAPABLE_MODELS, MODEL_LABELS } from '../shared/types';

describe('model configuration', () => {
  it('marks Qwen 3 VL 32B as image-capable', () => {
    expect(IMAGE_CAPABLE_MODELS).toContain('qwen/qwen3-vl-32b-instruct');
  });

  it('shows paid label for Qwen 3 VL 32B', () => {
    expect(MODEL_LABELS['qwen/qwen3-vl-32b-instruct']).toContain('(paid)');
  });
});
