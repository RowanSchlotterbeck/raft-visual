import { useEffect } from 'react';
import { ClientRequests } from './components/ClientRequests';
import { ClusterStage } from './components/ClusterStage';
import { ControlsBar } from './components/ControlsBar';
import { EventLog } from './components/EventLog';
import { Legend } from './components/Legend';
import { SafetyBanner } from './components/SafetyBanner';
import { useCluster } from './sim/hooks';
import { SimulationProvider } from './sim/SimulationProvider';
import './App.css';

export default function App() {
  return (
    <SimulationProvider>
      <Shell />
    </SimulationProvider>
  );
}

function Shell() {
  useKeyboardShortcuts();
  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <h1>Raft, live</h1>
          <p>A deterministic Raft cluster in your browser. Every moving dot is a real RPC.</p>
        </div>
        <SafetyBanner />
      </header>
      <ControlsBar />
      <main className="main">
        <div className="canvas">
          <ClusterStage />
          <Legend />
        </div>
        <aside className="sidebar">
          <div className="sidebar__inner">
            <ClientRequests />
            <EventLog />
          </div>
        </aside>
      </main>
    </div>
  );
}

/** Space: play/pause. Right arrow: step one tick. Ignored while typing. */
function useKeyboardShortcuts() {
  const { sim } = useCluster();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest('input, select, textarea, button') || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === ' ') {
        e.preventDefault();
        sim.togglePlay();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        sim.step();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sim]);
}
