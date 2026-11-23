import { TICKER } from "./data";

function Item({ t }: { t: (typeof TICKER)[number] }) {
  const color =
    t.status === "SURVIVED" ? "text-gold" : t.status === "DEAD" ? "text-blood-hot" : "text-bone";
  return (
    <span className="flex items-center gap-3 px-6 whitespace-nowrap">
      <span className="font-display font-bold text-bone tracking-tight">{t.sym}</span>
      <span
        className={`font-mono text-[11px] tracking-[0.2em] px-2 py-0.5 border ${
          t.status === "SURVIVED"
            ? "border-gold text-gold"
            : t.status === "DEAD"
              ? "border-blood-hot text-blood-hot line-through decoration-1"
              : "border-bone-dim text-bone-dim"
        }`}
      >
        {t.status === "LIVE" ? "ALIVE" : t.status}
      </span>
      <span className={`font-mono text-xs ${color}`}>{t.pct}</span>
      <span className="font-mono text-[11px] text-bone-dim">{t.age}</span>
      <span className="text-line ml-3">&#9670;</span>
    </span>
  );
}

export default function Ticker({ reverse = false, tone = "dark" }: { reverse?: boolean; tone?: "dark" | "gold" }) {
  const row = [...TICKER, ...TICKER];
  return (
    <div
      className={`relative overflow-hidden border-y ${
        tone === "gold" ? "bg-gold border-ink text-ink" : "bg-ink-2 border-line"
      } py-3`}
      aria-label="Live token survival feed"
    >
      <div className={`flex w-max ${reverse ? "st-marquee-rev" : "st-marquee"}`}>
        {row.map((t, i) =>
          tone === "gold" ? (
            <span key={i} className="flex items-center gap-3 px-6 whitespace-nowrap font-display font-extrabold uppercase text-ink text-lg tracking-tight">
              {t.sym}
              <span className="font-serif italic font-normal normal-case">
                {t.status === "DEAD" ? "rugged" : t.status === "SURVIVED" ? "survived" : "breathing"}
              </span>
              <span>&#10022;</span>
            </span>
          ) : (
            <Item key={i} t={t} />
          ),
        )}
      </div>
      <div className="pointer-events-none absolute inset-y-0 left-0 w-16 bg-gradient-to-r from-ink to-transparent" />
      <div className="pointer-events-none absolute inset-y-0 right-0 w-16 bg-gradient-to-l from-ink to-transparent" />
    </div>
  );
}
