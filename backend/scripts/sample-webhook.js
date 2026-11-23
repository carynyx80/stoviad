// Prints a sample Helius raw-webhook payload with encoded Stovia events to stdout.
// Usage: node scripts/sample-webhook.js > /tmp/payload.json
import { encodeEvent, marketPda } from '../src/anchor.js';
const PROGRAM = process.env.PROGRAM_ID || '6f54qVP1zv9F36A5Cxj9ogzm5DSVY1pQFndZWTwcVL8';
const mint = 'So11111111111111111111111111111111111111112';
const creator = '3aeVzSa3XKR8vstMFkXzVCnokcC4LApQPH3S8G7ckLgm';
const launch = 'ring1GaLCuJnkUMVkX2JeZLTTX17wKsV4fZmPVzXANW';
const market = marketPda(launch, PROGRAM);
const bettor = 'regy3WAeRXMYuMYxr5iK3Bf9Arr3PcxGxyzAddbiqDQ';
const now = Math.floor(Date.now() / 1000);
const tx = (sig, events) => ({
  signature: sig, slot: 300000000, blockTime: now,
  transaction: { signatures: [sig], message: { accountKeys: [creator, PROGRAM] } },
  meta: { err: null, logMessages: [`Program ${PROGRAM} invoke [1]`, ...events.map((e) => `Program data: ${e}`), `Program ${PROGRAM} success`] },
});
const sig = (c) => c.repeat(87) + '1';
const extra = process.argv[2] === 'reveal' ? [
  tx(sig('F'), [encodeEvent('BetRevealed', { market, bettor, side: 1, amount: '250000000' })]),
  tx(sig('G'), [encodeEvent('MarketSettled', { market, launch, survived: 1, twapMcap: '60000000000', targetMcap: '50000000000', yesPool: '250000000', noPool: '0', bonusPool: '100000000', unrevealed: '0' })]),
  tx(sig('H'), [encodeEvent('Claimed', { market, launch, recipient: bettor, kind: 'winnings', amount: '350000000' })]),
] : [];
console.log(JSON.stringify([...extra, 
  tx(sig('A'), [encodeEvent('LaunchCreated', { launch, mint, creator, name: 'Test', symbol: 'TST', uri: 'https://x/y.json', bondLamports: '100000000', platformFee: '0', targetMcapLamports: '50000000000', deadlineTs: now + 86400, revealEndTs: now + 90000 })]),
  tx(sig('B'), [encodeEvent('Trade', { launch, mint, trader: bettor, isBuy: 1, solAmount: '1500000000', tokenAmount: '1000000', platformFee: '1500000', creatorFee: '1500000', virtualSol: '31500000000', virtualTokens: '1000000000', mcapLamports: '31500000000', timestamp: now })]),
  tx(sig('C'), [encodeEvent('BetCommitted', { market, bettor, commitment: 'ab'.repeat(32), amount: '250000000', platformFee: '250000' })]),
  tx(sig('D'), ['dW5rbm93bmV2ZW50cGF5bG9hZA==']),
  { signature: sig('E'), instructions: [{ programId: '11111111111111111111111111111111' }] },
]));
