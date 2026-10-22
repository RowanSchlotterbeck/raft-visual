import { expect } from 'vitest';
import {
  createCluster,
  SafetyMonitor,
  type ClusterOptions,
  type ClusterSnapshot,
  type Command,
  type EventOf,
  type NodeId,
  type NodeSnapshot,
  type RaftCluster,
  type RaftEvent,
  type RaftEventType,
} from '../index';

/**
 * A cluster plus a safety monitor that checks every tick, and a record of
 * every event. All test scenarios go through this so that every test also
 * asserts the Figure 3 safety properties.
 */
export class Harness {
  readonly cluster: RaftCluster;
  readonly monitor = new SafetyMonitor();
  readonly events: RaftEvent[] = [];

  constructor(options: ClusterOptions = {}) {
    this.cluster = createCluster(options);
  }

  tick(n = 1): RaftEvent[] {
    const out: RaftEvent[] = [];
    for (let i = 0; i < n; i++) {
      this.cluster.tick();
      // Everything since the last tick: this tick's events plus any from
      // commands issued in between (kill, clientWrite, partition, ...).
      const fresh = this.cluster.getEvents(this.lastSeenSeq);
      this.lastSeenSeq = fresh.at(-1)?.seq ?? this.lastSeenSeq;
      this.events.push(...fresh);
      out.push(...fresh);
      this.monitor.observe(fresh, this.cluster.getState());
    }
    return out;
  }
  private lastSeenSeq = 0;

  /** Tick until `predicate` holds; returns ticks taken. Fails the test past `maxTicks`. */
  runUntil(predicate: (s: ClusterSnapshot) => boolean, maxTicks: number, what = 'condition'): number {
    for (let t = 1; t <= maxTicks; t++) {
      this.tick();
      if (predicate(this.state)) return t;
    }
    throw new Error(`timed out after ${maxTicks} ticks waiting for ${what}`);
  }

  /** Tick until there's a single agreed-upon leader; returns its id. */
  electLeader(maxTicks = 500): NodeId {
    this.runUntil((s) => stableLeader(s) !== null, maxTicks, 'a stable leader');
    return stableLeader(this.state)!;
  }

  get state(): ClusterSnapshot {
    return this.cluster.getState();
  }

  node(id: NodeId): NodeSnapshot {
    return this.state.nodes[id - 1];
  }

  eventsOf<T extends RaftEventType>(type: T, from: RaftEvent[] = this.events): EventOf<T>[] {
    return from.filter((e): e is EventOf<T> => e.type === type);
  }

  expectSafe(): void {
    expect(this.monitor.violations).toEqual([]);
  }
}

/**
 * The leader id if the live cluster has settled: exactly one live leader, and
 * every live node it can reach (same partition group) is on its term and
 * knows it's the leader. Null otherwise.
 */
export function stableLeader(s: ClusterSnapshot, among?: NodeId[]): NodeId | null {
  const live = s.nodes.filter((n) => n.alive && (!among || among.includes(n.id)));
  const leaders = live.filter((n) => n.role === 'leader');
  if (leaders.length !== 1) return null;
  const leader = leaders[0];
  const settled = live.every((n) => n.currentTerm === leader.currentTerm && n.leaderId === leader.id);
  return settled ? leader.id : null;
}

/** True when all listed live nodes have identical logs and have applied all of them. */
export function converged(s: ClusterSnapshot, ids?: NodeId[]): boolean {
  const nodes = s.nodes.filter((n) => n.alive && (!ids || ids.includes(n.id)));
  const ref = nodes[0];
  return nodes.every(
    (n) =>
      n.log.length === ref.log.length &&
      n.log.every((e, i) => e.term === ref.log[i].term) &&
      n.commitIndex === n.log.length &&
      n.lastApplied === n.log.length,
  );
}

export const set = (key: string, value: string): Command => ({ op: 'set', key, value });

/** A node's log as just its terms, e.g. [1, 1, 2]: easy to compare with the paper's figures. */
export const terms = (n: NodeSnapshot): number[] => n.log.map((e) => e.term);
