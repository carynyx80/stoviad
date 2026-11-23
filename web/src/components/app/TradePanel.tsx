"use client";

import { useEffect, useState } from "react";
import BN from "bn.js";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { ExternalLink, Loader2, Wallet } from "lucide-react";
import { Panel, Field, inputCls } from "./ui";
import { fmtNum, fmtSol } from "@/lib/format";
import { errText, solscanTx } from "@/lib/admin/tx";
import { buildBuyTx, buildSellTx, quoteSwap, signSendConfirm, tokenBalance, type PoolView, type Quote } from "@/lib/dbc/client";

const SLIPPAGES = [50, 100, 300, 500];

type Phase = { s: "idle" } | { s: "busy"; label: string } | { s: "done"; sig: string } | { s: "error"; msg: string };

export function TradePanel({ view, symbol, onTraded }: { view: PoolView; symbol: string; onTraded?: () => void }) {
  const { connection } = useConnection();
  const wallet = useWallet();
  const { setVisible } = useWalletModal();
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [amount, setAmount] = useState("");
  const [slippage, setSlippage] = useState(100);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoteErr, setQuoteErr] = useState<string | null>(null);
  const [balance, setBalance] = useState<{ sol: number; tokens: bigint } | null>(null);
  const [phase, setPhase] = useState<Phase>({ s: "idle" });
  const decimals = view.raw.config.tokenDecimal;
  const owner = wallet.publicKey;

  useEffect(() => {
    if (!owner) return setBalance(null);
    let live = true;
    Promise.all([connection.getBalance(owner, "confirmed"), tokenBalance(connection, owner, view.mint)])
      .then(([sol, tokens]) => live && setBalance({ sol: sol / 1e9, tokens }))
      .catch(() => live && setBalance(null));
    return () => {
      live = false;
    };
  }, [owner, connection, view, phase.s]);

  const amountIn = (() => {
    const n = Number(amount);
    if (!(n > 0) || !Number.isFinite(n)) return null;
    const scale = side === "buy" ? 1e9 : 10 ** decimals;
    return new BN(BigInt(Math.floor(n * scale)).toString());
  })();

  useEffect(() => {
    setQuote(null);
    setQuoteErr(null);
    if (!amountIn || view.migrated) return;
    let live = true;
    const t = setTimeout(() => {
      quoteSwap(connection, view, side, amountIn, slippage)
        .then((q) => live && setQuote(q))
        .catch((e) => live && setQuoteErr(errText(e)));
    }, 300);
    return () => {
      live = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amount, side, slippage, view, connection]);

  const outUi = quote ? Number(quote.outputAmount.toString()) / (side === "buy" ? 10 ** decimals : 1e9) : null;
  const minUi = quote ? Number(quote.minimumAmountOut.toString()) / (side === "buy" ? 10 ** decimals : 1e9) : null;
  const insufficient =
    !!balance && !!amountIn && (side === "buy" ? Number(amount) > balance.sol - 0.005 : BigInt(amountIn.toString()) > balance.tokens);
  const busy = phase.s === "busy";

  async function trade() {
    if (!wallet.connected || !owner) return setVisible(true);
    if (!amountIn || !quote) return;
    try {
      setPhase({ s: "busy", label: "Building…" });
      const fresh = await quoteSwap(connection, view, side, amountIn, slippage);
      const tx = side === "buy" ? await buildBuyTx(connection, owner, view.pool, amountIn, fresh.minimumAmountOut) : await buildSellTx(connection, owner, view.pool, amountIn, fresh.minimumAmountOut);
      const sig = await signSendConfirm(connection, wallet, tx, [], (s) => setPhase({ s: "busy", label: s === "signing" ? "Approve in your wallet…" : s === "sending" ? "Sending…" : "Confirming…" }));
      setPhase({ s: "done", sig });
      setAmount("");
      onTraded?.();
    } catch (e) {
      setPhase({ s: "error", msg: errText(e) });
    }
  }

  if (view.migrated || view.complete) {
    return (
      <Panel kicker="Trade" title="Graduated">
        <p className="text-sm text-bone-dim">
          {view.migrated ? "The curve completed and liquidity moved to a Meteora DAMM v2 pool." : "The curve is complete; Meteora's migrator is moving liquidity to DAMM v2."} Trade it on Jupiter.
        </p>
        <a href={`https://jup.ag/swap/SOL-${view.mint.toBase58()}`} target="_blank" rel="noreferrer" className="mt-5 inline-flex h-12 items-center gap-2 rounded-sm bg-gold px-5 font-display font-bold text-ink hover:bg-gold-hot">
          Open on Jupiter <ExternalLink className="h-4 w-4" aria-hidden />
        </a>
      </Panel>
    );
  }

  return (
    <Panel kicker="Trade on the curve">
      <div role="tablist" aria-label="Side" className="mb-5 grid grid-cols-2 gap-1 rounded-sm border border-line p-1">
        {(["buy", "sell"] as const).map((s) => (
          <button
            key={s}
            role="tab"
            type="button"
            aria-selected={side === s}
            onClick={() => {
              setSide(s);
              setAmount("");
              setPhase({ s: "idle" });
            }}
            className={`h-10 rounded-sm font-display text-sm font-bold uppercase tracking-wide transition focus-visible:outline-2 focus-visible:outline-gold ${side === s ? (s === "buy" ? "bg-gold text-ink" : "bg-blood text-bone") : "text-bone-dim hover:text-bone"}`}
          >
            {s}
          </button>
        ))}
      </div>
      <Field
        label={side === "buy" ? "You pay (SOL)" : `You sell (${symbol})`}
        htmlFor="t-amt"
        hint={balance ? (side === "buy" ? `Balance ${fmtSol(balance.sol, 4)} SOL` : `Balance ${fmtNum(Number(balance.tokens) / 10 ** decimals)} ${symbol}`) : undefined}
      >
        <div className="flex gap-2">
          <input id="t-amt" type="number" min={0} step="any" inputMode="decimal" className={`${inputCls} font-mono`} value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.0" />
          {side === "sell" && balance && balance.tokens > BigInt(0) && (
            <button type="button" onClick={() => setAmount(String(Number(balance.tokens) / 10 ** decimals))} className="h-12 shrink-0 rounded-sm border border-line px-3 font-mono text-xs text-bone-dim hover:border-gold hover:text-gold">
              MAX
            </button>
          )}
        </div>
      </Field>
      <fieldset className="mt-4">
        <legend className="mb-2 font-mono text-[11px] uppercase tracking-[0.18em] text-bone-dim">Slippage</legend>
        <div className="flex flex-wrap gap-2">
          {SLIPPAGES.map((b) => (
            <button key={b} type="button" onClick={() => setSlippage(b)} aria-pressed={slippage === b} className={`rounded-full border px-3 py-1 font-mono text-xs transition ${slippage === b ? "border-gold bg-gold text-ink" : "border-line text-bone-dim hover:border-bone-dim"}`}>
              {b / 100}%
            </button>
          ))}
        </div>
      </fieldset>
      <dl className="mt-5 space-y-2 border-t border-line pt-4 font-mono text-xs">
        <div className="flex justify-between gap-3">
          <dt className="uppercase tracking-[0.14em] text-bone-dim">You receive</dt>
          <dd className="text-bone">{outUi != null ? (side === "buy" ? `${fmtNum(outUi)} ${symbol}` : `${fmtSol(outUi, 5)} SOL`) : "—"}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="uppercase tracking-[0.14em] text-bone-dim">Minimum</dt>
          <dd className="text-bone">{minUi != null ? (side === "buy" ? `${fmtNum(minUi)} ${symbol}` : `${fmtSol(minUi, 5)} SOL`) : "—"}</dd>
        </div>
      </dl>
      {quoteErr && <p className="mt-3 text-xs text-blood-hot">Quote failed: {quoteErr}</p>}
      <button
        type="button"
        onClick={trade}
        disabled={wallet.connected && (!quote || busy || insufficient)}
        className={`mt-5 inline-flex h-14 w-full items-center justify-center gap-2 rounded-sm px-6 font-display text-base font-bold transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold disabled:cursor-not-allowed disabled:opacity-40 ${side === "buy" ? "bg-gold text-ink hover:bg-gold-hot" : "bg-blood text-bone hover:bg-blood-hot"}`}
      >
        {!wallet.connected ? (
          <>
            <Wallet className="h-4 w-4" aria-hidden /> Connect wallet to trade
          </>
        ) : busy ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> {phase.label}
          </>
        ) : insufficient ? (
          "Insufficient balance"
        ) : (
          `${side === "buy" ? "Buy" : "Sell"} $${symbol}`
        )}
      </button>
      {phase.s === "done" && (
        <a href={solscanTx(phase.sig)} target="_blank" rel="noreferrer" className="mt-3 inline-flex items-center gap-1 font-mono text-xs text-gold hover:underline">
          Confirmed · view on Solscan <ExternalLink className="h-3 w-3" aria-hidden />
        </a>
      )}
      {phase.s === "error" && <p role="alert" className="mt-3 break-words border-l-2 border-blood-hot pl-3 text-sm text-bone">{phase.msg}</p>}
    </Panel>
  );
}
