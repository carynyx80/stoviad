// Read models computed from the typed event rows.
// PRIVACY: bet sides are never exposed for bets that have not been revealed.
const LAMPORTS = 1_000_000_000n;
const big = (v) => { try { return BigInt(v ?? 0); } catch { return 0n; } };
const sol = (lamports) => Number(lamports) / Number(LAMPORTS);
const iso = (ts) => (ts ? new Date(ts * 1000).toISOString() : null);
const SIDES = { 1: 'survive', 2: 'die' }; // SIDE_SURVIVE=1 (YES), SIDE_DIE=2 (NO)

export function buildViews(s, now = Math.floor(Date.now() / 1000)) {
  const settlementByMarket = new Map();
  for (const st of s.settlements) settlementByMarket.set(st.market, st);

  // ---- tokens
  const tokens = new Map();
  for (const l of [...s.launches].sort((a, b) => a.ts - b.ts)) {
    if (tokens.has(l.mint)) continue;
    tokens.set(l.mint, {
      mint: l.mint, launch: l.launch, name: l.name, symbol: l.symbol, uri: l.uri, creator: l.creator, market: l.market,
      launchSignature: l.signature, launchedAt: iso(l.ts), deadline: iso(l.deadline), revealEnd: iso(l.reveal_end),
      bondLamports: l.bond_lamports != null ? String(l.bond_lamports) : null, targetMcapLamports: l.target_mcap != null ? String(l.target_mcap) : null,
      _mcap: null,
      _ts: l.ts, _vol: 0n, trades: 0, buys: 0, sells: 0, lastTradeAt: null, _traders: new Set(),
    });
  }
  for (const t of s.trades) {
    const tok = tokens.get(t.mint);
    if (!tok) continue;
    tok._vol += big(t.sol_amount);
    tok.trades += 1;
    t.is_buy ? tok.buys++ : tok.sells++;
    tok._traders.add(t.trader);
    if (!tok.lastTradeAt || iso(t.ts) >= tok.lastTradeAt) { tok.lastTradeAt = iso(t.ts); if (t.mcap_lamports != null) tok._mcap = String(t.mcap_lamports); }
  }

  // ---- markets
  const markets = new Map();
  const ensureMarket = (id) => {
    if (!markets.has(id)) markets.set(id, { id, mint: null, creator: null, _commits: [], _reveals: [], _pool: 0n });
    return markets.get(id);
  };
  const mintByLaunch = new Map([...tokens.values()].map((t) => [t.launch, t.mint]));
  for (const tok of tokens.values()) if (tok.market) Object.assign(ensureMarket(tok.market), { mint: tok.mint, launch: tok.launch, creator: tok.creator, deadline: tok.deadline, revealEnd: tok.revealEnd, targetMcapLamports: tok.targetMcapLamports });
  for (const b of [...s.bets].sort((a, b2) => a.ts - b2.ts || a.idx - b2.idx)) {
    const m = ensureMarket(b.market);
    if (b.kind === 'commit') { m._commits.push(b); m._pool += big(b.amount); } else m._reveals.push(b);
  }
  for (const st of s.settlements) { const m = ensureMarket(st.market); if (!m.launch) m.launch = st.launch; if (!m.mint) m.mint = mintByLaunch.get(st.launch) ?? null; }

  const marketView = (m, withBets) => {
    const st = settlementByMarket.get(m.id) || null;
    // Pair reveals with the oldest unrevealed commit from the same bettor.
    const pending = new Map();
    const bets = m._commits.map((c) => {
      const row = { bettor: c.bettor, commitment: c.commitment, amountLamports: String(c.amount), committedAt: iso(c.ts), signature: c.signature, revealed: false };
      if (!pending.has(c.bettor)) pending.set(c.bettor, []);
      pending.get(c.bettor).push(row);
      return row;
    });
    let revealedSurvive = 0n, revealedDie = 0n;
    for (const r of m._reveals) {
      const row = pending.get(r.bettor)?.shift();
      const side = SIDES[r.side] ?? String(r.side);
      if (row) Object.assign(row, { revealed: true, side, revealedAt: iso(r.ts) });
      if (r.side === 1) revealedSurvive += big(r.amount); else if (r.side === 2) revealedDie += big(r.amount);
    }
    const deadlineTs = m.deadline ? Date.parse(m.deadline) / 1000 : null;
    const status = st ? 'settled' : deadlineTs && deadlineTs <= now ? 'revealing' : 'open';
    const out = {
      id: m.id, mint: m.mint, launch: m.launch ?? null, creator: m.creator, deadline: m.deadline ?? null, revealEnd: m.revealEnd ?? null,
      targetMcapLamports: m.targetMcapLamports ?? null, status,
      poolLamports: String(m._pool), poolSol: sol(m._pool),
      commitments: m._commits.length, reveals: m._reveals.length,
      // Aggregate revealed totals only; unrevealed stakes remain sealed.
      revealed: { surviveLamports: String(revealedSurvive), dieLamports: String(revealedDie) },
      settlement: st ? {
        survived: st.survived, twapMcapLamports: String(st.twap_mcap ?? '0'), targetMcapLamports: String(st.target_mcap ?? '0'),
        yesPoolLamports: String(st.yes_pool ?? '0'), noPoolLamports: String(st.no_pool ?? '0'), bonusPoolLamports: String(st.bonus_pool ?? '0'),
        unrevealedLamports: String(st.unrevealed ?? '0'), settledAt: iso(st.ts), signature: st.signature,
      } : null,
    };
    if (withBets) out.bets = bets; // unrevealed rows carry no `side` field at all
    return out;
  };

  const tokenView = (t) => {
    const st = t.market ? settlementByMarket.get(t.market) : null;
    return {
      mint: t.mint, launch: t.launch, name: t.name, symbol: t.symbol, uri: t.uri, creator: t.creator, market: t.market,
      launchSignature: t.launchSignature, launchedAt: t.launchedAt, deadline: t.deadline, revealEnd: t.revealEnd,
      bondLamports: t.bondLamports, targetMcapLamports: t.targetMcapLamports, mcapLamports: t._mcap,
      volumeLamports: String(t._vol), volumeSol: sol(t._vol), trades: t.trades, buys: t.buys, sells: t.sells,
      uniqueTraders: t._traders.size, lastTradeAt: t.lastTradeAt,
      status: st ? (st.survived ? 'survived' : 'died') : 'live',
    };
  };

  // ---- creators
  const creators = new Map();
  for (const t of tokens.values()) {
    if (!creators.has(t.creator)) creators.set(t.creator, { address: t.creator, launches: 0, survived: 0, died: 0, live: 0, _vol: 0n, mints: [] });
    const c = creators.get(t.creator);
    const v = tokenView(t);
    c.launches++; c._vol += t._vol; c.mints.push(t.mint);
    c[v.status === 'survived' ? 'survived' : v.status === 'died' ? 'died' : 'live']++;
  }
  const creatorView = (c) => {
    const settled = c.survived + c.died;
    return {
      address: c.address, launches: c.launches, survived: c.survived, died: c.died, live: c.live,
      survivalRate: settled ? c.survived / settled : null,
      volumeLamports: String(c._vol), volumeSol: sol(c._vol), mints: c.mints,
    };
  };

  const tokenList = [...tokens.values()].sort((a, b) => b._ts - a._ts).map(tokenView);
  const marketList = [...markets.values()].map((m) => marketView(m, false))
    .sort((a, b) => (b.deadline || '').localeCompare(a.deadline || ''));
  const creatorList = [...creators.values()].map(creatorView)
    .sort((a, b) => b.survived - a.survived || Number(BigInt(b.volumeLamports) - BigInt(a.volumeLamports)) || b.launches - a.launches);

  const totalVol = [...tokens.values()].reduce((acc, t) => acc + t._vol, 0n);
  const betVol = [...markets.values()].reduce((acc, m) => acc + m._pool, 0n);
  const settledCount = s.settlements.length;
  const survivedCount = s.settlements.filter((x) => x.survived).length;

  return {
    tokens: tokenList,
    token: (mint) => { const t = tokens.get(mint); return t ? tokenView(t) : null; },
    markets: marketList,
    market: (id) => {
      const m = markets.get(id) || [...markets.values()].find((x) => x.mint === id);
      return m ? marketView(m, true) : null;
    },
    creators: creatorList,
    creator: (addr) => {
      const c = creators.get(addr);
      if (!c) return null;
      return { ...creatorView(c), tokens: tokenList.filter((t) => t.creator === addr) };
    },
    stats: {
      tokens: tokens.size,
      markets: markets.size,
      trades: s.trades.length,
      bets: s.bets.filter((b) => b.kind === 'commit').length,
      creators: creators.size,
      settledMarkets: settledCount,
      survivedMarkets: survivedCount,
      survivalRate: settledCount ? survivedCount / settledCount : null,
      tradeVolumeLamports: String(totalVol), tradeVolumeSol: sol(totalVol),
      betVolumeLamports: String(betVol), betVolumeSol: sol(betVol),
      claims: s.claims.length,
    },
  };
}
