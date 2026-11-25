/** A line that goes out and comes back: the round trip the product checks. */
export function LogoMark({ size = 28 }: { size?: number }) {
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} aria-hidden="true" focusable="false">
      <path
        d="M7 11h14.5a5 5 0 0 1 0 10H11"
        fill="none"
        stroke="var(--color-route)"
        strokeWidth="3"
        strokeLinecap="round"
      />
      <path
        d="M14 17.5 10.5 21l3.5 3.5"
        fill="none"
        stroke="var(--color-route)"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="7" cy="11" r="2.6" fill="var(--color-text)" />
    </svg>
  );
}

export function Wordmark() {
  return (
    <span className="inline-flex items-center gap-2.5">
      <LogoMark />
      <span className="font-display text-[26px] leading-none font-extrabold">ReturnTrip</span>
    </span>
  );
}
