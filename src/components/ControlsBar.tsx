import { useState } from 'react';
import { MAX_NODES, type NodeId } from '../engine';
import { useCluster } from '../sim/hooks';
import { SPEEDS } from '../sim/simulation';
import { PauseIcon, PlayIcon, StepIcon } from './icons';
import './ControlsBar.css';

const KEYS = ['x', 'y', 'z'] as const;

/** The raw levers: clock, run setup, client writes, and the network split. */
export function ControlsBar() {
  return (
    <div className="controls" role="toolbar" aria-label="Simulation controls">
      <Transport />
      <RunSetup />
      <ClientWrite />
      <PartitionControl />
    </div>
  );
}

function Transport() {
  const { view, sim } = useCluster();
  const speedIndex = Math.max(0, SPEEDS.findIndex((s) => s === view.tps));
  return (
    <section className="ctl" data-tour="transport">
      <button className="btn btn--primary" onClick={() => sim.togglePlay()} title="Play / pause (space)">
        {view.playing ? <PauseIcon /> : <PlayIcon />}
        {view.playing ? 'Pause' : 'Play'}
      </button>
      <button className="btn" onClick={() => sim.step()} title="Advance one tick (→)">
        <StepIcon /> Step
      </button>
      <label className="ctl__speed">
        <span className="eyebrow">speed</span>
        <input
          type="range"
          min={0}
          max={SPEEDS.length - 1}
          value={speedIndex}
          onChange={(e) => sim.setSpeed(SPEEDS[Number(e.target.value)])}
          aria-valuetext={`${view.tps} ticks per second`}
        />
        <span className="mono ctl__value">{view.tps}/s</span>
      </label>
      <span className="ctl__clock" title="Simulated time">
        <span className="eyebrow">tick</span>
        <span className="mono">{view.snapshot.time}</span>
      </span>
    </section>
  );
}

function RunSetup() {
  const { view, sim } = useCluster();
  const [seedText, setSeedText] = useState(String(view.seed));

  const restart = (seed: number, nodeCount: number) => {
    sim.restart(seed, nodeCount);
    setSeedText(String(seed));
    // Make the run shareable: ?seed=42&n=5 reproduces it.
    const url = new URL(window.location.href);
    url.searchParams.set('seed', String(seed));
    url.searchParams.set('n', String(nodeCount));
    window.history.replaceState(null, '', url);
  };
  const parsedSeed = Number(seedText);
  const seedValid = Number.isInteger(parsedSeed) && parsedSeed > 0;

  return (
    <section className="ctl">
      <span className="eyebrow">run</span>
      <label className="ctl__field">
        <span>seed</span>
        <input
          className="input"
          inputMode="numeric"
          value={seedText}
          onChange={(e) => setSeedText(e.target.value.replace(/\D/g, ''))}
          onKeyDown={(e) => e.key === 'Enter' && seedValid && restart(parsedSeed, view.nodeCount)}
          style={{ width: 64 }}
          aria-invalid={!seedValid}
        />
      </label>
      <label className="ctl__field">
        <span>nodes</span>
        <select
          className="input"
          value={view.nodeCount}
          onChange={(e) => restart(seedValid ? parsedSeed : view.seed, Number(e.target.value))}
        >
          {Array.from({ length: MAX_NODES }, (_, i) => i + 1).map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </label>
      <button className="btn" disabled={!seedValid} onClick={() => restart(parsedSeed, view.nodeCount)}>
        Restart
      </button>
    </section>
  );
}

function ClientWrite() {
  const { view, sim } = useCluster();
  const [key, setKey] = useState<string>('x');
  const [target, setTarget] = useState<string>('leader');
  const ids = view.snapshot.nodes.map((n) => n.id);
  const via = target === 'leader' || !ids.includes(Number(target)) ? undefined : Number(target);

  return (
    <section className="ctl" data-tour="levers">
      <span className="eyebrow">client</span>
      <label className="ctl__field">
        <span>set</span>
        <select className="input" value={key} onChange={(e) => setKey(e.target.value)}>
          {KEYS.map((k) => (
            <option key={k}>{k}</option>
          ))}
        </select>
      </label>
      <label className="ctl__field">
        <span>to</span>
        <select className="input" value={via === undefined ? 'leader' : String(via)} onChange={(e) => setTarget(e.target.value)}>
          <option value="leader">leader</option>
          {ids.map((id) => (
            <option key={id} value={id}>
              S{id}
            </option>
          ))}
        </select>
      </label>
      <button className="btn" onClick={() => sim.write(key, via)}>
        Send write
      </button>
    </section>
  );
}

function PartitionControl() {
  const { view, sim } = useCluster();
  const ids = view.snapshot.nodes.map((n) => n.id);
  const sideB = view.sideB;
  const toggle = (id: NodeId) => {
    const next = sideB.includes(id) ? sideB.filter((x) => x !== id) : [...sideB, id];
    sim.setSideB(next);
  };
  return (
    <section className="ctl" data-tour="levers" aria-label="Network partition">
      <span className="eyebrow">split network</span>
      <div className="chips">
        {ids.map((id) => (
          <button
            key={id}
            className="chip mono"
            aria-pressed={sideB.includes(id)}
            onClick={() => toggle(id)}
            // Can't move every node to side B: that's no split at all.
            disabled={!sideB.includes(id) && sideB.length === ids.length - 1}
            title={sideB.includes(id) ? `Move S${id} back to side A` : `Cut S${id} off onto side B`}
          >
            S{id}
          </button>
        ))}
      </div>
      <button className="btn" onClick={() => sim.heal()} disabled={sideB.length === 0}>
        Heal
      </button>
    </section>
  );
}
