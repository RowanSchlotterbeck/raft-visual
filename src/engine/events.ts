/**
 * The event stream: every state change in the simulation is announced by one
 * of these. The UI animates them; tests assert on them.
 *
 * `node` is always the server where the change happened.
 */
import type {
  ClientAbandonReason,
  ClientRejectReason,
  Command,
  LogEntry,
  NetworkMessage,
  NodeId,
  Role,
} from './types';

export type VoteDenialReason =
  /** Candidate's term is older than ours. */
  | 'stale_term'
  /** We already voted for someone else this term. */
  | 'already_voted'
  /** Candidate's log is behind ours (§5.4.1 election restriction). */
  | 'log_not_up_to_date';

export type AppendRejectReason =
  /** Leader's term is older than ours. */
  | 'stale_term'
  /** We have no entry at prevLogIndex with term prevLogTerm. */
  | 'log_mismatch';

export type DropReason = 'node_down' | 'partitioned';

export type RaftEventBody =
  // ----- Elections ---------------------------------------------------------
  /** A follower/candidate heard nothing for its whole election timeout. */
  | { type: 'election_timeout'; node: NodeId; term: number }
  /** Started an election: term incremented, voted for self. */
  | { type: 'became_candidate'; node: NodeId; term: number }
  /** This node granted its vote for `term` to `candidate`. */
  | { type: 'vote_granted'; node: NodeId; candidate: NodeId; term: number }
  | { type: 'vote_denied'; node: NodeId; candidate: NodeId; term: number; reason: VoteDenialReason }
  /** A candidate counted a granted vote. */
  | { type: 'vote_received'; node: NodeId; from: NodeId; term: number; votes: number; needed: number }
  | { type: 'became_leader'; node: NodeId; term: number; votes: NodeId[] }
  | {
      type: 'became_follower';
      node: NodeId;
      term: number;
      previousRole: Role;
      /** higher_term: saw a newer term. leader_discovered: candidate heard from this term's leader. */
      reason: 'higher_term' | 'leader_discovered';
    }
  /** Adopted a higher term seen in a message from `via`; vote cleared. */
  | { type: 'term_advanced'; node: NodeId; oldTerm: number; newTerm: number; via: NodeId }

  // ----- Log replication ---------------------------------------------------
  | { type: 'entry_appended'; node: NodeId; entry: LogEntry; source: 'client' | 'leader_noop' | 'replication' }
  /** Conflicting entries deleted from `fromIndex` onward. */
  | { type: 'log_truncated'; node: NodeId; fromIndex: number; removed: LogEntry[] }
  /** Follower accepted an AppendEntries (heartbeats included). */
  | {
      type: 'append_accepted';
      node: NodeId;
      leader: NodeId;
      term: number;
      prevLogIndex: number;
      entryCount: number;
      matchIndex: number;
    }
  | {
      type: 'append_rejected';
      node: NodeId;
      leader: NodeId;
      term: number;
      prevLogIndex: number;
      reason: AppendRejectReason;
    }
  /** Leader learned `peer` matches its log up to matchIndex. */
  | { type: 'replication_progress'; node: NodeId; peer: NodeId; matchIndex: number; nextIndex: number }
  /** Leader walked nextIndex back after a failed consistency check. */
  | { type: 'next_index_backtracked'; node: NodeId; peer: NodeId; nextIndex: number }
  | { type: 'commit_advanced'; node: NodeId; oldCommitIndex: number; newCommitIndex: number; term: number }
  /** Entry executed against the node's key/value state machine. */
  | { type: 'applied'; node: NodeId; entry: LogEntry }

  // ----- Network -----------------------------------------------------------
  | { type: 'message_sent'; message: NetworkMessage }
  | { type: 'message_delivered'; message: NetworkMessage }
  | { type: 'message_dropped'; message: NetworkMessage; reason: DropReason }

  // ----- Clients -----------------------------------------------------------
  | { type: 'client_request_received'; requestId: number; leader: NodeId; entry: LogEntry }
  | {
      type: 'client_request_rejected';
      requestId: number;
      command: Command;
      reason: ClientRejectReason;
      leaderHint: NodeId | null;
    }
  /** The accepting leader applied the entry: the client gets its answer. */
  | { type: 'client_replied'; requestId: number; leader: NodeId; index: number }
  | { type: 'client_request_abandoned'; requestId: number; leader: NodeId; reason: ClientAbandonReason }

  // ----- Fault injection (caller actions) ----------------------------------
  | { type: 'node_killed'; node: NodeId; previousRole: Role }
  | { type: 'node_revived'; node: NodeId }
  | { type: 'election_timeout_forced'; node: NodeId }
  /** `groups` is null for a custom predicate partition. */
  | { type: 'partition_changed'; groups: NodeId[][] | null }
  | { type: 'partition_healed' };

/** Every emitted event carries a global sequence number and the tick it happened on. */
export type RaftEvent = RaftEventBody & { readonly seq: number; readonly time: number };

export type RaftEventType = RaftEventBody['type'];

/** Narrow an event by its `type`, e.g. `EventOf<'became_leader'>`. */
export type EventOf<T extends RaftEventType> = Extract<RaftEvent, { type: T }>;
