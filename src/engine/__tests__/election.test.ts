import { describe as suite, expect, it } from 'vitest';
import { createRng } from '../index';
import { Harness, set, stableLeader } from './helpers';

suite('leader election', () => {
  it.each([1, 3, 5, 7])('cold start: exactly one leader emerges (%i nodes, 25 seeds)', (nodeCount) => {
    for (let seed = 1; seed <= 25; seed++) {
      const h = new Harness({ nodeCount, seed });
      // Bound: one max election timeout plus a few vote/heartbeat round trips,
      // with slack for occasional split votes.
      const ticks = h.runUntil((s) => stableLeader(s) !== null, 400, `leader (seed ${seed})`);
      expect(ticks).toBeLessThan(400);

      const s = h.state;
      const leader = stableLeader(s)!;
      expect(s.nodes.filter((n) => n.role === 'leader')).toHaveLength(1);
      // Everyone agrees on who leads and in which term.
      for (const n of s.nodes) {
        expect(n.currentTerm).toBe(s.nodes[leader - 1].currentTerm);
        expect(n.leaderId).toBe(leader);
      }
      h.expectSafe();
    }
  });

  it('a single node elects itself and commits on its own', () => {
    const h = new Harness({ nodeCount: 1 });
    expect(h.electLeader()).toBe(1);
    const req = h.cluster.clientWrite(set('x', '1'));
    h.runUntil(() => h.cluster.getClientRequest(req.id)!.status === 'committed', 5);
    expect(h.node(1).store).toEqual({ x: '1' });
  });

  it('never has two leaders in the same term across a long run with repeated failovers', () => {
    const h = new Harness({ nodeCount: 5, seed: 7, msgDelay: [1, 4] });
    const chaos = createRng(99);
    for (let round = 0; round < 40; round++) {
      const leader = h.electLeader(1000);
      h.tick(chaos.int(10, 60));
      h.cluster.killNode(leader);
      h.tick(chaos.int(0, 80));
      h.cluster.reviveNode(leader);
    }

    const winners = new Map<number, Set<number>>();
    for (const e of h.eventsOf('became_leader')) {
      if (!winners.has(e.term)) winners.set(e.term, new Set());
      winners.get(e.term)!.add(e.node);
    }
    expect(winners.size).toBeGreaterThanOrEqual(40);
    for (const nodes of winners.values()) expect(nodes.size).toBe(1);
    h.expectSafe();
  });

  it('heartbeats suppress elections while the leader is healthy', () => {
    const h = new Harness({ nodeCount: 5, seed: 3 });
    const leader = h.electLeader();
    const term = h.node(leader).currentTerm;

    const window = h.tick(2000);
    expect(h.eventsOf('election_timeout', window)).toEqual([]);
    expect(h.eventsOf('became_candidate', window)).toEqual([]);
    expect(stableLeader(h.state)).toBe(leader);
    for (const n of h.state.nodes) expect(n.currentTerm).toBe(term);
    h.expectSafe();
  });

  it('failover: killing the leader elects a new one in a higher term', () => {
    const h = new Harness({ nodeCount: 5, seed: 11 });
    const oldLeader = h.electLeader();
    const oldTerm = h.node(oldLeader).currentTerm;

    h.cluster.killNode(oldLeader);
    const newLeader = h.electLeader();
    expect(newLeader).not.toBe(oldLeader);
    const newTerm = h.node(newLeader).currentTerm;
    expect(newTerm).toBeGreaterThan(oldTerm);
    for (const n of h.state.nodes.filter((n) => n.alive)) {
      expect(n.currentTerm).toBe(newTerm);
      expect(n.leaderId).toBe(newLeader);
    }

    // The old leader comes back as a follower and learns the new term.
    h.cluster.reviveNode(oldLeader);
    h.runUntil((s) => s.nodes[oldLeader - 1].leaderId === newLeader, 100, 'old leader to rejoin');
    expect(h.node(oldLeader).role).toBe('follower');
    expect(h.node(oldLeader).currentTerm).toBe(newTerm);
    h.expectSafe();
  });

  it('split vote: no one wins the term, and randomized timeouts break the tie later', () => {
    const h = new Harness({ nodeCount: 3, seed: 5 });
    // All three time out on the same tick: each votes for itself and refuses the others.
    for (const id of [1, 2, 3]) h.cluster.forceElectionTimeout(id);
    h.tick();
    expect(h.state.nodes.map((n) => [n.role, n.currentTerm])).toEqual([
      ['candidate', 1],
      ['candidate', 1],
      ['candidate', 1],
    ]);

    const leader = h.electLeader();
    const denials = h.eventsOf('vote_denied').filter((e) => e.term === 1);
    expect(denials).toHaveLength(6); // every candidate refused both others
    expect(denials.every((e) => e.reason === 'already_voted')).toBe(true);
    expect(h.eventsOf('became_leader').some((e) => e.term === 1)).toBe(false);
    expect(h.node(leader).currentTerm).toBeGreaterThanOrEqual(2);
    h.expectSafe();
  });

  it('without randomized timeouts, split votes repeat forever (why Raft randomizes)', () => {
    // Every node gets the same timeout, so they stay in lockstep.
    const h = new Harness({ nodeCount: 3, timeoutRange: [10, 10], msgDelay: 1 });
    h.tick(500);
    expect(h.eventsOf('became_leader')).toEqual([]);
    expect(h.node(1).currentTerm).toBe(50); // one failed election every 10 ticks
    h.expectSafe();
  });

  it('granting a vote resets the voter’s election timer', () => {
    const h = new Harness({ nodeCount: 3, timeoutRange: [50, 60], msgDelay: 2 });
    h.tick(40); // everyone is 40 ticks into their countdown
    h.cluster.forceElectionTimeout(1);
    const tickEvents = (() => {
      for (;;) {
        const evs = h.tick();
        if (h.eventsOf('vote_granted', evs).length > 0) return evs;
      }
    })();
    const voters = h.eventsOf('vote_granted', tickEvents).map((e) => e.node);
    expect(voters).toEqual([2, 3]);
    // Reset to 0 on granting, then this tick's timer step counted 1.
    for (const id of voters) expect(h.node(id).electionElapsed).toBe(1);
  });

  it('a candidate with a stale log cannot win (election restriction)', () => {
    const entry = (term: number) => ({ term, command: set('k', String(term)) });
    const h = new Harness({
      nodeCount: 3,
      timeoutRange: [50, 60],
      initialState: {
        1: { currentTerm: 1, log: [entry(1)] },
        2: { currentTerm: 2, log: [entry(1), entry(2)] },
        3: { currentTerm: 2, log: [entry(1), entry(2)] },
      },
    });
    h.cluster.forceElectionTimeout(1);
    h.tick(10);
    expect(h.eventsOf('vote_denied').map((e) => e.reason)).toEqual(['log_not_up_to_date', 'log_not_up_to_date']);
    expect(h.node(1).role).toBe('candidate');
    h.expectSafe();
  });
});
