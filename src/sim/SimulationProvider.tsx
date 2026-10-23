import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { NodeId } from '../engine';
import { SimContext } from './context';
import { Simulation } from './simulation';
import { readRunFromUrl, writeRunToUrl } from './url';

export function SimulationProvider({ children }: { children: ReactNode }) {
  const [sim] = useState(() => new Simulation({ ...readRunFromUrl(), playing: false }));
  const [highlighted, setHighlighted] = useState<readonly NodeId[]>([]);

  useEffect(() => {
    // Even on a plain first visit, put the run in the URL so it can be shared as is.
    const { seed, nodeCount } = sim.getView();
    writeRunToUrl(seed, nodeCount);
    sim.start();
    return () => sim.stop();
  }, [sim]);

  const value = useMemo(() => ({ sim, highlighted, setHighlighted }), [sim, highlighted]);
  return <SimContext.Provider value={value}>{children}</SimContext.Provider>;
}
