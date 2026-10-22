import { describe as suite, expect, it } from 'vitest';
import type { NodeId } from '../index';
import { converged, Harness, set, stableLeader } from './helpers';

/** Per term, the set of nodes that became leader (must always be size 1). */
function leadersByTerm(h: Harness): Map<number, Set<NodeId>> {
  const out = new Map<number, Set<NodeId>>();
  for (const e of h.eventsOf('became_leader')) {
    if (!out.has(e.term)) out.set(e.term, new Set());
    out.get(e.term)!.add(e.node);
  }
  return out;
}

suite('network partitions', () => {
  it('minority side elects no leader and commits nothing; majority keeps working; heal reconverges', () => {
    const h = new Harness({ nodeCount: 5, seed: 21 });
    const leader = h.electLeader();
    h.runUntil((s) => converged(s), 50);

    const minority = [1, 2, 3, 4, 5].filter((id) => id !== leader).slice(0, 2);
    const majority = [1, 2, 3, 4, 5].filter((id) => !minority.includes(id));
    const minorityCommit = minority.map((id) => h.node(id).commitIndex);
    h.cluster.partition([minority]);
    const start = h.events.length;

    const writes = [1, 2, 3].map((i) => h.cluster.clientWrite(set(`k${i}`, `v${i}`)));
    h.tick(300);
    const during = h.events.slice(start);

    // Majority: same leader, all writes committed.
    expect(stableLeader(h.state, majority)).toBe(leader);
    expect(writes.map((w) => h.cluster.getClientRequest(w.id)!.status)).toEqual(['committed', 'committed', 'committed']);

    // Minority: tried to elect (terms climbed), never succeeded, committed nothing.
    expect(h.eventsOf('became_candidate', during).some((e) => minority.includes(e.node))).toBe(true);
    expect(h.eventsOf('became_leader', during).filter((e) => minority.includes(e.node))).toEqual([]);
    expect(h.eventsOf('commit_advanced', during).filter((e) => minority.includes(e.node))).toEqual([]);
    expect(minority.map((id) => h.node(id).commitIndex)).toEqual(minorityCommit);
    for (const id of minority) expect(h.node(id).currentTerm).toBeGreaterThan(h.node(leader).currentTerm);
    // Their votes requests never crossed the partition.
    expect(
      h.eventsOf('message_dropped', during).some((e) => minority.includes(e.message.from) && e.reason === 'partitioned'),
    ).toBe(true);

    h.cluster.healPartition();
    const healStart = h.events.length;
    h.runUntil((s) => stableLeader(s) !== null && converged(s), 1000, 'cluster to reconverge');

    // The minority's higher term forces an election on heal, but with stale
    // logs they can't win it: the new leader comes from the old majority.
    const after = h.events.slice(healStart);
    for (const e of h.eventsOf('became_leader', after)) expect(majority).toContain(e.node);
    const finalLeader = stableLeader(h.state)!;
    for (const n of h.state.nodes) {
      expect(n.currentTerm).toBe(h.node(finalLeader).currentTerm);
      expect(n.store).toEqual({ k1: 'v1', k2: 'v2', k3: 'v3' });
    }
    for (const nodes of leadersByTerm(h).values()) expect(nodes.size).toBe(1);
    h.expectSafe();
  });

  it('a stale leader cut off in the minority cannot commit; on heal it steps down and its writes are discarded', () => {
    const h = new Harness({ nodeCount: 5, seed: 33 });
    const oldLeader = h.electLeader();
    const oldTerm = h.node(oldLeader).currentTerm;
    h.runUntil((s) => converged(s), 50);

    const buddy = oldLeader === 1 ? 2 : 1;
    const minority = [oldLeader, buddy];
    const majority = [1, 2, 3, 4, 5].filter((id) => !minority.includes(id));
    h.cluster.partition([minority]);
    const start = h.events.length;

    // A client still talking to the old leader: accepted, but can never commit.
    const staleWrite = h.cluster.clientWrite(set('who', 'stale'), { via: oldLeader });
    expect(staleWrite.status).toBe('pending');

    // The majority elects its own leader in a higher term.
    h.runUntil((s) => stableLeader(s, majority) !== null, 500, 'majority leader');
    const newLeader = stableLeader(h.state, majority)!;
    expect(h.node(newLeader).currentTerm).toBeGreaterThan(oldTerm);

    // Two nodes believe they lead, but never in the same term: no split brain.
    expect(h.node(oldLeader).role).toBe('leader');
    expect(h.node(oldLeader).currentTerm).toBe(oldTerm);

    // Default routing goes to the highest-term leader, which can commit.
    const goodWrite = h.cluster.clientWrite(set('who', 'majority'));
    h.runUntil(() => h.cluster.getClientRequest(goodWrite.id)!.status === 'committed', 50);
    h.tick(200);
    expect(h.cluster.getClientRequest(staleWrite.id)!.status).toBe('pending');
    expect(h.node(oldLeader).commitIndex).toBeLessThan(staleWrite.index!);
    // The buddy keeps hearing the old leader's heartbeats, so it never even campaigns.
    expect(h.eventsOf('became_candidate', h.events.slice(start)).some((e) => minority.includes(e.node))).toBe(false);

    h.cluster.healPartition();
    h.runUntil((s) => stableLeader(s) !== null && converged(s), 500, 'cluster to reconverge');

    expect(h.eventsOf('became_follower').find((e) => e.node === oldLeader)).toMatchObject({
      previousRole: 'leader',
      reason: 'higher_term',
    });
    // The uncommitted stale write was truncated from both minority logs.
    for (const id of minority) {
      const truncated = h.eventsOf('log_truncated').filter((e) => e.node === id).flatMap((e) => e.removed);
      expect(truncated.map((e) => e.command)).toContainEqual(set('who', 'stale'));
    }
    expect(h.cluster.getClientRequest(staleWrite.id)).toMatchObject({
      status: 'abandoned',
      reason: 'leader_stepped_down',
    });
    for (const n of h.state.nodes) expect(n.store).toEqual({ who: 'majority' });
    for (const nodes of leadersByTerm(h).values()) expect(nodes.size).toBe(1);
    h.expectSafe();
  });

  it('an isolated node with a stale log keeps raising its term but cannot win after heal', () => {
    const h = new Harness({ nodeCount: 3, seed: 9 });
    const leader = h.electLeader();
    const loner = leader === 3 ? 2 : 3;
    h.cluster.partition([[loner]]);
    // A committed write the loner misses makes its log stale.
    const req = h.cluster.clientWrite(set('a', '1'));
    h.tick(300);
    expect(h.cluster.getClientRequest(req.id)!.status).toBe('committed');
    expect(h.node(loner).role).toBe('candidate');
    expect(h.node(loner).currentTerm).toBeGreaterThan(h.node(leader).currentTerm + 3);

    h.cluster.healPartition();
    h.runUntil((s) => stableLeader(s) !== null && converged(s), 500);
    // Its high term forced a new election, but its log disqualified it.
    expect(stableLeader(h.state)).not.toBe(loner);
    expect(h.eventsOf('vote_denied').some((e) => e.candidate === loner && e.reason === 'log_not_up_to_date')).toBe(true);
    expect(h.node(loner).store).toEqual({ a: '1' });
    h.expectSafe();
  });

  it('supports asymmetric links via a predicate', () => {
    const h = new Harness({ nodeCount: 3, seed: 10 });
    const leader = h.electLeader();
    const victim = leader === 1 ? 2 : 1;
    // The victim can hear the leader, but its replies never get back.
    h.cluster.partition((from, to) => !(from === victim && to === leader));
    expect(h.state.partition).toEqual({ kind: 'custom' });

    const req = h.cluster.clientWrite(set('a', '1'));
    h.runUntil(() => h.cluster.getClientRequest(req.id)!.status === 'committed', 50); // via the third node
    h.tick(100);
    expect(h.node(h.cluster.getLeader()!).matchIndex![victim]).toBe(0);
    h.expectSafe();
  });
});
