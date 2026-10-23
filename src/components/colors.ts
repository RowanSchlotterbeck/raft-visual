/** Log cells are colored by term, cycling through 8 hues defined in index.css. */
export function termColor(term: number): string {
  return `var(--term-${term % 8})`;
}
