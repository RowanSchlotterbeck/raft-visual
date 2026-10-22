import { describe as suite, expect, it } from 'vitest';
import type { NodePreset, RaftEvent } from '../index';
import { converged, Harness, set, terms } from './helpers';

/** Per node: applied indices must run 1, 2, 3, ... restarting only after a crash. */
function expectAppliedInOrderExactlyOnce(events: RaftEvent[], nodeCount: number): void {
  for (let id = 1; id <= nodeCount; id++) {
    let expected = 1;
    for (const e of events) {
      if (e.type === 'node_killed' && e.node === id) expected = 1; // state machine is rebuilt on restart
      if (e.type === 'applied' && e.node === id) expect(e.entry.index).toBe(expected++);
    }
  }
}

/** Build a preset log from a list of terms, like the paper's figures. */
const logOf = (...termList: number[]): NodePreset['log'] =>
  termList.map((term, i) => ({ term, command: set('x', `${i + 1}@t${term}`) }));

suite('log replication and commit', () => {
  it('commits after a majority stores the entry, answers the client, and applies everywhere in order', () => {
    const h = new Harness({ nodeCount: 3, seed: 2 });
    const leader = h.electLeader();
    h.runUntil((s) => converged(s), 50, 'no-op to commit');

    const reqs = [set('a', '1'), set('b', '2'), set('a', '3')].map((c) => h.cluster.clientWrite(c));
    expect(reqs.map((r) => r.status)).toEqual(['pending', 'pending', 'pending']);
    expect(reqs.map((r) => r.index)).toEqual([2, 3, 4]); // index 1 is the leader's no-op

    h.runUntil(() => reqs.every((r) => h.cluster.getClientRequest(r.id)!.status === 'committed'), 50);
    h.runUntil((s) => converged(s), 50, 'followers to apply');

    // Causality for the last write (index 4), as seen in the event stream:
    const seqOf = (pred: (e: RaftEvent) => boolean) => h.events.find(pred)!.seq;
    const received = seqOf((e) => e.type === 'client_request_received' && e.requestId === reqs[2].id);
    const firstAck = seqOf((e) => e.type === 'replication_progress' && e.node === leader && e.matchIndex >= 4);
    const committed = seqOf((e) => e.type === 'commit_advanced' && e.node === leader && e.newCommitIndex >= 4);
    const applied = seqOf((e) => e.type === 'applied' && e.node === leader && e.entry.index === 4);
    const replied = seqOf((e) => e.type === 'client_replied' && e.requestId === reqs[2].id);
    expect(received).toBeLessThan(firstAck);
    expect(firstAck).toBeLessThan(committed); // leader + 1 follower = majority of 3
    expect(committed).toBeLessThan(applied);
    expect(applied).toBeLessThan(replied);

    // Followers only commit after the leader does (they learn it via leaderCommit).
    const followerCommit = seqOf((e) => e.type === 'commit_advanced' && e.node !== leader && e.newCommitIndex >= 4);
    expect(followerCommit).toBeGreaterThan(committed);

    for (const n of h.state.nodes) expect(n.store).toEqual({ a: '3', b: '2' });
    expectAppliedInOrderExactlyOnce(h.events, 3);
    h.expectSafe();
  });

  it('does not commit without a majority, then commits once one follower returns', () => {
    const h = new Harness({ nodeCount: 3, seed: 4 });
    const leader = h.electLeader();
    h.runUntil((s) => converged(s), 50);
    const followers = [1, 2, 3].filter((id) => id !== leader);
    followers.forEach((id) => h.cluster.killNode(id));

    const req = h.cluster.clientWrite(set('k', 'v'));
    h.tick(200);
    expect(h.cluster.getClientRequest(req.id)!.status).toBe('pending');
    expect(h.node(leader).commitIndex).toBeLessThan(req.index!);
    expect(h.node(leader).role).toBe('leader'); // a leader alone keeps leading (no check-quorum in basic Raft)

    h.cluster.reviveNode(followers[0]);
    h.runUntil(() => h.cluster.getClientRequest(req.id)!.status === 'committed', 50);
    expect(h.node(leader).store).toEqual({ k: 'v' });
    h.expectSafe();
  });

  it('rejects writes when there is no leader, and redirects writes sent to a follower', () => {
    const h = new Harness({ nodeCount: 3, seed: 6 });
    expect(h.cluster.clientWrite(set('a', '1'))).toMatchObject({ status: 'rejected', reason: 'no_leader' });

    const leader = h.electLeader();
    const follower = leader === 1 ? 2 : 1;
    expect(h.cluster.clientWrite(set('a', '1'), { via: follower })).toMatchObject({
      status: 'rejected',
      reason: 'not_leader',
      leaderHint: leader,
    });
  });

  it('a revived follower catches up via the nextIndex backward walk', () => {
    const h = new Harness({ nodeCount: 5, seed: 8 });
    const leader1 = h.electLeader();
    h.runUntil((s) => converged(s), 50);

    const laggard = leader1 === 5 ? 4 : 5;
    h.cluster.killNode(laggard);
    const early = [1, 2, 3].map((i) => h.cluster.clientWrite(set(`k${i}`, `v${i}`)));
    h.runUntil(() => early.every((r) => h.cluster.getClientRequest(r.id)!.status === 'committed'), 50);

    // Change leaders while the laggard is down, so the new leader's nextIndex
    // for it starts at the END of the new leader's log: far past the laggard's.
    h.cluster.killNode(leader1);
    const leader2 = h.electLeader();
    const late = [4, 5].map((i) => h.cluster.clientWrite(set(`k${i}`, `v${i}`)));
    h.runUntil(() => late.every((r) => h.cluster.getClientRequest(r.id)!.status === 'committed'), 50);
    const before = h.events.length;

    h.cluster.reviveNode(laggard);
    h.runUntil((s) => converged(s), 200, 'laggard to catch up');

    const recovery = h.events.slice(before);
    const backtracks = h.eventsOf('next_index_backtracked', recovery).filter((e) => e.peer === laggard);
    expect(backtracks.length).toBeGreaterThan(1);
    expect(backtracks.map((e) => e.nextIndex)).toEqual(
      [...backtracks.map((e) => e.nextIndex)].sort((a, b) => b - a), // strictly walking backward
    );
    expect(h.eventsOf('append_rejected', recovery).some((e) => e.node === laggard && e.reason === 'log_mismatch')).toBe(
      true,
    );
    expect(terms(h.node(laggard))).toEqual(terms(h.node(leader2)));
    expect(h.node(laggard).store).toEqual({ k1: 'v1', k2: 'v2', k3: 'v3', k4: 'v4', k5: 'v5' });
    expectAppliedInOrderExactlyOnce(h.events, 5);
    h.expectSafe();
  });

  it('repairs divergent follower logs: Raft paper Figure 7', () => {
    // The leader for term 8 and followers (a)-(f) from Figure 7.
    const h = new Harness({
      nodeCount: 7,
      timeoutRange: [50, 100],
      initialState: {
        1: { currentTerm: 7, log: logOf(1, 1, 1, 4, 4, 5, 5, 6, 6, 6) }, // leader-to-be
        2: { currentTerm: 6, log: logOf(1, 1, 1, 4, 4, 5, 5, 6, 6) }, // (a) missing an entry
        3: { currentTerm: 4, log: logOf(1, 1, 1, 4) }, // (b) missing many
        4: { currentTerm: 6, log: logOf(1, 1, 1, 4, 4, 5, 5, 6, 6, 6, 6) }, // (c) one extra uncommitted
        5: { currentTerm: 7, log: logOf(1, 1, 1, 4, 4, 5, 5, 6, 6, 6, 7, 7) }, // (d) extra term-7 entries
        6: { currentTerm: 4, log: logOf(1, 1, 1, 4, 4, 4, 4) }, // (e) missing + extra
        7: { currentTerm: 3, log: logOf(1, 1, 1, 2, 2, 2, 3, 3, 3, 3, 3) }, // (f) diverges at index 4
      },
    });
    h.cluster.forceElectionTimeout(1);
    h.runUntil((s) => s.nodes[0].role === 'leader', 20, 'S1 to win term 8');
    expect(h.node(1).currentTerm).toBe(8);
    // (c) and (d) have more up-to-date logs, so they refused to vote.
    const denied = h.eventsOf('vote_denied').map((e) => [e.node, e.reason]);
    expect(denied).toEqual([
      [4, 'log_not_up_to_date'],
      [5, 'log_not_up_to_date'],
    ]);

    h.runUntil((s) => converged(s), 300, 'all logs to match');
    const expected = [1, 1, 1, 4, 4, 5, 5, 6, 6, 6, 8]; // leader's log + its term-8 no-op
    for (const n of h.state.nodes) expect(terms(n)).toEqual(expected);

    const truncations = h.eventsOf('log_truncated').map((e) => [e.node, e.fromIndex, e.removed.map((r) => r.term)]);
    expect(truncations).toEqual(
      expect.arrayContaining([
        [4, 11, [6]], // (c): extra term-6 entry removed
        [5, 11, [7, 7]], // (d): term-7 entries removed
        [6, 6, [4, 4]], // (e): conflict at index 6
        [7, 4, [2, 2, 2, 3, 3, 3, 3, 3]], // (f): conflict at index 4
      ]),
    );
    expect(truncations).toHaveLength(4); // (a) and (b) only needed appends
    const stores = h.state.nodes.map((n) => JSON.stringify(n.store));
    expect(new Set(stores).size).toBe(1);
    h.expectSafe();
  });
});

suite('Figure 8: leaders only commit entries from their own term by counting replicas', () => {
  // State at the start of Figure 8 (c): S1 led term 2 and got index 2 onto
  // S2 only; S5 then led term 3 and wrote its own index 2 locally; S5 is now
  // down. S1 comes back and will win term 4.
  const figure8 = (leaderNoop: boolean) => {
    const h = new Harness({
      nodeCount: 5,
      leaderNoop,
      timeoutRange: [60, 80],
      msgDelay: 1,
      initialState: {
        1: { currentTerm: 3, log: logOf(1, 2) },
        2: { currentTerm: 2, log: logOf(1, 2) },
        3: { currentTerm: 3, votedFor: 5, log: logOf(1) },
        4: { currentTerm: 3, votedFor: 5, log: logOf(1) },
        5: { currentTerm: 3, votedFor: 5, log: logOf(1, 3) },
      },
    });
    h.cluster.killNode(5);
    h.cluster.partition([[4]]); // keep S4 out so only S1, S2, S3 hold index 2
    h.cluster.forceElectionTimeout(1);
    h.runUntil((s) => s.nodes[0].role === 'leader', 10, 'S1 to lead term 4');
    expect(h.node(1).currentTerm).toBe(4);
    return h;
  };

  /** Phase (c): S1 gets its term-2 entry onto a majority (S1, S2, S3). */
  const replicateOldEntryToMajority = (h: Harness) => {
    h.runUntil((s) => s.nodes[0].matchIndex![2] >= 2 && s.nodes[0].matchIndex![3] >= 2, 20, 'index 2 on majority');
    h.tick(30);
  };

  it('(c) a term-2 entry stored on a majority is NOT committed by the term-4 leader', () => {
    const h = figure8(false);
    replicateOldEntryToMajority(h);
    expect([1, 2, 3].map((id) => terms(h.node(id)))).toEqual([
      [1, 2],
      [1, 2],
      [1, 2],
    ]);
    expect(h.node(1).commitIndex).toBe(0);
    expect(h.eventsOf('commit_advanced')).toEqual([]);
    h.expectSafe();
  });

  it('(d) ...which is exactly right: S5 can still win and overwrite it', () => {
    const h = figure8(false);
    replicateOldEntryToMajority(h);

    h.cluster.killNode(1);
    h.cluster.healPartition();
    h.cluster.reviveNode(5);
    // S5 (term 3) needs two tries: in term 4 everyone already voted for S1.
    h.cluster.forceElectionTimeout(5);
    h.tick(3);
    h.cluster.forceElectionTimeout(5);
    h.runUntil((s) => s.nodes[4].role === 'leader', 10, 'S5 to lead term 5');
    // S5's last log term (3) beats everyone else's (2 or 1): S2, S3, S4 vote for it.
    expect(h.eventsOf('became_leader').at(-1)).toMatchObject({ node: 5, term: 5 });
    const voters = h.eventsOf('vote_granted').filter((e) => e.candidate === 5 && e.term === 5);
    expect(voters.map((e) => e.node)).toEqual([2, 3, 4]);

    const req = h.cluster.clientWrite(set('y', '1'));
    h.runUntil(() => h.cluster.getClientRequest(req.id)!.status === 'committed', 30);
    h.runUntil((s) => converged(s), 30);

    // The term-2 entry that sat on a majority was overwritten on S2 and S3.
    for (const id of [2, 3]) {
      const t = h.eventsOf('log_truncated').find((e) => e.node === id)!;
      expect(t).toMatchObject({ fromIndex: 2 });
      expect(t.removed.map((e) => e.term)).toEqual([2]);
    }
    for (const id of [2, 3, 4, 5]) expect(terms(h.node(id))).toEqual([1, 3, 5]);
    // Nobody ever applied the term-2 entry, so overwriting it broke nothing.
    expect(h.eventsOf('applied').some((e) => e.entry.index === 2 && e.entry.term === 2)).toBe(false);
    h.expectSafe();
  });

  it('(e) the term-2 entry commits only once a term-4 entry above it reaches a majority', () => {
    const h = figure8(false);
    replicateOldEntryToMajority(h);

    h.cluster.clientWrite(set('y', '1')); // index 3, term 4
    h.runUntil((s) => s.nodes[0].commitIndex > 0, 20, 'S1 to commit');

    const commits = h.eventsOf('commit_advanced').filter((e) => e.node === 1);
    // One jump from 0 straight to 3: index 2 was committed *indirectly*.
    expect(commits.map((e) => [e.oldCommitIndex, e.newCommitIndex])).toEqual([[0, 3]]);
    expect(h.node(1).log[2].term).toBe(4);
    h.expectSafe();
  });

  it('with the leader no-op (real Raft), the new leader commits inherited entries without a client write', () => {
    const h = figure8(true);
    h.runUntil((s) => s.nodes[0].commitIndex > 0, 20, 'S1 to commit');
    expect(terms(h.node(1))).toEqual([1, 2, 4]); // inherited term-2 entry + term-4 no-op
    const commits = h.eventsOf('commit_advanced').filter((e) => e.node === 1);
    expect(commits.map((e) => [e.oldCommitIndex, e.newCommitIndex])).toEqual([[0, 3]]);
    h.expectSafe();
  });
});
