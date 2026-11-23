// "Powered by Helius Privacy Rings" badge. Links to the Helius Privacy Rings docs.
const HREF = "https://www.helius.dev/docs/privacy";

function RingIcon({ className = "h-3.5 w-3.5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden>
      <circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" strokeWidth="2" />
      <circle cx="12" cy="12" r="3.2" fill="currentColor" />
    </svg>
  );
}

export default function PoweredByHelius({
  variant = "pill",
  className = "",
}: {
  variant?: "pill" | "inline";
  className?: string;
}) {
  if (variant === "inline") {
    return (
      <a
        href={HREF}
        target="_blank"
        rel="noopener noreferrer"
        className={`inline-flex items-center gap-2 text-bone-dim transition-colors hover:text-bone ${className}`}
      >
        <RingIcon className="h-3 w-3 text-blood-hot" />
        POWERED BY <span className="text-blood-hot">HELIUS PRIVACY RINGS</span>
      </a>
    );
  }
  return (
    <a
      href={HREF}
      target="_blank"
      rel="noopener noreferrer"
      className={`group inline-flex items-center gap-2.5 rounded-full border border-blood-hot/50 bg-blood/15 py-1.5 pl-2 pr-3.5 font-mono text-[10px] uppercase tracking-[0.22em] text-bone transition-colors hover:border-blood-hot hover:bg-blood/25 sm:text-[11px] ${className}`}
    >
      <span className="grid h-5 w-5 place-items-center rounded-full bg-blood text-bone">
        <RingIcon className="h-3 w-3" />
      </span>
      <span>
        Powered by <span className="font-semibold text-blood-hot">Helius Privacy Rings</span>
      </span>
      <span aria-hidden className="text-blood-hot transition-transform group-hover:translate-x-0.5">→</span>
    </a>
  );
}
