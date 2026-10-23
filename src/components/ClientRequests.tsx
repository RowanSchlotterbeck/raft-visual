import type { Command } from '../engine';
import { useCluster } from '../sim/hooks';
import './Sidebar.css';

const SHOWN = 5;

const describeCommand = (c: Command) => (c.op === 'set' ? `${c.key}=${c.value}` : c.op);

/** The last few client writes and how (or whether) the client was answered. */
export function ClientRequests() {
  const { view, sim } = useCluster();
  const requests = view.snapshot.clientRequests.slice(-SHOWN).reverse();

  return (
    <section className="panel">
      <header className="panel__head">
        <h2>Client writes</h2>
      </header>
      {view.notice && (
        <p className={`notice is-${view.notice.tone}`} key={view.notice.id}>
          {view.notice.text}
          <button className="notice__close" onClick={() => sim.dismissNotice()} aria-label="Dismiss">
            ×
          </button>
        </p>
      )}
      {requests.length === 0 ? (
        <p className="panel__empty">No writes yet. Use “Send write” once there is a leader.</p>
      ) : (
        <ul className="requests">
          {requests.map((r) => (
            <li key={r.id}>
              <span className="mono">#{r.id}</span>
              <span className="mono requests__cmd">set {describeCommand(r.command)}</span>
              <span className="mono muted">
                {r.leader ? `S${r.leader} · idx ${r.index}` : '—'}
              </span>
              <span className={`status is-${r.status}`} title={r.reason ?? undefined}>
                {r.status === 'committed' && r.answeredAt !== null
                  ? `answered in ${r.answeredAt - r.submittedAt} ticks`
                  : r.status}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
