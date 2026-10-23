import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { useReducedMotion } from '../sim/hooks';
import './Tutorial.css';

interface Step {
  title: string;
  body: string;
  /** CSS selector of the element(s) to spotlight; none = centered card. */
  target?: string;
  /** Spotlight every match (as one box) instead of just the first. */
  all?: boolean;
}

/** How to read and drive the page. Raft itself is covered in Learn more. */
const STEPS: Step[] = [
  {
    title: 'Welcome to Raft, live',
    body: 'This page runs a real Raft cluster in your browser: a few servers that elect a leader and keep a shared log in sync. This short tour shows how to read the screen and how to drive it.',
  },
  {
    target: '[data-tour="node"]',
    title: 'Each card is one server',
    body: 'The badge shows its role: follower, candidate (pulsing violet) or leader (glowing amber). The term counts elections, so watch it go up when a leader is lost.',
  },
  {
    target: '[data-tour="timer"]',
    title: 'The election timer',
    body: 'This bar fills while a follower hears nothing from a leader. When it’s full, the server starts an election. Each heartbeat from the leader resets it.',
  },
  {
    target: '[data-tour="log"]',
    title: 'The log',
    body: 'One cell per command, labeled with the term it was written in. Outlined cells are stored but not safe yet. Filled cells are committed: a majority has them.',
  },
  {
    target: '[data-tour="stage"]',
    title: 'Circles are messages',
    body: 'Violet circles ask for votes. Amber ones carry log entries and heartbeats. Green and red are yes and no replies. A circle that fades at a red ✕ never arrived.',
  },
  {
    target: '[data-tour="transport"]',
    title: 'You control time',
    body: 'Play, pause, or step one tick at a time, and drag the slider to change speed. Shortcuts: space to play or pause, → to step.',
  },
  {
    target: '[data-tour="levers"]',
    all: true,
    title: 'Now break things',
    body: 'Send a client write, or split the network into two sides. Each card also has Kill and Time out buttons. Then watch the cluster recover.',
  },
  {
    target: '[data-tour="help"]',
    title: 'You’re ready',
    body: 'Press Play to start the clock. Reopen this tour any time with the Tour button, or open Learn more to see what the simulation models.',
  },
];

interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}

const PAD = 8;
const GAP = 14;
const MARGIN = 16;

/** The spotlit area for a step, in viewport coordinates, or null for none. */
function measureTarget(step: Step): Box | null {
  if (!step.target) return null;
  const els = step.all
    ? [...document.querySelectorAll(step.target)]
    : [document.querySelector(step.target)].filter((e): e is Element => e !== null);
  if (els.length === 0) return null;
  const rects = els.map((e) => e.getBoundingClientRect());
  const top = Math.min(...rects.map((r) => r.top)) - PAD;
  const left = Math.min(...rects.map((r) => r.left)) - PAD;
  const bottom = Math.max(...rects.map((r) => r.bottom)) + PAD;
  const right = Math.max(...rects.map((r) => r.right)) + PAD;
  return { top, left, width: right - left, height: bottom - top };
}

/** Put the callout below the target, else above, else at the bottom of the screen. */
function placeCard(target: Box | null, card: { width: number; height: number }): CSSProperties {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  if (!target) return { top: Math.max(MARGIN, (vh - card.height) / 2), left: Math.max(MARGIN, (vw - card.width) / 2) };
  const left = Math.min(Math.max(MARGIN, target.left), vw - card.width - MARGIN);
  const below = target.top + target.height + GAP;
  if (below + card.height <= vh - MARGIN) return { top: below, left };
  const above = target.top - GAP - card.height;
  if (above >= MARGIN) return { top: above, left };
  return { top: vh - card.height - MARGIN, left: Math.max(MARGIN, (vw - card.width) / 2) };
}

const sameBox = (a: Box | null, b: Box | null) =>
  a === b ||
  (a !== null &&
    b !== null &&
    Math.abs(a.top - b.top) < 0.5 &&
    Math.abs(a.left - b.left) < 0.5 &&
    Math.abs(a.width - b.width) < 0.5 &&
    Math.abs(a.height - b.height) < 0.5);

/**
 * A click-through tour that spotlights the real UI. Mount it to open it;
 * `onClose` is called on Skip, Esc, or Finish.
 */
export function Tutorial({ onClose }: { onClose: () => void }) {
  const [index, setIndex] = useState(0);
  const step = STEPS[index];
  const isLast = index === STEPS.length - 1;
  const reduced = useReducedMotion();

  const cardRef = useRef<HTMLDivElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);
  const [hole, setHole] = useState<Box | null>(null);
  const [cardSize, setCardSize] = useState({ width: 360, height: 200 });

  // Bring the target into view when the step changes.
  useLayoutEffect(() => {
    const el = step.target ? document.querySelector(step.target) : null;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.top < 0 || r.bottom > window.innerHeight) {
      el.scrollIntoView({ block: 'center', behavior: reduced ? 'auto' : 'smooth' });
    }
  }, [step, reduced]);

  // Track the target and card every frame (scrolling, resizing, layout shifts).
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      const box = measureTarget(step);
      setHole((prev) => (sameBox(prev, box) ? prev : box));
      const card = cardRef.current;
      if (card) {
        const { width, height } = card.getBoundingClientRect();
        setCardSize((prev) => (prev.width === width && prev.height === height ? prev : { width, height }));
      }
      raf = requestAnimationFrame(loop);
    };
    loop();
    return () => cancelAnimationFrame(raf);
  }, [step]);

  useEffect(() => nextRef.current?.focus(), [index]);

  // Arrow keys and Esc drive the tour. Capture phase, so the page's own
  // shortcuts (space, →) don't also fire underneath the dialog.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowRight') setIndex((i) => Math.min(i + 1, STEPS.length - 1));
      else if (e.key === 'ArrowLeft') setIndex((i) => Math.max(i - 1, 0));
      else if (e.key !== ' ' && e.key !== 'Enter' && e.key !== 'Tab') return;
      e.stopPropagation();
      if (e.key.startsWith('Arrow')) e.preventDefault();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return (
    <div className="tour" role="dialog" aria-modal="true" aria-labelledby="tour-title" aria-describedby="tour-body">
      {hole ? <div className="tour__hole" style={hole} /> : <div className="tour__backdrop" />}
      <div className="tour__card" ref={cardRef} style={placeCard(hole, cardSize)}>
        <div className="tour__progress">
          <span className="eyebrow">
            {index + 1} of {STEPS.length}
          </span>
          <span className="tour__dots" aria-hidden>
            {STEPS.map((_, i) => (
              <span key={i} className={i === index ? 'is-current' : i < index ? 'is-done' : undefined} />
            ))}
          </span>
        </div>
        <h2 id="tour-title">{step.title}</h2>
        <p id="tour-body">{step.body}</p>
        <footer className="tour__actions">
          {!isLast && (
            <button className="btn btn--ghost" onClick={onClose}>
              Skip tour
            </button>
          )}
          <span className="tour__spacer" />
          {index > 0 && (
            <button className="btn" onClick={() => setIndex(index - 1)}>
              Back
            </button>
          )}
          <button
            ref={nextRef}
            className="btn btn--primary"
            onClick={() => (isLast ? onClose() : setIndex(index + 1))}
          >
            {isLast ? 'Done' : 'Next'}
          </button>
        </footer>
      </div>
    </div>
  );
}
