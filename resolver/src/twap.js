// Time-weighted average market cap. Pure; all values are BigInt (lamports, unix seconds).
//
// Step-hold integration: a sample's mcap is held until the next sample (or the deadline), so
//   cum += lastMcap * (min(t, deadline) - lastTs)
// and TWAP(t) = cum(t) / (t - startTs). A gap in sampling (worker down, RPC error) holds the last
// value across the gap. Samples taken after the deadline never count.

export function twapInit(ts, mcap) {
  const t = BigInt(ts);
  return { startTs: t, lastTs: t, lastMcap: BigInt(mcap), cum: 0n, samples: 1 };
}

/** Returns a NEW state with a sample at `ts` (mcap may be null = "no new reading, just advance time"). */
export function twapAccumulate(state, ts, mcap, deadline) {
  const end = BigInt(deadline);
  const t = BigInt(ts) < end ? BigInt(ts) : end;
  const s = { ...state };
  if (t > s.lastTs) {
    s.cum += s.lastMcap * (t - s.lastTs);
    s.lastTs = t;
  }
  if (mcap !== null && mcap !== undefined && BigInt(ts) <= end) {
    s.lastMcap = BigInt(mcap);
    s.samples += 1;
  }
  return s;
}

/** TWAP over [startTs, min(asOf, deadline)] (integer floor). Includes the open interval since the last sample. */
export function twapValue(state, asOf, deadline) {
  const s = twapAccumulate(state, asOf, null, deadline);
  const span = s.lastTs - s.startTs;
  if (span <= 0n) return s.lastMcap;
  return s.cum / span;
}
