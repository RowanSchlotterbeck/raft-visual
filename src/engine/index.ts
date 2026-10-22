/**
 * Public API of the Raft simulation engine. Pure TypeScript: no DOM, no
 * timers, no implicit randomness. Time only moves when you call tick().
 */
export { createCluster, RaftCluster, DEFAULT_CONFIG, type ClientWriteOptions } from './cluster';
export { SafetyMonitor, type SafetyProperty, type SafetyViolation } from './invariants';
export { createRng, type Rng } from './rng';
export { formatEvent } from './format';
export type * from './events';
export * from './types';
