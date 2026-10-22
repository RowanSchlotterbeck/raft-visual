/**
 * The simulated network: an in-memory bag of messages in flight.
 *
 * A message is stamped with a delivery tick when sent. Each tick, the cluster
 * takes the messages that are due and delivers them, unless the destination
 * is down or a partition separates the two nodes *at delivery time*. So a
 * message already on the wire when a partition starts is lost, and one sent
 * just before a heal can still arrive.
 */
import type { Rng } from './rng';
import type {
  LinkPredicate,
  NetworkMessage,
  NodeId,
  PartitionSpec,
  PartitionState,
  Rpc,
} from './types';

type PartitionRule =
  | { kind: 'none' }
  | { kind: 'groups'; groups: NodeId[][]; groupOf: Map<NodeId, number> }
  | { kind: 'custom'; canReach: LinkPredicate };

export class Network {
  private readonly rng: Rng;
  private readonly msgDelay: number | readonly [number, number];
  private readonly nodeIds: readonly NodeId[];
  private inFlight: NetworkMessage[] = [];
  private nextMessageId = 1;
  private rule: PartitionRule = { kind: 'none' };

  constructor(nodeIds: readonly NodeId[], msgDelay: number | readonly [number, number], rng: Rng) {
    this.nodeIds = nodeIds;
    this.msgDelay = msgDelay;
    this.rng = rng;
  }

  /** Put an RPC on the wire. It will be due `delay` ticks from `now`. */
  send(from: NodeId, to: NodeId, rpc: Rpc, now: number): NetworkMessage {
    const delay =
      typeof this.msgDelay === 'number' ? this.msgDelay : this.rng.int(this.msgDelay[0], this.msgDelay[1]);
    const message: NetworkMessage = { id: this.nextMessageId++, from, to, sentAt: now, deliverAt: now + delay, rpc };
    this.inFlight.push(message);
    return message;
  }

  /**
   * Remove and return every message due at or before `now`, oldest first
   * (by delivery tick, then by send order), so delivery is deterministic.
   */
  takeDue(now: number): NetworkMessage[] {
    const due = this.inFlight.filter((m) => m.deliverAt <= now);
    this.inFlight = this.inFlight.filter((m) => m.deliverAt > now);
    return due.sort(byDeliveryOrder);
  }

  /** Messages currently on the wire, in delivery order. */
  pending(): NetworkMessage[] {
    return [...this.inFlight].sort(byDeliveryOrder);
  }

  /** Can a message from `from` reach `to` right now (ignoring crashed nodes)? */
  canReach(from: NodeId, to: NodeId): boolean {
    switch (this.rule.kind) {
      case 'none':
        return true;
      case 'groups':
        return this.rule.groupOf.get(from) === this.rule.groupOf.get(to);
      case 'custom':
        return this.rule.canReach(from, to);
    }
  }

  /**
   * Install a partition. With groups, any node not listed is put in one
   * extra group together, so `[[1]]` isolates S1 from everyone else.
   */
  setPartition(spec: PartitionSpec): void {
    if (typeof spec === 'function') {
      this.rule = { kind: 'custom', canReach: spec };
      return;
    }

    const groups = spec.map((g) => [...g]);
    const groupOf = new Map<NodeId, number>();
    groups.forEach((group, i) => {
      for (const id of group) {
        if (!this.nodeIds.includes(id)) throw new RangeError(`partition: unknown node ${id}`);
        if (groupOf.has(id)) throw new RangeError(`partition: node ${id} listed in more than one group`);
        groupOf.set(id, i);
      }
    });
    const rest = this.nodeIds.filter((id) => !groupOf.has(id));
    if (rest.length > 0) {
      rest.forEach((id) => groupOf.set(id, groups.length));
      groups.push(rest);
    }
    this.rule = { kind: 'groups', groups, groupOf };
  }

  heal(): void {
    this.rule = { kind: 'none' };
  }

  partitionState(): PartitionState {
    switch (this.rule.kind) {
      case 'none':
        return { kind: 'none' };
      case 'groups':
        return { kind: 'groups', groups: this.rule.groups.map((g) => [...g]) };
      case 'custom':
        return { kind: 'custom' };
    }
  }

  /** The current groups, or null if unpartitioned / custom predicate. */
  groups(): NodeId[][] | null {
    return this.rule.kind === 'groups' ? this.rule.groups.map((g) => [...g]) : null;
  }
}

function byDeliveryOrder(a: NetworkMessage, b: NetworkMessage): number {
  return a.deliverAt - b.deliverAt || a.id - b.id;
}
