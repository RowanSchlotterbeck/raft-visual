import type { CSSProperties } from 'react';
import type { LogEntry, NodeId, NodeSnapshot } from '../engine';
import { CARD_H, CARD_W, type Point } from '../sim/layout';
import { termColor } from './colors';
import { CrownIcon, PowerIcon, TimerIcon } from './icons';
import './NodeCard.css';

export interface NodeCardProps {
  node: NodeSnapshot;
  center: Point;
  majority: number;
  heartbeatInterval: number;
  /** 'A' / 'B' while the network is split, else null. */
  side: 'A' | 'B' | null;
  highlighted: boolean;
  /** seq of this node's latest became_leader event still being celebrated. */
  leaderFlash: number | null;
  onKill: (id: NodeId) => void;
  onRevive: (id: NodeId) => void;
  onForceTimeout: (id: NodeId) => void;
}

const MAX_CELLS = 12;
const MAX_KEYS = 4;

export function NodeCard(props: NodeCardProps) {
  const { node, center, side, highlighted, leaderFlash } = props;
  const roleLabel = !node.alive ? 'Down' : node.role === 'leader' ? 'Leader' : node.role === 'candidate' ? 'Candidate' : 'Follower';

  return (
    <article
      className="node"
      data-role={node.alive ? node.role : 'dead'}
      data-side={side ?? undefined}
      data-highlight={highlighted || undefined}
      style={{ left: center.x, top: center.y, width: CARD_W, height: CARD_H }}
      aria-label={`S${node.id}, ${roleLabel}, term ${node.currentTerm}`}
    >
      {leaderFlash !== null && <span key={leaderFlash} className="node__burst" aria-hidden />}

      <header className="node__head">
        <span className="node__id">S{node.id}</span>
        <span className="node__role">
          {node.alive && node.role === 'leader' && <CrownIcon />}
          {roleLabel}
        </span>
        {side && <span className={`node__side node__side--${side}`}>side {side}</span>}
        <span className="node__term" title="currentTerm">
          <span className="eyebrow">term</span>
          <b key={node.currentTerm} className="mono">
            {node.currentTerm}
          </b>
        </span>
      </header>

      <Timer node={node} heartbeatInterval={props.heartbeatInterval} />
      <Meta node={node} majority={props.majority} />
      <LogStrip node={node} />
      <Store store={node.store} alive={node.alive} />

      <footer className="node__actions">
        {node.alive ? (
          <button className="btn btn--small" onClick={() => props.onKill(node.id)} title="Crash this server">
            <PowerIcon /> Kill
          </button>
        ) : (
          <button className="btn btn--small" onClick={() => props.onRevive(node.id)} title="Restart from persistent state">
            <PowerIcon /> Revive
          </button>
        )}
        <button
          className="btn btn--small"
          onClick={() => props.onForceTimeout(node.id)}
          disabled={!node.alive || node.role === 'leader'}
          title="Make this node's election timer fire on the next tick"
        >
          <TimerIcon /> Time out
        </button>
      </footer>
    </article>
  );
}

/** Election countdown for followers/candidates; heartbeat cadence for the leader. */
function Timer({ node, heartbeatInterval }: { node: NodeSnapshot; heartbeatInterval: number }) {
  if (!node.alive) {
    return (
      <div className="timer is-off">
        <div className="timer__label">
          <span>crashed: no timers</span>
        </div>
        <div className="timer__track" />
      </div>
    );
  }
  const isLeader = node.role === 'leader';
  const elapsed = isLeader ? node.heartbeatElapsed : node.electionElapsed;
  const total = isLeader ? heartbeatInterval : node.electionTimeout;
  const frac = Math.min(1, elapsed / total);
  const hot = !isLeader && frac >= 0.75;
  return (
    <div className={`timer${isLeader ? ' is-leader' : ''}${hot ? ' is-hot' : ''}`}>
      <div className="timer__label">
        <span>{isLeader ? 'next heartbeat' : 'election timeout'}</span>
        <span className="mono">
          {elapsed}/{total}
        </span>
      </div>
      <div className="timer__track">
        <div className="timer__fill" style={{ width: `${frac * 100}%` }} />
      </div>
    </div>
  );
}

/** One role-specific line: who I follow / my votes / my followers' progress. */
function Meta({ node, majority }: { node: NodeSnapshot; majority: number }) {
  if (node.alive && node.role === 'leader' && node.matchIndex) {
    return (
      <div className="node__meta" title="matchIndex: highest entry known replicated on each follower">
        <span className="eyebrow">match</span>
        {Object.entries(node.matchIndex).map(([peer, m]) => (
          <span key={peer} className="mono">
            S{peer}:{m}
          </span>
        ))}
      </div>
    );
  }
  if (node.alive && node.role === 'candidate') {
    return (
      <div className="node__meta">
        <span className="eyebrow">votes</span>
        <b className="mono">
          {node.votesReceived.length}/{majority}
        </b>
        <span className="mono muted">needed · from {node.votesReceived.map((v) => `S${v}`).join(' ')}</span>
      </div>
    );
  }
  return (
    <div className="node__meta">
      <span className="eyebrow">leader</span>
      <span className="mono">{node.leaderId ? `S${node.leaderId}` : '—'}</span>
      <span className="eyebrow">voted</span>
      <span className="mono">{node.votedFor ? `S${node.votedFor}` : '—'}</span>
    </div>
  );
}

/**
 * The log, one cell per entry, labeled with its term. Filled cells are
 * committed; outlined ones are not yet. A bar marks the commit point and a
 * caret marks lastApplied. Only the newest MAX_CELLS entries are drawn.
 */
function LogStrip({ node }: { node: NodeSnapshot }) {
  const visible = node.log.slice(-MAX_CELLS);
  const hidden = node.log.length - visible.length;
  return (
    <div className="node__log">
      <div className="node__log-head">
        <span className="eyebrow">log</span>
        <span className="mono muted">
          commit <b>{node.commitIndex}</b> · applied <b>{node.lastApplied}</b>
        </span>
      </div>
      <div className="log">
        {hidden > 0 && <span className="log__more mono">+{hidden}</span>}
        {node.log.length === 0 && <span className="log__empty">empty</span>}
        {visible.map((entry) => (
          <LogCell key={`${entry.index}:${entry.term}`} entry={entry} node={node} />
        ))}
      </div>
    </div>
  );
}

function LogCell({ entry, node }: { entry: LogEntry; node: NodeSnapshot }) {
  const committed = entry.index <= node.commitIndex;
  const cmd = entry.command.op === 'set' ? `${entry.command.key}=${entry.command.value}` : entry.command.op;
  const classes = ['cell'];
  if (committed) classes.push('is-committed');
  if (entry.index === node.lastApplied) classes.push('is-applied-head');
  if (entry.index === node.commitIndex) classes.push('is-commit-edge');
  if (entry.command.op === 'noop') classes.push('is-noop');
  return (
    <span
      className={classes.join(' ')}
      style={{ '--c': termColor(entry.term) } as CSSProperties}
      title={`index ${entry.index} · term ${entry.term} · ${cmd}${committed ? ' · committed' : ' · not committed'}`}
    >
      {entry.term}
    </span>
  );
}

function Store({ store, alive }: { store: Readonly<Record<string, string>>; alive: boolean }) {
  const entries = Object.entries(store).sort(([a], [b]) => a.localeCompare(b));
  return (
    <div className="node__store">
      <span className="eyebrow">store</span>
      {entries.length === 0 && <span className="muted">{alive ? 'empty' : 'lost on crash'}</span>}
      {entries.slice(0, MAX_KEYS).map(([k, v]) => (
        <span key={`${k}=${v}`} className="kv mono">
          {k}={v}
        </span>
      ))}
      {entries.length > MAX_KEYS && <span className="muted">+{entries.length - MAX_KEYS}</span>}
    </div>
  );
}
