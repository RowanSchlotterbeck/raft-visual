import { createContext } from 'react';
import type { NodeId } from '../engine';
import type { Simulation } from './simulation';

export interface SimContextValue {
  sim: Simulation;
  /** Nodes to emphasize (e.g. while hovering an event in the log). */
  highlighted: readonly NodeId[];
  setHighlighted: (ids: readonly NodeId[]) => void;
}

export const SimContext = createContext<SimContextValue | null>(null);
