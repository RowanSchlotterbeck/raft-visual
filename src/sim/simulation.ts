/**
 * The bridge between the deterministic engine and the browser.
 *
 * The engine knows nothing about real time. This class decides WHEN to call
 * cluster.tick(): a requestAnimationFrame loop accumulates fractional tick
 * progress at the chosen speed. Components read an immutable `SimView`
 * (rebuilt after every tick or command) plus `getVisualTime()`, a fractional
 * clock the message layer uses to glide messages between sentAt and deliverAt.
 *
 * The engine is consumed read-only: everything shown comes from getState()
 * and the event stream.
 */
import {
  createCluster,
  type ClusterOptions,
  type ClusterSnapshot,
  type Command,
  type DropReason,
  type NetworkMessage,
  type NodeId,
  type RaftCluster,
  type RaftEvent,
  type VoteDenialReason,
} from '../engine';

/**
 * Timing tuned for watching rather than for the engine defaults: messages take
 * 3 ticks, so at 8 ticks/s a dot is in flight for ~0.4s, heartbeats go out
 * about once a second, and an election timeout is 3–6 seconds.
 */
export const UI_CLUSTER_CONFIG = {
  timeoutRange: [24, 48],
  heartbeatInterval: 8,
  msgDelay: 3,
} as const satisfies ClusterOptions;

export const SPEEDS = [0.5, 1, 2, 4, 8, 12, 20, 30] as const;
export const DEFAULT_SPEED = 8;

/** How many events the event log keeps. */
const LOG_LIMIT = 1500;
/** Short-lived visual effects (vote marks, drop bursts) live this long, in ms. */
export const EFFECT_MS = 1600;

export type Effect =
  | {
      id: string;
      kind: 'vote';
      at: number;
      voter: NodeId;
      candidate: NodeId;
      granted: boolean;
      reason?: VoteDenialReason;
    }
  | { id: string; kind: 'drop'; at: number; message: NetworkMessage; reason: DropReason }
  | { id: string; kind: 'leader'; at: number; node: NodeId; seq: number };

export interface Notice {
  id: number;
  tone: 'info' | 'warn';
  text: string;
}

export interface SimView {
  readonly snapshot: ClusterSnapshot;
  /** Most recent events, oldest first. */
  readonly log: readonly RaftEvent[];
  readonly effects: readonly Effect[];
  readonly playing: boolean;
  readonly tps: number;
  readonly seed: number;
  readonly nodeCount: number;
  /** Nodes on side B of the UI's two-way partition (empty = no partition). */
  readonly sideB: readonly NodeId[];
  readonly notice: Notice | null;
}

export interface SimInit {
  seed: number;
  nodeCount: number;
  tps?: number;
  playing?: boolean;
}

export class Simulation {
  private cluster!: RaftCluster;
  private lastSeq = 0;
  private log: RaftEvent[] = [];
  private effects: Effect[] = [];
  private seed: number;
  private nodeCount: number;
  private playing: boolean;
  private tps: number;
  private notice: Notice | null = null;
  private noticeId = 0;
  private writeCounter = 0;

  /** Fraction of the way to the next tick, in [0, 1). */
  private progress = 0;
  private lastFrame: number | null = null;
  private rafHandle: number | null = null;

  private view!: SimView;
  private readonly listeners = new Set<() => void>();
  private readonly frameListeners = new Set<() => void>();

  constructor(init: SimInit) {
    this.seed = init.seed;
    this.nodeCount = init.nodeCount;
    this.tps = init.tps ?? DEFAULT_SPEED;
    this.playing = init.playing ?? false;
    this.build();
  }

  // ----- subscription (useSyncExternalStore) --------------------------------

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getView = (): SimView => this.view;

  /** Fires every animation frame while time is moving. */
  subscribeFrame = (listener: () => void): (() => void) => {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  };

  /** Simulated time including progress toward the next tick, e.g. 41.37. */
  getVisualTime = (): number => this.view.snapshot.time + this.progress;

  // ----- the clock ----------------------------------------------------------

  start(): void {
    if (this.rafHandle !== null) return;
    this.lastFrame = null;
    this.rafHandle = requestAnimationFrame(this.frame);
  }

  stop(): void {
    if (this.rafHandle !== null) cancelAnimationFrame(this.rafHandle);
    this.rafHandle = null;
  }

  private frame = (now: number): void => {
    // Clamp long gaps (background tab) so we don't fast-forward hundreds of ticks.
    const dt = this.lastFrame === null ? 0 : Math.min(now - this.lastFrame, 250);
    this.lastFrame = now;

    if (this.playing) {
      this.progress += (dt * this.tps) / 1000;
      let ticks = 0;
      while (this.progress >= 1 && ticks < 60) {
        this.progress -= 1;
        this.cluster.tick();
        ticks++;
      }
      if (this.progress >= 1) this.progress = 0;
      if (ticks > 0) this.sync();
      this.frameListeners.forEach((l) => l());
    }

    if (this.pruneEffects(now)) this.publish();
    this.rafHandle = requestAnimationFrame(this.frame);
  };

  play(): void {
    this.playing = true;
    this.publish();
  }

  pause(): void {
    this.playing = false;
    this.publish();
  }

  togglePlay(): void {
    if (this.playing) this.pause();
    else this.play();
  }

  /** Advance exactly one tick (typically while paused). */
  step(): void {
    this.cluster.tick();
    this.progress = 0;
    this.sync();
    this.frameListeners.forEach((l) => l());
  }

  setSpeed(tps: number): void {
    this.tps = tps;
    this.publish();
  }

  /** Throw the cluster away and start over (same timing config, new seed/size). */
  restart(seed: number, nodeCount: number): void {
    this.seed = seed;
    this.nodeCount = nodeCount;
    this.build();
    this.frameListeners.forEach((l) => l());
  }

  private build(): void {
    this.cluster = createCluster({ ...UI_CLUSTER_CONFIG, seed: this.seed, nodeCount: this.nodeCount });
    this.lastSeq = 0;
    this.log = [];
    this.effects = [];
    this.progress = 0;
    this.writeCounter = 0;
    this.notice = null;
    this.sync();
  }

  // ----- manual levers (each is one engine call, then a sync) ---------------

  kill(id: NodeId): void {
    this.cluster.killNode(id);
    this.sync();
  }

  revive(id: NodeId): void {
    this.cluster.reviveNode(id);
    this.sync();
  }

  forceTimeout(id: NodeId): void {
    this.cluster.forceElectionTimeout(id);
    this.sync();
  }

  /** Send a client write. `key` defaults to x; the value is a running counter. */
  write(key: string, via?: NodeId): void {
    const value = String(++this.writeCounter);
    const command: Command = { op: 'set', key, value };
    const request = this.cluster.clientWrite(command, via === undefined ? {} : { via });
    if (request.status === 'rejected') {
      const why =
        request.reason === 'no_leader'
          ? 'there is no leader right now'
          : request.reason === 'node_down'
            ? `S${via} is down`
            : `S${via} is not the leader` + (request.leaderHint ? ` (it points to S${request.leaderHint})` : '');
      this.setNotice('warn', `Write ${key}=${value} rejected: ${why}.`);
    } else {
      this.setNotice('info', `Write ${key}=${value} accepted by S${request.leader} at index ${request.index}.`);
    }
    this.sync();
  }

  /** Two-way split: `sideB` on one side, everyone else on the other. Empty = heal. */
  setSideB(sideB: NodeId[]): void {
    if (sideB.length === 0 || sideB.length >= this.nodeCount) this.cluster.healPartition();
    else this.cluster.partition([sideB]);
    this.sync();
  }

  heal(): void {
    this.cluster.healPartition();
    this.sync();
  }

  dismissNotice(): void {
    this.notice = null;
    this.publish();
  }

  private setNotice(tone: Notice['tone'], text: string): void {
    this.notice = { id: ++this.noticeId, tone, text };
  }

  // ----- syncing engine -> view ---------------------------------------------

  /** Pull everything since the last sync, derive effects, publish. */
  private sync(): void {
    const events = this.cluster.getEvents(this.lastSeq);
    if (events.length > 0) this.lastSeq = events[events.length - 1].seq;
    const snapshot = this.cluster.getState();

    if (events.length > 0) {
      this.log = this.log.concat(events);
      if (this.log.length > LOG_LIMIT) this.log = this.log.slice(-LOG_LIMIT);
    }

    const now = performance.now();
    for (const e of events) {
      if (e.type === 'vote_granted' || e.type === 'vote_denied') {
        this.effects.push({
          id: `v${e.seq}`,
          kind: 'vote',
          at: now,
          voter: e.node,
          candidate: e.candidate,
          granted: e.type === 'vote_granted',
          reason: e.type === 'vote_denied' ? e.reason : undefined,
        });
      } else if (e.type === 'message_dropped') {
        this.effects.push({ id: `d${e.seq}`, kind: 'drop', at: now, message: e.message, reason: e.reason });
      } else if (e.type === 'became_leader') {
        this.effects.push({ id: `l${e.seq}`, kind: 'leader', at: now, node: e.node, seq: e.seq });
      }
    }
    this.pruneEffects(now);
    this.publish(snapshot);
  }

  private pruneEffects(now: number): boolean {
    const before = this.effects.length;
    this.effects = this.effects.filter((fx) => now - fx.at < EFFECT_MS);
    return this.effects.length !== before;
  }

  private publish(snapshot: ClusterSnapshot = this.view.snapshot): void {
    const partition = snapshot.partition;
    this.view = {
      snapshot,
      log: this.log,
      effects: [...this.effects],
      playing: this.playing,
      tps: this.tps,
      seed: this.seed,
      nodeCount: this.nodeCount,
      sideB: partition.kind === 'groups' && partition.groups.length > 1 ? partition.groups[0] : [],
      notice: this.notice,
    };
    this.listeners.forEach((l) => l());
  }
}
