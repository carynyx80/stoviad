const nf = (opts: Intl.NumberFormatOptions) => new Intl.NumberFormat("en-US", opts);

export function shortAddr(addr: string, head = 4, tail = 4): string {
  if (!addr || addr.length <= head + tail + 1) return addr;
  return `${addr.slice(0, head)}…${addr.slice(-tail)}`;
}

export function fmtSol(v: number | null | undefined, digits = 3): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return nf({ maximumFractionDigits: digits, minimumFractionDigits: v === 0 ? 0 : Math.min(2, digits) }).format(v);
}

export function fmtUsd(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return v >= 100_000 ? `$${compact(v)}` : `$${nf({ maximumFractionDigits: 0 }).format(v)}`;
}

export function fmtNum(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return v >= 10_000 ? compact(v) : nf({ maximumFractionDigits: 1 }).format(v);
}

/** Deterministic compact format (Intl "compact" differs between Node and browsers -> hydration mismatch). */
function compact(v: number): string {
  const units: [number, string][] = [[1e12, "T"], [1e9, "B"], [1e6, "M"], [1e3, "K"]];
  for (const [n, u] of units) {
    if (Math.abs(v) >= n) {
      const r = Math.round((v / n) * 10) / 10;
      return `${r % 1 === 0 ? r.toFixed(0) : r.toFixed(1)}${u}`;
    }
  }
  return nf({ maximumFractionDigits: 1 }).format(v);
}

/** Only call client-side (after data fetch), never during SSR render. */
export function fmtDeadline(v: string | number | null | undefined, now: number): string {
  if (v == null) return "—";
  const t = typeof v === "number" ? (v < 1e12 ? v * 1000 : v) : Date.parse(v);
  if (!Number.isFinite(t)) return "—";
  const diff = t - now;
  if (diff <= 0) return "ended";
  const h = Math.floor(diff / 3_600_000);
  if (h >= 48) return `${Math.floor(h / 24)}d left`;
  if (h >= 1) return `${h}h left`;
  return `${Math.max(1, Math.floor(diff / 60_000))}m left`;
}
