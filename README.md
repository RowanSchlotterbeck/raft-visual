# Raft, live

A browser-based teaching tool for the Raft consensus algorithm. It runs a real,
deterministic Raft cluster in the page and draws it live: servers, their
logs and timers, and every message moving between them. You can pause, step,
crash servers, send writes and split the network, and watch Raft recover.

```
npm install
npm run dev
```

A short tour opens on your first visit (reopen it with **Tour** in the header).
**Learn more** explains what the simulation models and links the Raft paper.
The seed and cluster size live in the URL (`?seed=7&n=5`), so a run can be
shared and replayed.

## How it's built

**The engine (`src/engine/`)** is a deterministic, event-sourced simulation of
a Raft cluster that follows Figure 2 of the Raft paper. It's pure TypeScript:
no DOM, no real timers, and no implicit randomness. Time only advances when
you call `tick()`, and all randomness comes from a seeded RNG, so every run can
be replayed exactly.

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

**The UI (React)** only reads the engine; it never reimplements Raft.

| Path | Role |
| --- | --- |
| `src/sim/simulation.ts` | Drives the clock (decides when to call `tick()`), collects events, derives short-lived visual effects |
| `src/sim/hooks.ts`, `SimulationProvider.tsx` | React access to the simulation (`useCluster`, `useVisualTime`) |
| `src/sim/layout.ts` | Where cards sit and where messages travel |
| `src/components/` | Node cards, network layers, controls, event log, tour, Learn more |

## Scripts

- `npm test`: run the test suite (Vitest)
- `npm run typecheck` / `npm run lint`
- `npm run build`: production build into `dist/`
- `npm run dev`: Vite dev server

ESLint forbids `Math.random`, `Date`, timers, `fetch` and DOM globals inside
`src/engine/`.
