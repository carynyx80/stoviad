"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { LAMPORTS } from "./resolver";

export type Load<T> = { status: "loading" } | { status: "ready"; data: T } | { status: "error"; message: string };

/**
 * Client-only fetch with optional polling. First render is always "loading" (SSR-safe).
 * Errors are kept in state, never logged. A failed refresh keeps the last good data.
 */
export function useResolver<T>(loader: (() => Promise<T>) | null, deps: unknown[] = [], pollMs = 0): Load<T> & { reload: () => void } {
  const [state, setState] = useState<Load<T>>({ status: "loading" });
  const [tick, setTick] = useState(0);
  const ref = useRef(loader);
  ref.current = loader;
  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let alive = true;
    const fn = ref.current;
    if (!fn) return;
    fn()
      .then((data) => alive && setState({ status: "ready", data }))
      .catch((e: unknown) => {
        if (!alive) return;
        setState((s) => (s.status === "ready" ? s : { status: "error", message: (e as Error)?.message || "Request failed." }));
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, ...deps]);

  useEffect(() => {
    if (!pollMs) return;
    const id = window.setInterval(() => {
      if (typeof document === "undefined" || document.visibilityState === "visible") setTick((t) => t + 1);
    }, pollMs);
    return () => window.clearInterval(id);
  }, [pollMs]);

  return { ...state, reload } as Load<T> & { reload: () => void };
}

/** "2d 4h", "3h 12m", "4m 10s", or "now". */
export function fmtCountdown(targetMs: number | null, now: number | null): string {
  if (targetMs == null || now == null) return "—";
  let s = Math.floor((targetMs - now) / 1000);
  if (s <= 0) return "now";
  const d = Math.floor(s / 86400);
  s -= d * 86400;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

/** Lamports -> "1.2345" (exact digits, no float drift for display). */
export function fmtLamports(l: bigint | null | undefined, digits = 4): string {
  if (l == null) return "—";
  const neg = l < BigInt(0);
  const abs = neg ? -l : l;
  const L = BigInt(LAMPORTS);
  const whole = abs / L;
  const frac = (abs % L).toString().padStart(9, "0").slice(0, digits).replace(/0+$/, "");
  const w = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${neg ? "-" : ""}${w}${frac ? `.${frac}` : ""}`;
}

/** Exact lamports from a decimal SOL string; null if invalid. */
export function parseSolInput(input: string): bigint | null {
  const s = input.trim().replace(",", ".");
  if (!/^\d{0,9}(\.\d{0,9})?$/.test(s) || s === "" || s === ".") return null;
  const [whole, frac = ""] = s.split(".");
  return BigInt(whole || "0") * BigInt(LAMPORTS) + BigInt((frac + "000000000").slice(0, 9));
}
