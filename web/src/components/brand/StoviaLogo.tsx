// Stovia brand: the "split moon" — a red circle divided by an S curve, one side lit.
// Black and red only. Thin ring uses the brighter red so it reads on black.
export const MOON_FILL = "M66 24 A42 42 0 0 1 66 108 A21 21 0 0 1 66 66 A21 21 0 0 0 66 24 Z";

export function StoviaMark({ className = "h-7 w-7", title }: { className?: string; title?: string }) {
  return (
    <svg viewBox="20 20 92 92" className={className} role={title ? "img" : undefined} aria-hidden={title ? undefined : true}>
      {title ? <title>{title}</title> : null}
      <path d={MOON_FILL} fill="#8e0b0b" />
      <circle cx="66" cy="66" r="42" fill="none" stroke="#c4161c" strokeWidth="2.5" />
    </svg>
  );
}

export function StoviaLogo({
  className = "",
  markClassName = "h-7 w-7",
  textClassName = "text-[26px]",
}: {
  className?: string;
  markClassName?: string;
  textClassName?: string;
}) {
  return (
    <span className={`inline-flex items-center gap-2.5 ${className}`} aria-label="Stovia">
      <StoviaMark className={markClassName} />
      <span aria-hidden className={`font-serif leading-none tracking-[0.08em] text-blood-hot ${textClassName}`}>
        Stovia
      </span>
    </span>
  );
}
