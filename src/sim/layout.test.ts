import { describe, expect, it } from 'vitest';
import { CARD_H, CARD_W, messagePath, stageLayout } from './layout';

describe('stage layout', () => {
  it.each([1, 2, 3, 4, 5, 6, 7])('%i cards never overlap and stay inside the stage', (n) => {
    const { width, height, centers } = stageLayout(n);
    const gap = 8;
    for (let i = 0; i < n; i++) {
      const c = centers[i];
      expect(c.x - CARD_W / 2).toBeGreaterThanOrEqual(0);
      expect(c.y - CARD_H / 2).toBeGreaterThanOrEqual(0);
      expect(c.x + CARD_W / 2).toBeLessThanOrEqual(width);
      expect(c.y + CARD_H / 2).toBeLessThanOrEqual(height);
      for (let j = i + 1; j < n; j++) {
        const d = centers[j];
        const separated = Math.abs(c.x - d.x) >= CARD_W + gap || Math.abs(c.y - d.y) >= CARD_H + gap;
        expect(separated, `S${i + 1} overlaps S${j + 1}`).toBe(true);
      }
    }
  });

  it('message paths start and end outside both cards, on opposite lanes per direction', () => {
    const { centers } = stageLayout(3);
    const [a, b] = centers;
    const there = messagePath(a, b);
    const back = messagePath(b, a);
    const outside = (p: { x: number; y: number }, c: { x: number; y: number }) =>
      Math.abs(p.x - c.x) > CARD_W / 2 || Math.abs(p.y - c.y) > CARD_H / 2;
    expect(outside(there.from, a) && outside(there.to, b)).toBe(true);
    // Reverse direction is offset to the other side of the center line.
    expect(there.from.x).not.toBeCloseTo(back.to.x);
  });
});
