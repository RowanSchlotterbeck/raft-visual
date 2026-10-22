/**
 * Deterministic pseudo-random numbers.
 *
 * The engine never calls Math.random(). All randomness (election timeouts,
 * variable message delays) is drawn from one of these, created from the
 * cluster's seed. Same seed + same sequence of calls = same numbers, which is
 * what makes runs replayable and tests deterministic.
 */
export interface Rng {
  /** A float in [0, 1). */
  next(): number;
  /** An integer in [min, max], inclusive at both ends. */
  int(min: number, max: number): number;
}

/**
 * mulberry32: a tiny, fast 32-bit generator. Plenty for a simulation, and
 * not cryptographic.
 */
export function createRng(seed: number): Rng {
  let state = seed >>> 0;

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  return {
    next,
    int(min, max) {
      return min + Math.floor(next() * (max - min + 1));
    },
  };
}
