import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { NodeId } from '../engine';
import { SimContext } from './context';
import { Simulation } from './simulation';

/** Read ?seed=..&n=.. so a run can be shared by URL. */
function initialSettings(): { seed: number; nodeCount: number } {
  const params = new URLSearchParams(window.location.search);
  const seed = Number(params.get('seed'));
  const n = Number(params.get('n'));
  return {
    seed: Number.isInteger(seed) && seed > 0 ? seed : 1,
    nodeCount: Number.isInteger(n) && n >= 1 && n <= 7 ? n : 3,
  };
}

export function SimulationProvider({ children }: { children: ReactNode }) {
  const [sim] = useState(() => new Simulation({ ...initialSettings(), playing: false }));
  const [highlighted, setHighlighted] = useState<readonly NodeId[]>([]);

  useEffect(() => {
    sim.start();
    return () => sim.stop();
  }, [sim]);

  const value = useMemo(() => ({ sim, highlighted, setHighlighted }), [sim, highlighted]);
  return <SimContext.Provider value={value}>{children}</SimContext.Provider>;
}
