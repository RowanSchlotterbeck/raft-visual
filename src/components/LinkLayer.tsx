import type { NodeId } from '../engine';
import { isCut, lerp, messagePath, type StageLayout } from '../sim/layout';

/**
 * The network's wiring, drawn under the cards: a faint line for every pair of
 * nodes, and, while the network is split, a red dashed line with a cut mark
 * for every link that crosses the partition.
 */
export function LinkLayer({ layout, sideB }: { layout: StageLayout; sideB: readonly NodeId[] }) {
  const n = layout.centers.length;
  const pairs: [number, number][] = [];
  for (let a = 1; a <= n; a++) for (let b = a + 1; b <= n; b++) pairs.push([a, b]);

  return (
    <svg className="layer layer--links" width={layout.width} height={layout.height} aria-hidden>
      {pairs.map(([a, b]) => {
        const { from, to } = messagePath(layout.centers[a - 1], layout.centers[b - 1], 0);
        const cut = isCut(sideB, a, b);
        const mid = lerp(from, to, 0.5);
        return (
          <g key={`${a}-${b}`} className={cut ? 'link is-cut' : 'link'}>
            <line x1={from.x} y1={from.y} x2={to.x} y2={to.y} />
            {cut && (
              <g transform={`translate(${mid.x} ${mid.y})`} className="cut-mark">
                <circle r="10" />
                <path d="M-4 -4 L4 4 M4 -4 L-4 4" />
              </g>
            )}
          </g>
        );
      })}
    </svg>
  );
}
