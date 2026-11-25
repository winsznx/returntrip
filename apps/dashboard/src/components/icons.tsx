import type { ReactElement } from 'react';

import type { OutcomeIcon } from '../lib/outcomes.ts';

export type IconName =
  | OutcomeIcon
  | 'download'
  | 'external'
  | 'copy'
  | 'play'
  | 'file'
  | 'camera'
  | 'close'
  | 'arrow-left'
  | 'github';

const PATHS: Readonly<Record<IconName, ReactElement>> = {
  check: <path d="M4.5 10.5 8 14l7.5-8" />,
  repaired: (
    <>
      <path d="M3.5 10a6.5 6.5 0 0 1 11.2-4.5L16.5 7" />
      <path d="M16.5 3v4h-4" />
      <path d="m7 11 2 2 4-4.5" />
    </>
  ),
  cross: <path d="m5.5 5.5 9 9m0-9-9 9" />,
  unresolved: (
    <>
      <path d="m5.5 5.5 9 9m0-9-9 9" />
      <circle cx="10" cy="10" r="7.5" />
    </>
  ),
  alert: (
    <>
      <path d="M10 3 18 17H2Z" />
      <path d="M10 8.5v3.5m0 2.5v.01" />
    </>
  ),
  question: (
    <>
      <circle cx="10" cy="10" r="7.5" />
      <path d="M8 8a2 2 0 1 1 2.8 1.8c-.5.3-.8.7-.8 1.2v.5m0 2.5v.01" />
    </>
  ),
  stop: <rect x="5" y="5" width="10" height="10" rx="1.5" />,
  pending: (
    <>
      <circle cx="10" cy="10" r="7.5" />
      <path d="M10 6v4l2.5 2" />
    </>
  ),
  download: (
    <>
      <path d="M10 3v10m-4-4 4 4 4-4" />
      <path d="M4 16h12" />
    </>
  ),
  external: (
    <>
      <path d="M11 4h5v5m0-5-7 7" />
      <path d="M14 12v4H4V6h4" />
    </>
  ),
  copy: (
    <>
      <rect x="7" y="7" width="9" height="9" rx="1.5" />
      <path d="M13 7V4H4v9h3" />
    </>
  ),
  play: <path d="M7 4.5v11l9-5.5Z" />,
  file: (
    <>
      <path d="M5 2.5h6l4 4v11H5Z" />
      <path d="M11 2.5v4h4" />
    </>
  ),
  camera: (
    <>
      <rect x="2.5" y="5.5" width="15" height="11" rx="1.5" />
      <circle cx="10" cy="11" r="3" />
      <path d="M7 5.5 8 3.5h4l1 2" />
    </>
  ),
  close: <path d="m5 5 10 10m0-10L5 15" />,
  'arrow-left': <path d="M16 10H4m5-5-5 5 5 5" />,
  github: (
    <path d="M10 2a8 8 0 0 0-2.5 15.6c.4 0 .5-.2.5-.4v-1.5c-2.2.5-2.7-1-2.7-1-.4-.9-.9-1.2-.9-1.2-.7-.5.1-.5.1-.5.8.1 1.2.8 1.2.8.7 1.2 1.9.9 2.3.7.1-.5.3-.9.5-1.1-1.8-.2-3.6-.9-3.6-4 0-.9.3-1.6.8-2.1-.1-.2-.4-1 .1-2.1 0 0 .7-.2 2.2.8a7.6 7.6 0 0 1 4 0c1.5-1 2.2-.8 2.2-.8.4 1.1.2 1.9.1 2.1.5.6.8 1.3.8 2.1 0 3.1-1.9 3.8-3.6 4 .3.3.6.8.6 1.5v2.2c0 .2.1.5.6.4A8 8 0 0 0 10 2Z" />
  ),
};

export function Icon({ name, size = 18, className }: { name: IconName; size?: number; className?: string }) {
  const filled = name === 'play' || name === 'github';
  return (
    <svg
      viewBox="0 0 20 20"
      width={size}
      height={size}
      fill={filled ? 'currentColor' : 'none'}
      stroke={filled ? 'none' : 'currentColor'}
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      {PATHS[name]}
    </svg>
  );
}
