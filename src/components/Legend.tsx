import type { CSSProperties, ReactNode } from 'react';
import { termColor } from './colors';
import './Legend.css';

/** How to read the stage: message shapes and log cells. */
export function Legend() {
  return (
    <div className="legend" aria-label="Legend">
      <div className="legend__group">
        <span className="eyebrow">messages</span>
        <Item label="RequestVote">
          <circle className="msg msg--rv" cx={9} cy={9} r={5.5} />
        </Item>
        <Item label="AppendEntries (heartbeat, or n entries)">
          <circle className="msg msg--ae" cx={9} cy={9} r={7.5} />
          <text className="msg__count" x={9} y={9} dy="0.35em">
            n
          </text>
        </Item>
        <Item label="reply: yes / no" width={30}>
          <circle className="msg msg--reply is-yes" cx={7} cy={9} r={5} />
          <circle className="msg msg--reply is-no" cx={22} cy={9} r={5} />
        </Item>
        <Item label="reply ring: vote / append" width={30}>
          <circle className="legend__ring legend__ring--vote" cx={7} cy={9} r={4.5} />
          <circle className="legend__ring legend__ring--append" cx={22} cy={9} r={4.5} />
        </Item>
        <Item label="lost">
          <g className="cut-mark" transform="translate(9 9)">
            <circle r={7} />
            <path d="M-3 -3 L3 3 M3 -3 L-3 3" />
          </g>
        </Item>
      </div>

      <div className="legend__group">
        {/* The label and its sample cells stay together when the row wraps. */}
        <span className="legend__keep">
          <span className="eyebrow">log</span>
          <span className="legend__cells">
            <span className="cell is-committed" style={{ '--c': termColor(1) } as CSSProperties}>
              1
            </span>
            <span className="cell is-committed is-commit-edge is-applied-head" style={{ '--c': termColor(2) } as CSSProperties}>
              2
            </span>
            <span className="cell" style={{ '--c': termColor(2) } as CSSProperties}>
              2
            </span>
          </span>
        </span>
        <span>
          number &amp; color = term · filled = committed · outlined = not yet · bar = commit point · ▲ = last applied
        </span>
      </div>
    </div>
  );
}

function Item({ label, children, width = 20 }: { label: string; children: ReactNode; width?: number }) {
  return (
    <span className="legend__item">
      <svg width={width} height={18} viewBox={`0 0 ${width} 18`} aria-hidden>
        {children}
      </svg>
      {label}
    </span>
  );
}
