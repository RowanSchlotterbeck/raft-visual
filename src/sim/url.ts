/**
 * The run's seed and size live in the URL (?seed=42&n=5) so a run can be
 * shared and reproduced. replaceState: changing runs doesn't add history entries.
 */
export function readRunFromUrl(): { seed: number; nodeCount: number } {
  const params = new URLSearchParams(window.location.search);
  const seed = Number(params.get('seed'));
  const n = Number(params.get('n'));
  return {
    seed: Number.isInteger(seed) && seed > 0 ? seed : 1,
    nodeCount: Number.isInteger(n) && n >= 1 && n <= 7 ? n : 3,
  };
}

export function writeRunToUrl(seed: number, nodeCount: number): void {
  const url = new URL(window.location.href);
  url.searchParams.set('seed', String(seed));
  url.searchParams.set('n', String(nodeCount));
  window.history.replaceState(window.history.state, '', url);
}
