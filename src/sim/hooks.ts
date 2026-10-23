import { useContext, useSyncExternalStore } from 'react';
import { SimContext, type SimContextValue } from './context';
import type { SimView } from './simulation';

function useSimContext(): SimContextValue {
  const ctx = useContext(SimContext);
  if (!ctx) throw new Error('useSim must be used inside <SimulationProvider>');
  return ctx;
}

/** The simulation's current view (re-renders once per tick or command) plus its levers. */
export function useCluster(): { view: SimView } & SimContextValue {
  const ctx = useSimContext();
  const view = useSyncExternalStore(ctx.sim.subscribe, ctx.sim.getView);
  return { view, ...ctx };
}

/** Fractional simulated time; re-renders every animation frame while playing. */
export function useVisualTime(): number {
  const { sim } = useSimContext();
  return useSyncExternalStore(sim.subscribeFrame, sim.getVisualTime);
}

/** Tracks the user's reduced-motion preference. */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribeReducedMotion, getReducedMotion);
}

const motionQuery = typeof window !== 'undefined' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
function subscribeReducedMotion(cb: () => void): () => void {
  motionQuery?.addEventListener('change', cb);
  return () => motionQuery?.removeEventListener('change', cb);
}
function getReducedMotion(): boolean {
  return motionQuery?.matches ?? false;
}
