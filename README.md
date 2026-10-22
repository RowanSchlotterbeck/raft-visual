# Raft, visualized

A browser-based teaching tool for the Raft consensus algorithm.

So far this repo contains the **simulation engine** (`src/engine/`): a
deterministic, event-sourced simulation of a Raft cluster that follows
Figure 2 of the Raft paper. It's pure TypeScript: no DOM, no real timers, and no
implicit randomness. Time only advances when you call `tick()`, and all randomness
comes from a seeded RNG, so every run can be replayed exactly. The UI (React)
comes later.

```ts
import { createCluster } from './src/engine';

const cluster = createCluster({ nodeCount: 5, seed: 42 });
cluster.tick(100);                                   // returns the events emitted
cluster.clientWrite({ op: 'set', key: 'x', value: '1' });
cluster.partition([[1, 2]]);                         // {S1,S2} | {S3,S4,S5}
cluster.tick(50);
console.log(cluster.getState());
```

| Module | Role |
| --- | --- |
| `types.ts` | Log entries, RPCs, config, snapshot shapes |
| `events.ts` | The `RaftEvent` union: every state change |
| `rng.ts` | Seeded PRNG (mulberry32) |
| `network.ts` | In-flight messages, delays, partitions |
| `node.ts` | One Raft server: Figure 2, rule by rule |
| `cluster.ts` | Time, fault injection, client requests, `getState()` |
| `invariants.ts` | `SafetyMonitor`: runtime checks of the five Figure 3 properties |
| `format.ts` | One-line text rendering of events |

## Scripts

- `npm test`: run the engine test suite (Vitest)
- `npm run typecheck` / `npm run lint`
- `npm run dev`: Vite dev server (UI is still the template)

ESLint forbids `Math.random`, `Date`, timers, `fetch` and DOM globals inside
`src/engine/`.
