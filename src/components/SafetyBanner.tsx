import type { SafetyProperty } from '../engine';
import { useCluster } from '../sim/hooks';
import { AlertIcon, ShieldIcon } from './icons';
import './SafetyBanner.css';

const PROPERTIES: Record<SafetyProperty, string> = {
  election_safety: 'Election Safety',
  leader_append_only: 'Leader Append-Only',
  log_matching: 'Log Matching',
  leader_completeness: 'Leader Completeness',
  state_machine_safety: 'State Machine Safety',
};

/** Live result of the engine's SafetyMonitor, which checks every tick. */
export function SafetyBanner() {
  const { view } = useCluster();
  const { violations } = view;

  if (violations.length === 0) {
    return (
      <div className="safety is-ok" role="status">
        <ShieldIcon />
        <div>
          <strong>All 5 Raft safety guarantees hold</strong>
          <span className="safety__detail">
            checked after every tick · {Object.values(PROPERTIES).join(' · ')}
          </span>
        </div>
      </div>
    );
  }

  const first = violations[0];
  return (
    <div className="safety is-broken" role="alert">
      <AlertIcon />
      <div>
        <strong>
          {PROPERTIES[first.property]} violated at tick {first.time}
        </strong>
        <span className="safety__detail">
          {first.detail}
          {violations.length > 1 && ` (+${violations.length - 1} more)`}
        </span>
      </div>
    </div>
  );
}
