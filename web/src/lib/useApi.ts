"use client";

import { useEffect, useState } from "react";
import type { ApiResult } from "./api";

export type ApiState<T> =
  | { status: "loading" }
  | { status: "ready"; data: T }
  | { status: "empty"; reason: "unset" | "unreachable" | "bad-response" | "empty" };

/** Client-only fetch; initial render is always "loading" so SSR matches. */
export function useApi<T>(loader: () => Promise<ApiResult<T>>, isEmpty: (d: T) => boolean = (d) => Array.isArray(d) && d.length === 0): ApiState<T> {
  const [state, setState] = useState<ApiState<T>>({ status: "loading" });
  useEffect(() => {
    let alive = true;
    loader().then((r) => {
      if (!alive) return;
      if (!r.ok) setState({ status: "empty", reason: r.reason });
      else if (isEmpty(r.data)) setState({ status: "empty", reason: "empty" });
      else setState({ status: "ready", data: r.data });
    }).catch(() => alive && setState({ status: "empty", reason: "unreachable" }));
    return () => { alive = false; };
    // loader functions are module-level constants
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return state;
}

/** Wall clock that only exists after mount (avoids Date in SSR render). */
export function useNow(intervalMs = 30_000): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}
