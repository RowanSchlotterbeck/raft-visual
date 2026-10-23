/** Small inline icons (stroke = currentColor). */
const base = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
};

export const CrownIcon = () => (
  <svg {...base} fill="currentColor" strokeWidth={1.5}>
    <path d="M3 18h18l-1.6-10.2-5 4.2L12 5l-2.4 7-5-4.2z" />
  </svg>
);

export const PowerIcon = () => (
  <svg {...base}>
    <path d="M12 3v8" />
    <path d="M6.3 6.8a8 8 0 1 0 11.4 0" />
  </svg>
);

export const TimerIcon = () => (
  <svg {...base}>
    <circle cx="12" cy="13" r="8" />
    <path d="M12 9v4l2.5 2" />
    <path d="M9 2h6" />
  </svg>
);

export const PlayIcon = () => (
  <svg {...base} fill="currentColor" strokeWidth={0}>
    <path d="M7 4.5v15l13-7.5z" />
  </svg>
);

export const PauseIcon = () => (
  <svg {...base} fill="currentColor" strokeWidth={0}>
    <rect x="6" y="4.5" width="4" height="15" rx="1" />
    <rect x="14" y="4.5" width="4" height="15" rx="1" />
  </svg>
);

export const StepIcon = () => (
  <svg {...base} fill="currentColor" strokeWidth={0}>
    <path d="M5 5v14l10-7z" />
    <rect x="16" y="5" width="3" height="14" rx="1" />
  </svg>
);

export const ShieldIcon = () => (
  <svg {...base}>
    <path d="M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6z" />
    <path d="M8.5 12l2.5 2.5 4.5-5" />
  </svg>
);

export const AlertIcon = () => (
  <svg {...base}>
    <path d="M12 3l10 18H2z" />
    <path d="M12 10v5" />
    <path d="M12 18h.01" />
  </svg>
);
