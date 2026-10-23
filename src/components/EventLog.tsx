import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { formatEvent, type NodeId, type RaftEvent } from '../engine';
import { useCluster } from '../sim/hooks';
import './Sidebar.css';

/** Rows rendered at most; older ones remain in the buffer but aren't drawn. */
const MAX_ROWS = 300;

type Category = 'election' | 'leader' | 'log' | 'commit' | 'network' | 'fault' | 'client';

function category(e: RaftEvent): Category {
  switch (e.type) {
    case 'election_timeout':
    case 'became_candidate':
    case 'vote_granted':
    case 'vote_denied':
    case 'vote_received':
    case 'term_advanced':
    case 'election_timeout_forced':
      return 'election';
    case 'became_leader':
    case 'became_follower':
      return 'leader';
    case 'commit_advanced':
    case 'applied':
      return 'commit';
    case 'message_sent':
    case 'message_delivered':
    case 'message_dropped':
      return 'network';
    case 'node_killed':
    case 'node_revived':
    case 'partition_changed':
    case 'partition_healed':
      return 'fault';
    case 'client_request_received':
    case 'client_request_rejected':
    case 'client_replied':
    case 'client_request_abandoned':
      return 'client';
    default:
      return 'log';
  }
}

/** Every node an event mentions, for highlighting cards on hover. */
function involvedNodes(e: RaftEvent): NodeId[] {
  const ids = new Set<NodeId>();
  const fields = e as unknown as Record<string, unknown>;
  for (const key of ['node', 'candidate', 'leader', 'peer', 'from', 'via']) {
    if (typeof fields[key] === 'number') ids.add(fields[key] as number);
  }
  if ('message' in e) {
    ids.add(e.message.from);
    ids.add(e.message.to);
  }
  return [...ids];
}

/** Scrolling, human-readable feed of engine events (newest at the bottom). */
export function EventLog() {
  const { view, setHighlighted } = useCluster();
  const [showNetwork, setShowNetwork] = useState(false);
  const [showHeartbeats, setShowHeartbeats] = useState(false);

  const rows = useMemo(() => {
    const filtered = view.log.filter((e) => {
      if (!showNetwork && category(e) === 'network') return false;
      // A follower acking an empty AppendEntries happens every heartbeat.
      if (!showHeartbeats && e.type === 'append_accepted' && e.entryCount === 0) return false;
      return true;
    });
    return filtered.slice(-MAX_ROWS);
  }, [view.log, showNetwork, showHeartbeats]);

  // Follow the bottom unless the reader has scrolled up.
  const listRef = useRef<HTMLOListElement>(null);
  const pinned = useRef(true);
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [rows]);

  return (
    <section className="panel panel--log">
      <header className="panel__head">
        <h2>Event log</h2>
        <label className="toggle">
          <input type="checkbox" checked={showNetwork} onChange={(e) => setShowNetwork(e.target.checked)} />
          messages
        </label>
        <label className="toggle">
          <input type="checkbox" checked={showHeartbeats} onChange={(e) => setShowHeartbeats(e.target.checked)} />
          heartbeat acks
        </label>
      </header>
      <ol
        ref={listRef}
        className="events mono"
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
        onMouseLeave={() => setHighlighted([])}
      >
        {rows.length === 0 && <li className="events__empty">Press Play or Step to start the clock.</li>}
        {rows.map((e) => (
          <li key={e.seq} data-cat={category(e)} onMouseEnter={() => setHighlighted(involvedNodes(e))}>
            {formatEvent(e)}
          </li>
        ))}
      </ol>
    </section>
  );
}
