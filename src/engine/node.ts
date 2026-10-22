/**
 * One Raft server, following Figure 2 of the Raft paper rule by rule.
 *
 * A node never touches the network or clock directly. The cluster gives it:
 *  - `tick()`: one unit of time has passed (drives election/heartbeat timers)
 *  - `receive()`: an RPC arrived
 * and the node responds by calling `env.send()` and `env.emit()`.
 *
 * Section markers like "[Figure 2: RequestVote RPC, receiver 2]" point at the
 * exact rule being implemented.
 */
import type { RaftEventBody, VoteDenialReason } from './events';
import type { Rng } from './rng';
import type {
  AppendEntriesArgs,
  AppendEntriesReply,
  Command,
  LogEntry,
  NodeId,
  NodePreset,
  NodeSnapshot,
  RequestVoteArgs,
  RequestVoteReply,
  Role,
  Rpc,
} from './types';

/** What a node needs from the outside world. Provided by the cluster. */
export interface NodeEnv {
  /** Every other server in the configuration. */
  readonly peers: readonly NodeId[];
  /** Configured cluster size: majorities are counted against this, not "who is up". */
  readonly clusterSize: number;
  readonly timeoutRange: readonly [number, number];
  readonly heartbeatInterval: number;
  readonly leaderNoop: boolean;
  readonly rng: Rng;
  send(from: NodeId, to: NodeId, rpc: Rpc): void;
  emit(event: RaftEventBody): void;
}

export class RaftNode {
  readonly id: NodeId;
  private readonly env: NodeEnv;

  /** False while crashed: the cluster neither ticks it nor delivers to it. */
  alive = true;

  // ----- Persistent state on all servers (Figure 2) ------------------------
  // Survives a crash: killNode() keeps these, reviveNode() resumes from them.

  /** Latest term this server has seen. */
  currentTerm = 0;
  /** Candidate that received our vote in currentTerm, or null. */
  votedFor: NodeId | null = null;
  /** log[i - 1] holds the entry at Raft index i. */
  log: LogEntry[] = [];

  // ----- Volatile state on all servers (Figure 2) --------------------------
  // Lost on a crash.

  role: Role = 'follower';
  /** Highest log index known to be committed. */
  commitIndex = 0;
  /** Highest log index applied to the state machine. */
  lastApplied = 0;
  /** The state machine: a key/value map built by applying committed entries. */
  store = new Map<string, string>();
  /** Not in Figure 2: who we think leads currentTerm. Used for client redirects. */
  leaderId: NodeId | null = null;

  // ----- Candidate state ---------------------------------------------------
  votesReceived = new Set<NodeId>();

  // ----- Volatile state on leaders (Figure 2), reinitialized after election -
  /** For each peer: index of the next log entry to send it. */
  nextIndex = new Map<NodeId, number>();
  /** For each peer: highest index known to be replicated on it. */
  matchIndex = new Map<NodeId, number>();

  // ----- Timers, in ticks --------------------------------------------------
  electionElapsed = 0;
  electionTimeout: number;
  heartbeatElapsed = 0;
  /** Set by a client write so the leader replicates on the next tick, not the next heartbeat. */
  private replicationPending = false;

  constructor(id: NodeId, env: NodeEnv) {
    this.id = id;
    this.env = env;
    this.electionTimeout = this.randomElectionTimeout();
  }

  // =========================================================================
  // Log helpers (index 0 is the empty prefix, with term 0)
  // =========================================================================

  lastLogIndex(): number {
    return this.log.length;
  }

  lastLogTerm(): number {
    return this.log.length === 0 ? 0 : this.log[this.log.length - 1].term;
  }

  /** Term of the entry at `index`; 0 for index 0; undefined if we don't have it. */
  termAt(index: number): number | undefined {
    if (index === 0) return 0;
    return this.log[index - 1]?.term;
  }

  private majority(): number {
    return Math.floor(this.env.clusterSize / 2) + 1;
  }

  // =========================================================================
  // Time
  // =========================================================================

  /** One tick of simulated time has passed. */
  tick(): void {
    if (this.role === 'leader') {
      // [Figure 2: Leaders] Send heartbeats during idle periods to prevent
      // election timeouts; send log entries as soon as there are new ones.
      this.heartbeatElapsed++;
      if (this.replicationPending || this.heartbeatElapsed >= this.env.heartbeatInterval) {
        this.heartbeatElapsed = 0;
        this.replicationPending = false;
        this.broadcastAppendEntries();
      }
      // In a one-node cluster nobody will ever reply, so the leader must
      // also check for commit on its own.
      this.advanceCommitIndex();
      return;
    }

    // [Figure 2: Followers / Candidates] If election timeout elapses without
    // hearing from the current leader or granting a vote: start an election.
    this.electionElapsed++;
    if (this.electionElapsed >= this.electionTimeout) {
      this.env.emit({ type: 'election_timeout', node: this.id, term: this.currentTerm });
      this.startElection();
    }
  }

  private randomElectionTimeout(): number {
    const [min, max] = this.env.timeoutRange;
    return this.env.rng.int(min, max);
  }

  /** Restart the election countdown with a fresh random timeout. */
  private resetElectionTimer(): void {
    this.electionElapsed = 0;
    this.electionTimeout = this.randomElectionTimeout();
  }

  // =========================================================================
  // Elections
  // =========================================================================

  /**
   * [Figure 2: Candidates] On conversion to candidate, start election:
   * increment currentTerm, vote for self, reset election timer, send
   * RequestVote RPCs to all other servers.
   */
  private startElection(): void {
    this.currentTerm++;
    this.role = 'candidate';
    this.votedFor = this.id;
    this.leaderId = null;
    this.votesReceived = new Set([this.id]);
    this.resetElectionTimer();
    this.env.emit({ type: 'became_candidate', node: this.id, term: this.currentTerm });

    // A one-node cluster is its own majority.
    if (this.votesReceived.size >= this.majority()) {
      this.becomeLeader();
      return;
    }

    for (const peer of this.env.peers) {
      this.env.send(this.id, peer, {
        type: 'RequestVote',
        term: this.currentTerm,
        candidateId: this.id,
        lastLogIndex: this.lastLogIndex(),
        lastLogTerm: this.lastLogTerm(),
      });
    }
  }

  /**
   * Election restriction (§5.4.1): is a candidate's log at least as
   * up-to-date as ours? Compare last terms first; if equal, longer log wins.
   */
  private candidateLogIsUpToDate(lastLogTerm: number, lastLogIndex: number): boolean {
    const myLastTerm = this.lastLogTerm();
    if (lastLogTerm !== myLastTerm) return lastLogTerm > myLastTerm;
    return lastLogIndex >= this.lastLogIndex();
  }

  private handleRequestVote(from: NodeId, args: RequestVoteArgs): void {
    let denial: VoteDenialReason | null = null;

    if (args.term < this.currentTerm) {
      // [RequestVote receiver 1] Reply false if term < currentTerm.
      denial = 'stale_term';
    } else if (this.votedFor !== null && this.votedFor !== args.candidateId) {
      // [RequestVote receiver 2] One vote per term.
      denial = 'already_voted';
    } else if (!this.candidateLogIsUpToDate(args.lastLogTerm, args.lastLogIndex)) {
      // [RequestVote receiver 2] ...and candidate's log must be at least as up-to-date.
      denial = 'log_not_up_to_date';
    }

    if (denial === null) {
      this.votedFor = args.candidateId;
      // [Followers] Granting a vote resets the election timer.
      this.resetElectionTimer();
      this.env.emit({ type: 'vote_granted', node: this.id, candidate: args.candidateId, term: this.currentTerm });
    } else {
      this.env.emit({
        type: 'vote_denied',
        node: this.id,
        candidate: args.candidateId,
        term: this.currentTerm,
        reason: denial,
      });
    }

    this.env.send(this.id, from, { type: 'RequestVoteReply', term: this.currentTerm, voteGranted: denial === null });
  }

  private handleRequestVoteReply(from: NodeId, reply: RequestVoteReply): void {
    // Ignore replies for an election we are no longer running.
    if (this.role !== 'candidate' || reply.term !== this.currentTerm || !reply.voteGranted) return;

    this.votesReceived.add(from);
    this.env.emit({
      type: 'vote_received',
      node: this.id,
      from,
      term: this.currentTerm,
      votes: this.votesReceived.size,
      needed: this.majority(),
    });

    // [Candidates] If votes received from majority of servers: become leader.
    if (this.votesReceived.size >= this.majority()) this.becomeLeader();
  }

  private becomeLeader(): void {
    this.role = 'leader';
    this.leaderId = this.id;

    // [Leader state] Reinitialized after election: nextIndex = last log index + 1,
    // matchIndex = 0.
    this.nextIndex.clear();
    this.matchIndex.clear();
    for (const peer of this.env.peers) {
      this.nextIndex.set(peer, this.lastLogIndex() + 1);
      this.matchIndex.set(peer, 0);
    }
    this.env.emit({
      type: 'became_leader',
      node: this.id,
      term: this.currentTerm,
      votes: [...this.votesReceived].sort((a, b) => a - b),
    });
    this.votesReceived.clear();

    // §8: a new leader commits a blank no-op entry in its own term. Until an
    // entry from the current term commits, the Figure 8 rule stops it from
    // committing anything, so without this it can't commit at all.
    if (this.env.leaderNoop) this.appendLocal({ op: 'noop' }, 'leader_noop');

    // [Leaders] Upon election: send initial AppendEntries to each server.
    this.heartbeatElapsed = 0;
    this.replicationPending = false;
    this.broadcastAppendEntries();
  }

  /**
   * Step down to follower. Called when a candidate/leader learns of a newer
   * term, or a candidate learns another node won this term.
   */
  private becomeFollower(reason: 'higher_term' | 'leader_discovered'): void {
    const previousRole = this.role;
    this.role = 'follower';
    this.votesReceived.clear();
    this.nextIndex.clear();
    this.matchIndex.clear();
    this.replicationPending = false;
    this.resetElectionTimer();
    this.env.emit({ type: 'became_follower', node: this.id, term: this.currentTerm, previousRole, reason });
  }

  // =========================================================================
  // Message dispatch
  // =========================================================================

  receive(from: NodeId, rpc: Rpc): void {
    // [All servers] If an RPC request or response contains term T > currentTerm:
    // set currentTerm = T, convert to follower. This happens BEFORE the
    // message is handled, so the handler sees the updated term.
    if (rpc.term > this.currentTerm) {
      const oldTerm = this.currentTerm;
      this.currentTerm = rpc.term;
      this.votedFor = null;
      this.leaderId = null;
      this.env.emit({ type: 'term_advanced', node: this.id, oldTerm, newTerm: rpc.term, via: from });
      if (this.role !== 'follower') this.becomeFollower('higher_term');
    }

    switch (rpc.type) {
      case 'RequestVote':
        return this.handleRequestVote(from, rpc);
      case 'RequestVoteReply':
        return this.handleRequestVoteReply(from, rpc);
      case 'AppendEntries':
        return this.handleAppendEntries(from, rpc);
      case 'AppendEntriesReply':
        return this.handleAppendEntriesReply(from, rpc);
    }
  }

  // =========================================================================
  // Log replication: leader side
  // =========================================================================

  private appendLocal(command: Command, source: 'client' | 'leader_noop'): LogEntry {
    const entry: LogEntry = { index: this.lastLogIndex() + 1, term: this.currentTerm, command };
    this.log.push(entry);
    this.env.emit({ type: 'entry_appended', node: this.id, entry, source });
    return entry;
  }

  /**
   * [Leaders] If command received from client: append entry to local log.
   * Replication starts on the next tick; the entry is committed (and the
   * client answered) once a majority stores it.
   */
  acceptClientCommand(command: Command): LogEntry {
    if (this.role !== 'leader') throw new Error(`S${this.id} is not leader`);
    const entry = this.appendLocal(command, 'client');
    this.replicationPending = true;
    return entry;
  }

  private broadcastAppendEntries(): void {
    for (const peer of this.env.peers) this.sendAppendEntries(peer);
  }

  /** Send `peer` everything from nextIndex[peer] onward (empty = heartbeat). */
  private sendAppendEntries(peer: NodeId): void {
    const next = this.nextIndex.get(peer)!;
    const prevLogIndex = next - 1;
    this.env.send(this.id, peer, {
      type: 'AppendEntries',
      term: this.currentTerm,
      leaderId: this.id,
      prevLogIndex,
      prevLogTerm: this.termAt(prevLogIndex)!,
      entries: this.log.slice(prevLogIndex),
      leaderCommit: this.commitIndex,
    });
  }

  private handleAppendEntriesReply(from: NodeId, reply: AppendEntriesReply): void {
    // Ignore replies to a leadership we no longer hold.
    if (this.role !== 'leader' || reply.term !== this.currentTerm) return;

    const oldMatch = this.matchIndex.get(from)!;
    const oldNext = this.nextIndex.get(from)!;

    if (reply.success) {
      // [Leaders] If successful: update nextIndex and matchIndex for follower.
      // max() because a delayed reply may describe an older, shorter request.
      const matchIndex = Math.max(oldMatch, reply.matchIndex);
      const nextIndex = Math.max(oldNext, matchIndex + 1);
      if (matchIndex !== oldMatch || nextIndex !== oldNext) {
        this.matchIndex.set(from, matchIndex);
        this.nextIndex.set(from, nextIndex);
        this.env.emit({ type: 'replication_progress', node: this.id, peer: from, matchIndex, nextIndex });
      }
      this.advanceCommitIndex();
      return;
    }

    // [Leaders] If AppendEntries fails because of log inconsistency: decrement
    // nextIndex and retry. The failed check was at prevLogIndex, so the next
    // attempt starts there (i.e. one entry earlier). The floor is matchIndex + 1
    // (at least 1); a stale duplicate failure therefore can't walk back twice.
    const nextIndex = Math.max(oldMatch + 1, Math.min(oldNext, reply.prevLogIndex));
    if (nextIndex < oldNext) {
      this.nextIndex.set(from, nextIndex);
      this.env.emit({ type: 'next_index_backtracked', node: this.id, peer: from, nextIndex });
      this.sendAppendEntries(from);
    }
  }

  /**
   * [Leaders] If there exists an N such that N > commitIndex, a majority of
   * matchIndex[i] >= N, and log[N].term == currentTerm: set commitIndex = N.
   *
   * The `log[N].term == currentTerm` part is the Figure 8 rule: a leader
   * never commits an entry from an earlier term by counting replicas, even if
   * it's on a majority. Such entries commit only indirectly, when a
   * current-term entry after them commits.
   */
  private advanceCommitIndex(): void {
    if (this.role !== 'leader') return;
    for (let n = this.lastLogIndex(); n > this.commitIndex; n--) {
      // Terms never decrease along a log, so once we reach an older-term
      // entry, every entry below it is older too: nothing more to find.
      if (this.termAt(n) !== this.currentTerm) return;

      let replicas = 1; // the leader itself
      for (const peer of this.env.peers) if (this.matchIndex.get(peer)! >= n) replicas++;

      if (replicas >= this.majority()) {
        this.setCommitIndex(n);
        return;
      }
    }
  }

  // =========================================================================
  // Log replication: follower side
  // =========================================================================

  private handleAppendEntries(from: NodeId, args: AppendEntriesArgs): void {
    // [AppendEntries receiver 1] Reply false if term < currentTerm.
    if (args.term < this.currentTerm) {
      this.rejectAppend(from, args, 'stale_term');
      return;
    }

    // From here on args.term == currentTerm: this message is from the
    // legitimate leader of our term.
    if (this.role === 'leader') {
      // Two leaders in one term would break Election Safety: a bug, not a scenario.
      throw new Error(`Election Safety violated: S${this.id} and S${from} both lead term ${this.currentTerm}`);
    }
    if (this.role === 'candidate') {
      // [Candidates] If AppendEntries RPC received from new leader: convert to follower.
      this.becomeFollower('leader_discovered');
    }
    this.leaderId = args.leaderId;
    // [Followers] Hearing from the current leader resets the election timer.
    this.resetElectionTimer();

    // [AppendEntries receiver 2] Reply false if log doesn't contain an entry at
    // prevLogIndex whose term matches prevLogTerm.
    if (this.termAt(args.prevLogIndex) !== args.prevLogTerm) {
      this.rejectAppend(from, args, 'log_mismatch');
      return;
    }

    // [AppendEntries receiver 3 & 4] Walk the new entries:
    //  - same index & same term: we already have it, skip it
    //  - same index, different term: conflict, so delete it and everything after
    //  - beyond our log: append
    // We must NOT truncate if there's no conflict: a delayed, shorter
    // AppendEntries must never erase entries a later one already added.
    for (const entry of args.entries) {
      const existingTerm = this.termAt(entry.index);
      if (existingTerm === entry.term) continue;

      if (existingTerm !== undefined) {
        const removed = this.log.splice(entry.index - 1);
        this.env.emit({ type: 'log_truncated', node: this.id, fromIndex: entry.index, removed });
      }
      this.log.push(entry);
      this.env.emit({ type: 'entry_appended', node: this.id, entry, source: 'replication' });
    }

    // Everything up to here is now known to match the leader.
    const matchIndex = args.prevLogIndex + args.entries.length;

    // [AppendEntries receiver 5] If leaderCommit > commitIndex: set
    // commitIndex = min(leaderCommit, index of last new entry). Entries past
    // matchIndex weren't checked, so they can't be considered committed.
    if (args.leaderCommit > this.commitIndex) {
      const newCommit = Math.min(args.leaderCommit, matchIndex);
      if (newCommit > this.commitIndex) this.setCommitIndex(newCommit);
    }

    this.env.emit({
      type: 'append_accepted',
      node: this.id,
      leader: from,
      term: this.currentTerm,
      prevLogIndex: args.prevLogIndex,
      entryCount: args.entries.length,
      matchIndex,
    });
    this.env.send(this.id, from, {
      type: 'AppendEntriesReply',
      term: this.currentTerm,
      success: true,
      matchIndex,
      prevLogIndex: args.prevLogIndex,
    });
  }

  private rejectAppend(from: NodeId, args: AppendEntriesArgs, reason: 'stale_term' | 'log_mismatch'): void {
    this.env.emit({
      type: 'append_rejected',
      node: this.id,
      leader: from,
      term: this.currentTerm,
      prevLogIndex: args.prevLogIndex,
      reason,
    });
    this.env.send(this.id, from, {
      type: 'AppendEntriesReply',
      term: this.currentTerm,
      success: false,
      matchIndex: 0,
      prevLogIndex: args.prevLogIndex,
    });
  }

  // =========================================================================
  // Commit & apply
  // =========================================================================

  private setCommitIndex(newCommitIndex: number): void {
    const oldCommitIndex = this.commitIndex;
    this.commitIndex = newCommitIndex;
    this.env.emit({ type: 'commit_advanced', node: this.id, oldCommitIndex, newCommitIndex, term: this.currentTerm });
    this.applyCommitted();
  }

  /**
   * [All servers] If commitIndex > lastApplied: increment lastApplied, apply
   * log[lastApplied] to the state machine. In order, each entry exactly once.
   */
  private applyCommitted(): void {
    while (this.lastApplied < this.commitIndex) {
      this.lastApplied++;
      const entry = this.log[this.lastApplied - 1];
      const command = entry.command;
      if (command.op === 'set') this.store.set(command.key, command.value);
      else if (command.op === 'delete') this.store.delete(command.key);
      this.env.emit({ type: 'applied', node: this.id, entry });
    }
  }

  // =========================================================================
  // Crash / restart / scenario setup (driven by the cluster)
  // =========================================================================

  /**
   * Crash: lose all volatile state, keep persistent state (term, vote, log).
   * With no snapshots, the state machine is volatile too: on restart it's
   * rebuilt by re-applying the log once commitIndex is relearned from a leader.
   */
  crash(): void {
    this.alive = false;
    this.role = 'follower';
    this.commitIndex = 0;
    this.lastApplied = 0;
    this.store = new Map();
    this.leaderId = null;
    this.votesReceived.clear();
    this.nextIndex.clear();
    this.matchIndex.clear();
    this.electionElapsed = 0;
    this.heartbeatElapsed = 0;
    this.replicationPending = false;
  }

  /** Restart as a follower from persistent state, with a fresh election timer. */
  restart(): void {
    this.alive = true;
    this.resetElectionTimer();
  }

  /** Make the election timer fire on the next tick (no-op for a leader). */
  forceElectionTimeout(): void {
    if (this.role !== 'leader') this.electionElapsed = this.electionTimeout;
  }

  /** Load persistent state for a scenario (as if restarting from disk). */
  loadPreset(preset: NodePreset): void {
    let prevTerm = 0;
    this.log = preset.log.map(({ term, command }, i) => {
      if (term < prevTerm) throw new RangeError(`S${this.id}: log terms must never decrease`);
      if (term > preset.currentTerm) throw new RangeError(`S${this.id}: log term ${term} > currentTerm`);
      prevTerm = term;
      return { index: i + 1, term, command };
    });
    this.currentTerm = preset.currentTerm;
    this.votedFor = preset.votedFor ?? null;
  }

  snapshot(): NodeSnapshot {
    const isLeader = this.role === 'leader';
    return {
      id: this.id,
      alive: this.alive,
      role: this.role,
      currentTerm: this.currentTerm,
      votedFor: this.votedFor,
      log: [...this.log],
      commitIndex: this.commitIndex,
      lastApplied: this.lastApplied,
      store: Object.fromEntries(this.store),
      leaderId: this.leaderId,
      votesReceived: [...this.votesReceived].sort((a, b) => a - b),
      nextIndex: isLeader ? Object.fromEntries(this.nextIndex) : null,
      matchIndex: isLeader ? Object.fromEntries(this.matchIndex) : null,
      electionElapsed: this.electionElapsed,
      electionTimeout: this.electionTimeout,
      heartbeatElapsed: this.heartbeatElapsed,
    };
  }
}
