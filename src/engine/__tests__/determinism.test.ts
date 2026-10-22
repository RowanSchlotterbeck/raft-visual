import { describe as suite, expect, it } from 'vitest';
import { createCluster, createRng, type RaftEvent } from '../index';
import { converged, Harness, set } from './helpers';

/** A scripted scenario touching every API: writes, kill, partition, heal, revive. */
function scriptedRun(seed: number): { events: RaftEvent[]; finalState: string } {
  const c = createCluster({ nodeCount: 5, seed, msgDelay: [1, 3] });
  c.tick(150);
  c.clientWrite(set('a', '1'));
  c.tick(40);
  const leader = c.getLeader()!;
  c.killNode(leader);
  c.tick(120);
  c.clientWrite(set('b', '2'));
  c.partition([[1, 2]]);
  c.tick(200);
  c.healPartition();
  c.reviveNode(leader);
  c.tick(300);
  return { events: c.getEvents(), finalState: JSON.stringify(c.getState()) };
}

suite('determinism', () => {
  it('same seed + same inputs => identical event stream and final state', () => {
    const a = scriptedRun(42);
    const b = scriptedRun(42);
    expect(a.events.length).toBeGreaterThan(500);
    expect(JSON.stringify(a.events)).toBe(JSON.stringify(b.events));
    expect(a.finalState).toBe(b.finalState);
  });

  it('a different seed gives a different run', () => {
    expect(JSON.stringify(scriptedRun(1).events)).not.toBe(JSON.stringify(scriptedRun(2).events));
  });

  it('tick(n) is equivalent to n calls of tick()', () => {
    const a = createCluster({ seed: 3 });
    const b = createCluster({ seed: 3 });
    const fromBatch = a.tick(200);
    const fromSingles = Array.from({ length: 200 }, () => b.tick()).flat();
    expect(fromBatch).toEqual(fromSingles);
  });

  it('getState() is a detached snapshot', () => {
    const c = createCluster({ seed: 3 });
    c.tick(100);
    const snap = c.getState();
    const before = JSON.stringify(snap);
    c.tick(100);
    c.clientWrite(set('x', 'y'));
    c.tick(20);
    expect(JSON.stringify(snap)).toBe(before);
  });
});

suite('chaos: random crashes, partitions and writes never violate safety', () => {
  it.each([
    [3, 1],
    [5, 2],
    [7, 3],
    [5, 4],
    [3, 5],
    [5, 6],
    [7, 7],
    [5, 8],
  ])('%i nodes, seed %i', (nodeCount, seed) => {
    const h = new Harness({ nodeCount, seed, msgDelay: [1, 4], timeoutRange: [15, 30], heartbeatInterval: 4 });
    const chaos = createRng(seed * 7919);
    const ids = Array.from({ length: nodeCount }, (_, i) => i + 1);
    const pick = <T>(xs: T[]): T => xs[chaos.int(0, xs.length - 1)];
    const requests: number[] = [];

    for (let t = 0; t < 4000; t++) {
      const roll = chaos.next();
      const alive = h.state.nodes.filter((n) => n.alive).map((n) => n.id);
      const dead = ids.filter((id) => !alive.includes(id));
      if (roll < 0.006 && alive.length > 0) h.cluster.killNode(pick(alive));
      else if (roll < 0.016 && dead.length > 0) h.cluster.reviveNode(pick(dead));
      else if (roll < 0.019) h.cluster.partition([ids.filter(() => chaos.next() < 0.5)]);
      else if (roll < 0.025) h.cluster.healPartition();
      else if (roll < 0.06) requests.push(h.cluster.clientWrite(set(`k${chaos.int(1, 5)}`, `v${t}`)).id);
      h.tick();
    }

    // Repair everything; the cluster must recover and converge.
    h.cluster.healPartition();
    ids.forEach((id) => h.cluster.reviveNode(id));
    h.runUntil((s) => converged(s) && s.nodes.some((n) => n.role === 'leader'), 3000, 'recovery');

    h.expectSafe();
    const final = h.state;
    const stores = new Set(final.nodes.map((n) => JSON.stringify(n.store)));
    expect(stores.size).toBe(1);

    // Every write the client was told succeeded is in the final log, where the leader put it.
    const committed = requests.map((id) => h.cluster.getClientRequest(id)!).filter((r) => r.status === 'committed');
    expect(committed.length).toBeGreaterThan(10);
    for (const r of committed) {
      const entry = final.nodes[0].log[r.index! - 1];
      expect(entry.term).toBe(r.term);
      expect(entry.command).toEqual(r.command);
    }
  });
});
