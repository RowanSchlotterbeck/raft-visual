/**
 * Runtime checks for the five safety properties Raft guarantees (Figure 3).
 *
 * Feed it each tick's events and the snapshot after that tick; it records any
 * violation it sees. Tests use it to prove the engine is safe under chaos;
 * the UI can show it as a live "all properties hold" indicator.
 */
import type { RaftEvent } from './events';
import type { ClusterSnapshot, LogEntry, NodeId } from './types';

export type SafetyProperty =
  | 'election_safety'
  | 'leader_append_only'
  | 'log_matching'
  | 'leader_completeness'
  | 'state_machine_safety';

export interface SafetyViolation {
  readonly time: number;
  readonly property: SafetyProperty;
  readonly detail: string;
}

export class SafetyMonitor {
  readonly violations: SafetyViolation[] = [];

  /** Election Safety: term -> the one node that won it. */
  private leaderOfTerm = new Map<number, NodeId>();
  /** Committed entries: index -> { term of the entry, term in which a leader committed it }. */
  private committed = new Map<number, { entryTerm: number; committedInTerm: number }>();
  /** The last log seen for each (leader, term), for Leader Append-Only. */
  private leaderLogs = new Map<NodeId, { term: number; log: readonly LogEntry[] }>();

  get ok(): boolean {
    return this.violations.length === 0;
  }

  observe(events: readonly RaftEvent[], state: ClusterSnapshot): void {
    const fail = (property: SafetyProperty, detail: string) =>
      this.violations.push({ time: state.time, property, detail });

    // Election Safety: at most one leader can be elected in a given term.
    for (const e of events) {
      if (e.type !== 'became_leader') continue;
      const existing = this.leaderOfTerm.get(e.term);
      if (existing !== undefined && existing !== e.node) {
        fail('election_safety', `S${existing} and S${e.node} both won term ${e.term}`);
      }
      this.leaderOfTerm.set(e.term, e.node);
    }

    // Record newly committed entries, noting which leader term committed them.
    for (const e of events) {
      if (e.type !== 'commit_advanced') continue;
      const node = state.nodes[e.node - 1];
      for (let i = e.oldCommitIndex + 1; i <= e.newCommitIndex; i++) {
        const entry = node.log[i - 1];
        if (!entry) continue; // node may have been truncated later in the tick
        if (!this.committed.has(i)) this.committed.set(i, { entryTerm: entry.term, committedInTerm: e.term });
      }
    }

    // State Machine Safety: if a server has applied an entry at an index, no
    // other server ever applies a different entry at that index. We check
    // the stronger "committed prefixes agree" on every node.
    for (const node of state.nodes) {
      for (let i = 1; i <= node.commitIndex; i++) {
        const known = this.committed.get(i);
        const entry = node.log[i - 1];
        if (known && entry && known.entryTerm !== entry.term) {
          fail(
            'state_machine_safety',
            `S${node.id} committed index ${i} with term ${entry.term}, but term ${known.entryTerm} was committed there`,
          );
        }
      }
    }

    for (const node of state.nodes) {
      if (!node.alive || node.role !== 'leader') continue;

      // Leader Append-Only: a leader never overwrites or deletes its log.
      const prev = this.leaderLogs.get(node.id);
      if (prev && prev.term === node.currentTerm && !isPrefix(prev.log, node.log)) {
        fail('leader_append_only', `S${node.id} rewrote its log while leading term ${node.currentTerm}`);
      }
      this.leaderLogs.set(node.id, { term: node.currentTerm, log: node.log });

      // Leader Completeness: an entry committed in some term is present in
      // the logs of the leaders of all higher terms.
      for (const [index, c] of this.committed) {
        if (c.committedInTerm >= node.currentTerm) continue;
        if (node.log[index - 1]?.term !== c.entryTerm) {
          fail(
            'leader_completeness',
            `S${node.id} leads term ${node.currentTerm} but lacks entry ${index} (term ${c.entryTerm}) committed in term ${c.committedInTerm}`,
          );
        }
      }
    }

    // Log Matching: if two logs contain an entry with the same index and
    // term, the logs are identical in all entries up through that index.
    const logs = state.nodes.map((n) => n.log);
    for (let a = 0; a < logs.length; a++) {
      for (let b = a + 1; b < logs.length; b++) {
        const problem = logMatchingProblem(logs[a], logs[b]);
        if (problem !== null) fail('log_matching', `S${a + 1} vs S${b + 1}: ${problem}`);
      }
    }
  }
}

function isPrefix(prefix: readonly LogEntry[], log: readonly LogEntry[]): boolean {
  return prefix.length <= log.length && prefix.every((e, i) => e.term === log[i].term && e.index === log[i].index);
}

/** Returns a description of a Log Matching violation, or null if the property holds. */
function logMatchingProblem(x: readonly LogEntry[], y: readonly LogEntry[]): string | null {
  // Find the highest index where both logs have an entry with the same term...
  let agreeAt = Math.min(x.length, y.length);
  while (agreeAt > 0 && x[agreeAt - 1].term !== y[agreeAt - 1].term) agreeAt--;
  // ...then everything up to it must be identical.
  for (let i = 0; i < agreeAt; i++) {
    // Replicated entries are shared immutable objects, so `===` is the fast path.
    const same =
      x[i] === y[i] || (x[i].term === y[i].term && JSON.stringify(x[i].command) === JSON.stringify(y[i].command));
    if (!same) return `agree at index ${agreeAt} but differ at index ${i + 1}`;
  }
  return null;
}
