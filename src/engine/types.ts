/**
 * Core data types for the Raft simulation engine.
 *
 * Everything here is plain data (no classes, no functions except the optional
 * partition predicate) so snapshots can be serialized, diffed, and rendered.
 *
 * Naming follows Figure 2 of the Raft paper ("In Search of an Understandable
 * Consensus Algorithm", Ongaro & Ousterhout) wherever possible.
 */

/** Node identifiers are 1-based (S1..S7), matching the Raft paper's figures. */
export type NodeId = number;

export type Role = 'follower' | 'candidate' | 'leader';

/** Hard upper bound on cluster size. */
export const MAX_NODES = 7;

// ---------------------------------------------------------------------------
// Log & state machine
// ---------------------------------------------------------------------------

/**
 * A command for the replicated key/value state machine.
 * `noop` is what a newly elected leader appends to commit entries from
 * earlier terms (Raft §5.4.2 / §8).
 */
export type Command =
  | { readonly op: 'set'; readonly key: string; readonly value: string }
  | { readonly op: 'delete'; readonly key: string }
  | { readonly op: 'noop' };

/**
 * One slot in a node's log. Raft log indices start at 1.
 * Entries are immutable once created: they are shared between a node's log,
 * in-flight messages and events without copying.
 */
export interface LogEntry {
  readonly index: number;
  readonly term: number;
  readonly command: Command;
}

// ---------------------------------------------------------------------------
// RPCs (the messages nodes exchange)
// ---------------------------------------------------------------------------

/** RequestVote RPC arguments (Figure 2). */
export interface RequestVoteArgs {
  readonly type: 'RequestVote';
  readonly term: number;
  readonly candidateId: NodeId;
  readonly lastLogIndex: number;
  readonly lastLogTerm: number;
}

/** RequestVote RPC results (Figure 2). */
export interface RequestVoteReply {
  readonly type: 'RequestVoteReply';
  readonly term: number;
  readonly voteGranted: boolean;
}

/** AppendEntries RPC arguments (Figure 2). Empty `entries` = heartbeat. */
export interface AppendEntriesArgs {
  readonly type: 'AppendEntries';
  readonly term: number;
  readonly leaderId: NodeId;
  readonly prevLogIndex: number;
  readonly prevLogTerm: number;
  readonly entries: readonly LogEntry[];
  readonly leaderCommit: number;
}

/**
 * AppendEntries RPC results. Figure 2 only has `term` and `success`; real
 * implementations also say *which* request is being answered, because replies
 * can arrive late or out of order:
 *  - `matchIndex`: on success, the last index known to match the leader
 *    (prevLogIndex + entries.length).
 *  - `prevLogIndex`: echoes the request, so a failure tells the leader which
 *    consistency check failed.
 */
export interface AppendEntriesReply {
  readonly type: 'AppendEntriesReply';
  readonly term: number;
  readonly success: boolean;
  readonly matchIndex: number;
  readonly prevLogIndex: number;
}

export type Rpc =
  | RequestVoteArgs
  | RequestVoteReply
  | AppendEntriesArgs
  | AppendEntriesReply;

/** An RPC on the simulated wire. Immutable once sent. */
export interface NetworkMessage {
  /** Unique, increasing id; pairs `message_sent` with its delivery/drop. */
  readonly id: number;
  readonly from: NodeId;
  readonly to: NodeId;
  readonly sentAt: number;
  readonly deliverAt: number;
  readonly rpc: Rpc;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface ClusterConfig {
  /** Number of servers, 1..MAX_NODES. Majority is computed from this. */
  readonly nodeCount: number;
  /** Seed for the deterministic RNG. Same seed + same inputs = same run. */
  readonly seed: number;
  /** Election timeout is drawn uniformly from [min, max] ticks on every reset. */
  readonly timeoutRange: readonly [number, number];
  /** A leader sends AppendEntries (heartbeats) every this many ticks. */
  readonly heartbeatInterval: number;
  /** Per-message network delay in ticks: fixed, or drawn from [min, max]. */
  readonly msgDelay: number | readonly [number, number];
  /**
   * Whether a newly elected leader appends a no-op entry in its own term.
   * Real Raft does this (§8); turning it off is a teaching toggle that lets
   * you watch Figure 8 play out without the fix.
   */
  readonly leaderNoop: boolean;
  /** Oldest events are discarded once the history exceeds this many. */
  readonly maxHistory: number;
}

/** Persistent state to start a node from: lets tests/UI load a scenario. */
export interface NodePreset {
  readonly currentTerm: number;
  readonly votedFor?: NodeId | null;
  /** Log entries in order; indices are assigned from position (1-based). */
  readonly log: ReadonlyArray<{ readonly term: number; readonly command: Command }>;
}

export interface ClusterOptions extends Partial<ClusterConfig> {
  /** Optional starting persistent state per node (e.g. Figure 7 / Figure 8). */
  readonly initialState?: Readonly<Record<NodeId, NodePreset>>;
}

// ---------------------------------------------------------------------------
// Partitions
// ---------------------------------------------------------------------------

/** Returns true if a message from `from` may reach `to`. May be asymmetric. */
export type LinkPredicate = (from: NodeId, to: NodeId) => boolean;

/**
 * Either explicit groups (nodes talk only within their group; any node not
 * listed is placed in one extra group together) or a custom link predicate.
 */
export type PartitionSpec = ReadonlyArray<readonly NodeId[]> | LinkPredicate;

export type PartitionState =
  | { readonly kind: 'none' }
  | { readonly kind: 'groups'; readonly groups: NodeId[][] }
  | { readonly kind: 'custom' };

// ---------------------------------------------------------------------------
// Client requests
// ---------------------------------------------------------------------------

/**
 * The life of one client write.
 *  - pending:   accepted by a leader, waiting for commit
 *  - committed: the accepting leader applied it and "answered" the client
 *  - rejected:  no leader to accept it (or sent to a non-leader)
 *  - abandoned: the accepting leader crashed or stepped down before answering.
 *               The entry MAY still commit later via a new leader. The client
 *               just never hears back, which is why real clients retry.
 */
export type ClientRequestStatus = 'pending' | 'committed' | 'rejected' | 'abandoned';

export type ClientRejectReason = 'no_leader' | 'not_leader' | 'node_down';
export type ClientAbandonReason = 'leader_crashed' | 'leader_stepped_down';

export interface ClientRequest {
  readonly id: number;
  readonly command: Command;
  readonly submittedAt: number;
  status: ClientRequestStatus;
  /** Leader that accepted the write (null if rejected). */
  leader: NodeId | null;
  /** Where the entry landed in that leader's log. */
  index: number | null;
  term: number | null;
  /** Tick at which the client got its answer (committed), if it did. */
  answeredAt: number | null;
  reason: ClientRejectReason | ClientAbandonReason | null;
  /** On `not_leader`, who the contacted node believes the leader is. */
  leaderHint: NodeId | null;
}

// ---------------------------------------------------------------------------
// Snapshots (what getState() returns)
// ---------------------------------------------------------------------------

export interface NodeSnapshot {
  readonly id: NodeId;
  readonly alive: boolean;
  readonly role: Role;
  // Persistent state (Figure 2)
  readonly currentTerm: number;
  readonly votedFor: NodeId | null;
  readonly log: readonly LogEntry[];
  // Volatile state (Figure 2)
  readonly commitIndex: number;
  readonly lastApplied: number;
  /** The applied key/value state machine. */
  readonly store: Readonly<Record<string, string>>;
  /** Who this node believes is leader for its current term (null if unknown). */
  readonly leaderId: NodeId | null;
  /** Candidate only: who has voted for us this term (includes self). */
  readonly votesReceived: readonly NodeId[];
  // Leader-only volatile state (Figure 2). null when not leader.
  readonly nextIndex: Readonly<Record<NodeId, number>> | null;
  readonly matchIndex: Readonly<Record<NodeId, number>> | null;
  // Timers, in ticks (for progress bars in the UI)
  readonly electionElapsed: number;
  readonly electionTimeout: number;
  readonly heartbeatElapsed: number;
}

export interface ClusterSnapshot {
  /** Current simulated time (ticks since creation). */
  readonly time: number;
  readonly config: ClusterConfig;
  /** Votes needed to win / replicas needed to commit. */
  readonly majority: number;
  /** Sorted by id (S1 first). */
  readonly nodes: readonly NodeSnapshot[];
  /** Messages on the wire, ordered by delivery time then send order. */
  readonly inFlight: readonly NetworkMessage[];
  readonly partition: PartitionState;
  readonly clientRequests: readonly ClientRequest[];
}
