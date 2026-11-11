type P = { className?: string };
const base = { fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

export const IconPlus = ({ className = "size-4" }: P) => (
  <svg viewBox="0 0 16 16" className={className} aria-hidden {...base}>
    <path d="M8 3.5v9M3.5 8h9" />
  </svg>
);

export const IconClock = ({ className = "size-3.5" }: P) => (
  <svg viewBox="0 0 16 16" className={className} aria-hidden {...base}>
    <circle cx="8" cy="8" r="5.75" />
    <path d="M8 5v3.2l2 1.3" />
  </svg>
);

export const IconGlobe = ({ className = "size-3.5" }: P) => (
  <svg viewBox="0 0 16 16" className={className} aria-hidden {...base}>
    <circle cx="8" cy="8" r="5.75" />
    <path d="M2.5 8h11M8 2.25c1.6 1.6 2.4 3.5 2.4 5.75S9.6 12.15 8 13.75M8 2.25C6.4 3.85 5.6 5.75 5.6 8s.8 4.15 2.4 5.75" />
  </svg>
);

export const IconChevron = ({ className = "size-3.5" }: P) => (
  <svg viewBox="0 0 16 16" className={className} aria-hidden {...base}>
    <path d="M6 4l4 4-4 4" />
  </svg>
);

export const IconChevronsUpDown = ({ className = "size-3.5" }: P) => (
  <svg viewBox="0 0 16 16" className={className} aria-hidden {...base}>
    <path d="M5 6l3-3 3 3M5 10l3 3 3-3" />
  </svg>
);

export const IconMenu = ({ className = "size-4.5" }: P) => (
  <svg viewBox="0 0 16 16" className={className} aria-hidden {...base}>
    <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" />
  </svg>
);

export const IconArrowUp = ({ className = "size-4" }: P) => (
  <svg viewBox="0 0 16 16" className={className} aria-hidden {...base} strokeWidth={1.9}>
    <path d="M8 12.5v-9M4 7.5l4-4 4 4" />
  </svg>
);

export const IconCopy = ({ className = "size-3.5" }: P) => (
  <svg viewBox="0 0 16 16" className={className} aria-hidden {...base}>
    <rect x="5.5" y="5.5" width="8" height="8" rx="1.75" />
    <path d="M10.5 5.5V3.75A1.25 1.25 0 0 0 9.25 2.5h-5.5A1.25 1.25 0 0 0 2.5 3.75v5.5c0 .69.56 1.25 1.25 1.25H5.5" />
  </svg>
);

export const IconCheck = ({ className = "size-3.5" }: P) => (
  <svg viewBox="0 0 16 16" className={className} aria-hidden {...base} strokeWidth={1.9}>
    <path d="M3.5 8.5l3 3 6-7" />
  </svg>
);

export const LogoMark = ({ className = "size-6" }: P) => (
  <svg viewBox="0 0 24 24" className={className} aria-hidden>
    <rect width="24" height="24" rx="6.5" fill="#f2f2f2" />
    <path d="M6.5 16.5v-9l5.5 6 5.5-6v9" fill="none" stroke="#111" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const IconStop = ({ className = "size-3" }: P) => (
  <svg viewBox="0 0 12 12" className={className} aria-hidden>
    <rect x="1.5" y="1.5" width="9" height="9" rx="1.5" fill="currentColor" />
  </svg>
);

export const IconRefresh = ({ className = "size-3.5" }: P) => (
  <svg viewBox="0 0 16 16" className={className} aria-hidden {...base}>
    <path d="M13 8a5 5 0 1 1-1.46-3.54M13 3v2.5h-2.5" />
  </svg>
);

export const IconAlert = ({ className = "size-3.5" }: P) => (
  <svg viewBox="0 0 16 16" className={className} aria-hidden {...base}>
    <path d="M8 2.5l5.75 10H2.25L8 2.5z" />
    <path d="M8 6.75v2.5M8 11.1v.15" />
  </svg>
);

export const IconTimeline = ({ className = "size-3.5" }: P) => (
  <svg viewBox="0 0 16 16" className={className} aria-hidden {...base}>
    <path d="M2.5 4h5M5 8h6.5M9 12h4.5" />
  </svg>
);
