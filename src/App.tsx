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

  const closeTour = useCallback(() => {
    writeFlag(TUTORIAL_SEEN_KEY);
    setTourOpen(false);
  }, []);

  useEffect(() => {
    // Back/forward can change the view. The tour only makes sense on the
    // simulator, so leaving it ends the tour (and counts as having seen it).
    const onHash = () => {
      const next = viewFromHash();
      if (next === 'learn') {
        sim.pause();
        closeTour();
      }
      setView(next);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [sim, closeTour]);

  useBlurButtonsAfterMouseClick();

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

  useKeyboardShortcuts(view === 'sim' && !tourOpen);
  const showTour = tourOpen && view === 'sim';

  return (
    <>
      {/* While the tour is open, the page behind it can't be clicked or tabbed into. */}
      <div className="app" inert={showTour}>
        <header className="topbar">
          <div className="brand">
            <h1>Raft, live</h1>
            <p>A deterministic Raft cluster in your browser. Every moving dot is a real message.</p>
          </div>
          <nav className="topnav" data-tour="help" aria-label="Sections">
            <div className="tabs">
              <a
                href="#"
                className="tab"
                aria-current={view === 'sim' ? 'page' : undefined}
                onClick={(e) => {
                  e.preventDefault();
                  go('sim');
                }}
              >
                Simulator
              </a>
              <a
                href="#learn"
                className="tab"
                aria-current={view === 'learn' ? 'page' : undefined}
                onClick={(e) => {
                  e.preventDefault();
                  go('learn');
                }}
              >
                Learn more
              </a>
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
      </div>
      {showTour && <Tutorial onClose={closeTour} />}
    </>
  );
}

/**
 * A mouse click leaves focus on the button, so the next Space would press it
 * again (e.g. send another write) instead of playing. Drop focus after
 * mouse/touch clicks; keyboard presses (detail === 0) keep it.
 */
function useBlurButtonsAfterMouseClick() {
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.detail === 0) return;
      const el = (e.target as Element | null)?.closest('button, input[type="checkbox"], a.tab');
      if (el instanceof HTMLElement) el.blur();
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, []);
}

/**
 * Space: play/pause. Right arrow: step one tick. Ignored while a control that
 * uses those keys has focus (text fields, selects, buttons, checkboxes); the
 * speed slider only uses the arrows, so Space still plays from there.
 */
function useKeyboardShortcuts(enabled: boolean) {
  const { sim } = useCluster();
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const onSlider = el.matches('input[type="range"]');
      if (!onSlider && el.closest('input, select, textarea, button, a')) return;
      if (onSlider && e.key !== ' ') return;
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
