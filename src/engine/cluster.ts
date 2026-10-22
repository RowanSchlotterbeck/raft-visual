/**
 * The cluster controller: owns simulated time, the network, the nodes, and the
 * event log. This is the API the UI drives.
 *
 * One tick, in order:
 *   1. time += 1
 *   2. deliver every message due now (oldest first); each delivery may make
 *      the receiver reply, and replies are due no earlier than the next tick
 *   3. tick each live node's timers (in id order): elections, heartbeats
 * All iteration is in a fixed order and all randomness comes from the seeded
 * RNG, so a run is fully determined by its config and the calls made on it.
 */
import type { RaftEvent, RaftEventBody } from './events';
import { Network } from './network';
import { RaftNode } from './node';
import { createRng, type Rng } from './rng';
import {
  MAX_NODES,
  type ClientRejectReason,
  type ClientRequest,
  type ClusterConfig,
  type ClusterOptions,
  type ClusterSnapshot,
  type Command,
  type NodeId,
  type PartitionSpec,
} from './types';

export const DEFAULT_CONFIG: ClusterConfig = {
  nodeCount: 3,
  seed: 1,
  timeoutRange: [20, 40],
  heartbeatInterval: 6,
  msgDelay: 2,
  leaderNoop: true,
  maxHistory: 50_000,
};

export interface ClientWriteOptions {
  /**
   * Send the write to this specific node instead of the current leader.
   * Useful for showing a write to a stale leader in a minority partition
   * (accepted, never committed) or to a follower (rejected with a hint).
   */
  via?: NodeId;
}

export class RaftCluster {
  readonly config: ClusterConfig;
  private readonly rng: Rng;
  private readonly network: Network;
  /** nodes[i] is server S(i+1). */
  private readonly nodes: RaftNode[];

  private now = 0;
  private seq = 0;
  private history: RaftEvent[] = [];
  /** Events of the tick currently being run (returned by tick()). */
  private currentTick: RaftEvent[] = [];

  private requests = new Map<number, ClientRequest>();
  private nextRequestId = 1;

  constructor(options: ClusterOptions = {}) {
    const { initialState, ...overrides } = options;
    this.config = validateConfig({ ...DEFAULT_CONFIG, ...overrides });
    this.rng = createRng(this.config.seed);

    const ids = Array.from({ length: this.config.nodeCount }, (_, i) => i + 1);
    this.network = new Network(ids, this.config.msgDelay, this.rng);
    this.nodes = ids.map(
      (id) =>
        new RaftNode(id, {
          peers: ids.filter((p) => p !== id),
          clusterSize: this.config.nodeCount,
          timeoutRange: this.config.timeoutRange,
          heartbeatInterval: this.config.heartbeatInterval,
          leaderNoop: this.config.leaderNoop,
          rng: this.rng,
          send: (from, to, rpc) => {
            const message = this.network.send(from, to, rpc, this.now);
            this.emit({ type: 'message_sent', message });
          },
          emit: (event) => this.emit(event),
        }),
    );

    for (const [id, preset] of Object.entries(initialState ?? {})) {
      this.node(Number(id)).loadPreset(preset);
    }
  }

  // =========================================================================
  // Time
  // =========================================================================

  /** Advance simulated time by `n` ticks. Returns the events emitted, in order. */
  tick(n = 1): RaftEvent[] {
    const out: RaftEvent[] = [];
    for (let i = 0; i < n; i++) out.push(...this.step());
    return out;
  }

  private step(): RaftEvent[] {
    this.currentTick = [];
    this.now++;

    for (const message of this.network.takeDue(this.now)) {
      const target = this.node(message.to);
      if (!target.alive) {
        this.emit({ type: 'message_dropped', message, reason: 'node_down' });
      } else if (!this.network.canReach(message.from, message.to)) {
        this.emit({ type: 'message_dropped', message, reason: 'partitioned' });
      } else {
        this.emit({ type: 'message_delivered', message });
        target.receive(message.from, message.rpc);
      }
    }

    for (const node of this.nodes) if (node.alive) node.tick();

    const events = this.currentTick;
    this.currentTick = [];
    return events;
  }

  /** Current simulated time in ticks. */
  get time(): number {
    return this.now;
  }

  // =========================================================================
  // Clients
  // =========================================================================

  /**
   * A client submits a write. By default it's routed to the current leader
   * (the live leader with the highest term). Returns the request record;
   * `status` is 'rejected' immediately if there's no leader, otherwise
   * 'pending' until the leader commits and applies it ('committed').
   * Look it up again later with getClientRequest(id) or getState().
   */
  clientWrite(command: Command, options: ClientWriteOptions = {}): ClientRequest {
    const id = this.nextRequestId++;
    const target = options.via !== undefined ? this.node(options.via) : this.findLeaderNode();

    const reject = (reason: ClientRejectReason, leaderHint: NodeId | null): ClientRequest => {
      const request: ClientRequest = {
        id,
        command,
        submittedAt: this.now,
        status: 'rejected',
        leader: null,
        index: null,
        term: null,
        answeredAt: null,
        reason,
        leaderHint,
      };
      this.requests.set(id, request);
      this.emit({ type: 'client_request_rejected', requestId: id, command, reason, leaderHint });
      return { ...request };
    };

    if (target === undefined) return reject('no_leader', null);
    if (!target.alive) return reject('node_down', null);
    if (target.role !== 'leader') return reject('not_leader', target.leaderId);

    const entry = target.acceptClientCommand(command);
    const request: ClientRequest = {
      id,
      command,
      submittedAt: this.now,
      status: 'pending',
      leader: target.id,
      index: entry.index,
      term: entry.term,
      answeredAt: null,
      reason: null,
      leaderHint: null,
    };
    this.requests.set(id, request);
    this.emit({ type: 'client_request_received', requestId: id, leader: target.id, entry });
    return { ...request };
  }

  getClientRequest(id: number): ClientRequest | undefined {
    const request = this.requests.get(id);
    return request && { ...request };
  }

  /** Watches node events to answer or abandon pending client requests. */
  private trackClientRequests(event: RaftEventBody): void {
    if (event.type === 'applied') {
      for (const request of this.requests.values()) {
        if (request.status !== 'pending' || request.leader !== event.node || request.index !== event.entry.index) {
          continue;
        }
        // The accepting leader still holds it (leaders never overwrite their
        // own log), so the entry here is the client's: reply.
        request.status = 'committed';
        request.answeredAt = this.now;
        this.emit({ type: 'client_replied', requestId: request.id, leader: event.node, index: event.entry.index });
      }
    } else if (event.type === 'became_follower' && event.previousRole === 'leader') {
      this.abandonRequestsOf(event.node, 'leader_stepped_down');
    }
  }

  private abandonRequestsOf(leader: NodeId, reason: 'leader_crashed' | 'leader_stepped_down'): void {
    for (const request of this.requests.values()) {
      if (request.status === 'pending' && request.leader === leader) {
        request.status = 'abandoned';
        request.reason = reason;
        this.emit({ type: 'client_request_abandoned', requestId: request.id, leader, reason });
      }
    }
  }

  // =========================================================================
  // Fault injection
  // =========================================================================

  /** Crash a node: it stops sending and receiving and loses volatile state. */
  killNode(id: NodeId): void {
    const node = this.node(id);
    if (!node.alive) return;
    const previousRole = node.role;
    node.crash();
    this.emit({ type: 'node_killed', node: id, previousRole });
    if (previousRole === 'leader') this.abandonRequestsOf(id, 'leader_crashed');
  }

  /** Restart a crashed node from its persistent state (term, vote, log). */
  reviveNode(id: NodeId): void {
    const node = this.node(id);
    if (node.alive) return;
    node.restart();
    this.emit({ type: 'node_revived', node: id });
  }

  /**
   * Cut the network. Groups: nodes can only talk within their group (unlisted
   * nodes form one extra group together). Or pass a predicate
   * `(from, to) => canDeliver` for asymmetric or custom link failures.
   * Replaces any existing partition.
   */
  partition(spec: PartitionSpec): void {
    this.network.setPartition(spec);
    this.emit({ type: 'partition_changed', groups: this.network.groups() });
  }

  healPartition(): void {
    this.network.heal();
    this.emit({ type: 'partition_healed' });
  }

  /** Make a node's election timer fire on the next tick (teaching aid; no-op on leaders). */
  forceElectionTimeout(id: NodeId): void {
    const node = this.node(id);
    if (!node.alive || node.role === 'leader') return;
    node.forceElectionTimeout();
    this.emit({ type: 'election_timeout_forced', node: id });
  }

  // =========================================================================
  // Inspection
  // =========================================================================

  /** A full, detached snapshot of every node, the wire, and client requests. */
  getState(): ClusterSnapshot {
    return {
      time: this.now,
      config: this.config,
      majority: Math.floor(this.config.nodeCount / 2) + 1,
      nodes: this.nodes.map((n) => n.snapshot()),
      inFlight: this.network.pending(),
      partition: this.network.partitionState(),
      clientRequests: [...this.requests.values()].map((r) => ({ ...r })),
    };
  }

  /** The live leader with the highest term, or null if there is none. */
  getLeader(): NodeId | null {
    return this.findLeaderNode()?.id ?? null;
  }

  /** Every event with seq > `sinceSeq` (all retained history by default). */
  getEvents(sinceSeq = 0): RaftEvent[] {
    if (sinceSeq <= 0) return [...this.history];
    return this.history.filter((e) => e.seq > sinceSeq);
  }

  private findLeaderNode(): RaftNode | undefined {
    let best: RaftNode | undefined;
    for (const node of this.nodes) {
      if (node.alive && node.role === 'leader' && (!best || node.currentTerm > best.currentTerm)) best = node;
    }
    return best;
  }

  private node(id: NodeId): RaftNode {
    const node = this.nodes[id - 1];
    if (!node) throw new RangeError(`no such node: ${id}`);
    return node;
  }

  private emit(body: RaftEventBody): void {
    const event = { ...body, seq: ++this.seq, time: this.now } as RaftEvent;
    this.history.push(event);
    this.currentTick.push(event);
    if (this.history.length > this.config.maxHistory) {
      this.history.splice(0, this.history.length - this.config.maxHistory);
    }
    this.trackClientRequests(body);
  }
}

/** Create a simulated cluster. All options are optional; see DEFAULT_CONFIG. */
export function createCluster(options: ClusterOptions = {}): RaftCluster {
  return new RaftCluster(options);
}

function validateConfig(config: ClusterConfig): ClusterConfig {
  const { nodeCount, timeoutRange, heartbeatInterval, msgDelay } = config;
  const isPosInt = (n: number) => Number.isInteger(n) && n >= 1;

  if (!Number.isInteger(nodeCount) || nodeCount < 1 || nodeCount > MAX_NODES) {
    throw new RangeError(`nodeCount must be an integer from 1 to ${MAX_NODES}`);
  }
  if (!isPosInt(timeoutRange[0]) || !isPosInt(timeoutRange[1]) || timeoutRange[0] > timeoutRange[1]) {
    throw new RangeError('timeoutRange must be [min, max] positive integers with min <= max');
  }
  if (!isPosInt(heartbeatInterval)) throw new RangeError('heartbeatInterval must be a positive integer');
  const delays = typeof msgDelay === 'number' ? [msgDelay, msgDelay] : msgDelay;
  if (!isPosInt(delays[0]) || !isPosInt(delays[1]) || delays[0] > delays[1]) {
    throw new RangeError('msgDelay must be a positive integer or [min, max] with min <= max');
  }
  return {
    ...config,
    timeoutRange: [timeoutRange[0], timeoutRange[1]],
    msgDelay: typeof msgDelay === 'number' ? msgDelay : [msgDelay[0], msgDelay[1]],
  };
}
