// Settlement math for the sealed (private) bet path. Pure; no I/O.
//
// Inputs are the resolver's claimed stakes joined with on-chain reveal state:
//   { bettor, amount, verified, revealed, side }   side: 1 = SURVIVE (YES), 2 = DIE (NO)
// Only stakes that are BOTH verified (shielded note received + stake_commitment matches)
// AND revealed on-chain count toward pools. Everything else stays in the market identity
// and is swept to the company treasury after payouts.
//
// Winner payout = stake + floor(stake * losing_pool / winning_pool)  (pro-rata, rounding down;
// the dust remains in the market identity and is swept with the remainder).
// If nobody valid is on the winning side, valid revealed losers are refunded their stake.
//
// Creator bond (optional, verified Rings transfer by the creator):
//   survived -> refunded to the creator (added to the creator's payout entry, bondRefund field);
//   died     -> added to the losing pool that NO winners share:
//               payout = stake + floor(stake * (losing + bond) / winning);
//   died with no valid NO winners -> the bond stays in the market identity and is swept to treasury.
import { buildPayoutTree } from "./crypto.js";

export const SIDE_SURVIVE = 1;
export const SIDE_DIE = 2;

/**
 * @param {{survived: boolean, bond?: bigint, creator?: string}} market
 * @param {{bettor: string, amount: bigint, verified: boolean, revealed: boolean, side: number}[]} stakes
 */
export function computeSettlement(market, stakes) {
  const winningSide = market.survived ? SIDE_SURVIVE : SIDE_DIE;
  let yesTotal = 0n;
  let noTotal = 0n;
  let excluded = 0n; // claimed-but-invalid (unrevealed / unverified) stakes -> treasury
  const valid = [];
  const seen = new Set();
  for (const s of stakes) {
    const amount = BigInt(s.amount);
    if (seen.has(s.bettor)) throw new Error(`duplicate stake for bettor ${s.bettor}`);
    seen.add(s.bettor);
    if (!s.verified || !s.revealed || (s.side !== SIDE_SURVIVE && s.side !== SIDE_DIE)) {
      if (s.verified) excluded += amount;
      continue;
    }
    valid.push({ bettor: s.bettor, amount, side: s.side });
    if (s.side === SIDE_SURVIVE) yesTotal += amount;
    else noTotal += amount;
  }
  const bond = BigInt(market.bond ?? 0n);
  const winPool = winningSide === SIDE_SURVIVE ? yesTotal : noTotal;
  const losePool = winningSide === SIDE_SURVIVE ? noTotal : yesTotal;
  const bondToWinners = !market.survived && winPool > 0n ? bond : 0n;
  const bondRefund = market.survived ? bond : 0n;

  const payouts = [];
  if (winPool === 0n) {
    for (const v of valid) payouts.push({ bettor: v.bettor, amount: v.amount, refund: true, stake: v.amount, bondRefund: 0n });
  } else {
    for (const v of valid) {
      if (v.side !== winningSide) continue;
      payouts.push({ bettor: v.bettor, amount: v.amount + (v.amount * (losePool + bondToWinners)) / winPool, refund: false, stake: v.amount, bondRefund: 0n });
    }
  }
  if (bondRefund > 0n) {
    if (!market.creator) throw new Error("bond refund needs market.creator");
    const mine = payouts.find((p) => p.bettor === market.creator);
    if (mine) {
      mine.amount += bondRefund;
      mine.bondRefund = bondRefund;
    } else payouts.push({ bettor: market.creator, amount: bondRefund, refund: false, stake: 0n, bondRefund });
  }
  const totalPaid = payouts.reduce((a, p) => a + p.amount, 0n);
  const tree = buildPayoutTree(payouts);
  const bondToTreasury = bond - bondToWinners - bondRefund;
  return { winningSide, yesTotal, noTotal, bond, bondToWinners, bondRefund, bondToTreasury, payouts, totalPaid, excludedVerified: excluded, root: tree.root, tree };
}
