import type { CSSProperties, ReactNode } from 'react';
import { termColor } from './colors';
import './Legend.css';

/** How to read the stage: message shapes and log cells. */
export function Legend() {
  return (
    <div className="legend" aria-label="Legend">
      <span className="eyebrow">messages</span>
      <Item label="RequestVote">
        <rect className="msg msg--rv" transform="translate(9 9) rotate(45)" x={-5} y={-5} width={10} height={10} rx={2} />
      </Item>
      <Item label="AppendEntries (n entries)">
        <circle className="msg msg--ae" cx={9} cy={9} r={7.5} />
        <text className="msg__count" x={9} y={9} dy="0.35em">
          n
        </text>
      </Item>
      <Item label="heartbeat">
        <circle className="msg msg--heartbeat" cx={9} cy={9} r={5} />
      </Item>
      <Item label="reply: yes / no">
        <circle className="msg msg--reply is-yes" cx={5} cy={9} r={4} />
        <circle className="msg msg--reply is-no" cx={14} cy={9} r={4} />
      </Item>
      <Item label="lost">
        <g className="cut-mark" transform="translate(9 9)">
          <circle r={7} />
          <path d="M-3 -3 L3 3 M3 -3 L-3 3" />
        </g>
      </Item>

      <span className="legend__sep" />
      <span className="eyebrow">log</span>
      <span className="legend__item">
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
        number &amp; color = term · filled = committed · outlined = not yet · bar = commit point · ▲ = last applied
      </span>
    </div>
  );
}

function Item({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span className="legend__item">
      <svg width={20} height={18} viewBox="0 0 20 18" aria-hidden>
        {children}
      </svg>
      {label}
    </span>
  );
}
