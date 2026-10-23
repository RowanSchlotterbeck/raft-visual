/**
 * Tiny localStorage helpers. Storage can be missing or throw (private mode,
 * blocked site data), so every access is guarded: on failure we simply don't
 * remember, and the page still works.
 */
export function readFlag(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

export function writeFlag(key: string): void {
  try {
    window.localStorage.setItem(key, '1');
  } catch {
    // Not remembered this time; harmless.
  }
}

export const TUTORIAL_SEEN_KEY = 'raft-live:tutorial-seen';
