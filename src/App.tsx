import { useCallback, useEffect, useState } from 'react';
import { ClientRequests } from './components/ClientRequests';
import { ClusterStage } from './components/ClusterStage';
import { ControlsBar } from './components/ControlsBar';
import { EventLog } from './components/EventLog';
import { LearnMore } from './components/LearnMore';
import { Legend } from './components/Legend';
import { Tutorial } from './components/Tutorial';
import { useCluster } from './sim/hooks';
import { SimulationProvider } from './sim/SimulationProvider';
import { readFlag, TUTORIAL_SEEN_KEY, writeFlag } from './storage';
import './App.css';

export default function App() {
  return (
    <SimulationProvider>
      <Shell />
    </SimulationProvider>
  );
}

type View = 'sim' | 'learn';

/** The Learn more view lives at #learn so it can be linked and the back button works. */
function viewFromHash(): View {
  return window.location.hash === '#learn' ? 'learn' : 'sim';
}

function Shell() {
  const { sim } = useCluster();
  const [view, setView] = useState<View>(viewFromHash);
  // First visit: open the tour once; after that it only opens from the Tour button.
  const [tourOpen, setTourOpen] = useState(() => !readFlag(TUTORIAL_SEEN_KEY));

  useEffect(() => {
    const onHash = () => setView(viewFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const go = (next: View) => {
    if (next === view) return;
    // Pause while reading, so nothing happens unseen.
    if (next === 'learn') sim.pause();
    const url = new URL(window.location.href);
    url.hash = next === 'learn' ? 'learn' : '';
    window.history.pushState(null, '', url);
    setView(next);
  };

  const openTour = () => {
    // The tour points at the simulator, so show it first.
    go('sim');
    setTourOpen(true);
  };
  const closeTour = useCallback(() => {
    writeFlag(TUTORIAL_SEEN_KEY);
    setTourOpen(false);
  }, []);

  useKeyboardShortcuts(view === 'sim' && !tourOpen);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <h1>Raft, live</h1>
          <p>A deterministic Raft cluster in your browser. Every moving dot is a real message.</p>
        </div>
        <nav className="topnav" data-tour="help" aria-label="Sections">
          <div className="tabs" role="tablist">
            <button role="tab" aria-selected={view === 'sim'} className="tab" onClick={() => go('sim')}>
              Simulator
            </button>
            <button role="tab" aria-selected={view === 'learn'} className="tab" onClick={() => go('learn')}>
              Learn more
            </button>
          </div>
          <button className="btn tour-btn" onClick={openTour} title="How to use this page">
            <span className="tour-btn__mark" aria-hidden>
              ?
            </span>
            Tour
          </button>
        </nav>
      </header>

      {view === 'sim' ? (
        <>
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
        </>
      ) : (
        <main>
          <LearnMore />
        </main>
      )}

      {tourOpen && view === 'sim' && <Tutorial onClose={closeTour} />}
    </div>
  );
}

/** Space: play/pause. Right arrow: step one tick. Ignored while typing or when disabled. */
function useKeyboardShortcuts(enabled: boolean) {
  const { sim } = useCluster();
  useEffect(() => {
    if (!enabled) return;
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
  }, [sim, enabled]);
}
