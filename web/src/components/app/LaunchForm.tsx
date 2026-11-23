"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { Loader2, Wallet } from "lucide-react";
import { Panel, Field, inputCls, TokenAvatar } from "./ui";
import { fmtSol, shortAddr } from "@/lib/format";
import { errText } from "@/lib/admin/tx";
import {
  DBC_CONFIG,
  DBC_PARTNER,
  FEE_BREAKDOWN_BPS,
  INITIAL_MCAP_SOL,
  MAX_NAME_LEN,
  MAX_SYMBOL_LEN,
  MAX_URI_LEN,
  MIGRATION_MCAP_SOL,
  metadataUri,
} from "@/lib/dbc/constants";
import { buildCreatePoolTx, signSendConfirm, simulateCost } from "@/lib/dbc/client";
import { registerLaunch } from "@/lib/dbc/launch";

const DEADLINES = [
  { v: "24", l: "24 hours" },
  { v: "72", l: "3 days" },
  { v: "168", l: "7 days" },
  { v: "336", l: "14 days" },
  { v: "720", l: "30 days" },
];

const bytes = (s: string) => new TextEncoder().encode(s).length;

type Phase =
  | { s: "idle" }
  | { s: "busy"; label: string }
  | { s: "error"; msg: string };

export function LaunchForm() {
  const router = useRouter();
  const { connection } = useConnection();
  const wallet = useWallet();
  const { setVisible } = useWalletModal();
  const [name, setName] = useState("");
  const [ticker, setTicker] = useState("");
  const [image, setImage] = useState("");
  const [target, setTarget] = useState("200");
  const [deadline, setDeadline] = useState("168");
  const [phase, setPhase] = useState<Phase>({ s: "idle" });

  const targetN = Number(target);
  const imageOk = image === "" || /^(https?:\/\/|ipfs:\/\/|ar:\/\/)\S+$/i.test(image);
  const uri = metadataUri(name.trim(), ticker, image);
  const errors = {
    name: name.trim().length === 0 ? "Required" : bytes(name.trim()) > MAX_NAME_LEN ? `Max ${MAX_NAME_LEN} bytes` : null,
    ticker: ticker.length === 0 ? "Required" : !/^[A-Z0-9]{2,10}$/.test(ticker) || ticker.length > MAX_SYMBOL_LEN ? "2–10 letters/numbers" : null,
    image: !imageOk ? "Must be an http(s), ipfs:// or ar:// URL" : bytes(uri) > MAX_URI_LEN ? "URL too long for on-chain metadata (shorten it or host a .json)" : null,
    target: !(targetN > INITIAL_MCAP_SOL) ? `Must be above the ${INITIAL_MCAP_SOL} SOL starting cap` : null,
  };
  const valid = Object.values(errors).every((e) => e === null);
  const deadlineLabel = DEADLINES.find((d) => d.v === deadline)?.l ?? "";
  const busy = phase.s === "busy";

  async function launch() {
    if (!wallet.connected || !wallet.publicKey) return setVisible(true);
    if (!DBC_CONFIG) return setPhase({ s: "error", msg: "Stovia config not created yet. Launching opens once the company console creates it." });
    if (!wallet.signMessage) return setPhase({ s: "error", msg: "This wallet can't sign messages, which is needed to register the survival market." });
    const creator = wallet.publicKey;
    try {
      setPhase({ s: "busy", label: "Building pool transaction…" });
      const { tx, mintKp, pool } = await buildCreatePoolTx(connection, { creator, name: name.trim(), symbol: ticker, uri });
      setPhase({ s: "busy", label: "Simulating on mainnet…" });
      const sim = await simulateCost(connection, tx, creator);
      if (!sim.ok) throw new Error(`Simulation failed: ${sim.err}${sim.logs.length ? ` · ${sim.logs.slice(-2).join(" · ")}` : ""}`);
      const costSol = sim.costLamports != null ? ` (~${fmtSol(sim.costLamports / 1e9, 4)} SOL)` : "";
      const sig = await signSendConfirm(connection, wallet, tx, [mintKp], (step) =>
        setPhase({ s: "busy", label: step === "signing" ? `Approve in your wallet${costSol}…` : step === "sending" ? "Sending…" : "Confirming on mainnet…" }),
      );
      setPhase({ s: "busy", label: "Sign the market registration message…" });
      const mint = mintKp.publicKey.toBase58();
      const deadlineTs = Math.floor(Date.now() / 1000) + Number(deadline) * 3600;
      const reg = await registerLaunch(
        {
          pool: pool.toBase58(),
          mint,
          creator: creator.toBase58(),
          name: name.trim(),
          symbol: ticker,
          uri,
          targetMcapLamports: BigInt(Math.round(targetN * 1e9)).toString(),
          deadlineTs,
        },
        wallet.signMessage,
      );
      const qs = new URLSearchParams({ tx: sig });
      if (!reg.ok) qs.set("registration", "pending");
      router.push(`/app/token/${mint}?${qs.toString()}`);
    } catch (e) {
      setPhase({ s: "error", msg: errText(e) });
    }
  }

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1.4fr_1fr]">
      <Panel kicker="Step 1 of 1" title="Token details">
        <form className="grid grid-cols-1 gap-5 sm:grid-cols-2" onSubmit={(e) => e.preventDefault()} noValidate>
          <Field label="Name" htmlFor="l-name" hint={name && errors.name ? errors.name : "What the degens will call it."}>
            <input id="l-name" className={inputCls} value={name} maxLength={40} onChange={(e) => setName(e.target.value)} placeholder="Last Dog Standing" autoComplete="off" aria-invalid={!!(name && errors.name)} />
          </Field>
          <Field label="Ticker" htmlFor="l-ticker" hint={ticker && errors.ticker ? errors.ticker : "2–10 characters, A–Z 0–9."}>
            <div className="relative">
              <span className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 font-mono text-gold">$</span>
              <input id="l-ticker" className={`${inputCls} pl-8 font-mono uppercase`} value={ticker} maxLength={10} onChange={(e) => setTicker(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))} placeholder="SURVIVE" autoComplete="off" aria-invalid={!!(ticker && errors.ticker)} />
            </div>
          </Field>
          <div className="sm:col-span-2">
            <Field label="Image URL" htmlFor="l-image" hint={errors.image ?? "Square PNG/JPG/GIF on IPFS, Arweave or https. Or paste a full Metaplex .json URI."}>
              <input id="l-image" type="url" inputMode="url" className={inputCls} value={image} onChange={(e) => setImage(e.target.value.trim())} placeholder="https://…" autoComplete="off" aria-invalid={!!errors.image} />
            </Field>
          </div>
          <div className="sm:col-span-2">
            <Field label="Survival target market cap (SOL)" htmlFor="l-target" hint={errors.target ?? `Survives if it holds this market cap at the deadline. Curve starts at ${INITIAL_MCAP_SOL} SOL and graduates at ~${MIGRATION_MCAP_SOL} SOL.`}>
              <input id="l-target" type="number" min={INITIAL_MCAP_SOL + 1} step={10} inputMode="decimal" className={`${inputCls} font-mono`} value={target} onChange={(e) => setTarget(e.target.value)} aria-invalid={!!errors.target} />
            </Field>
          </div>
          <div className="sm:col-span-2">
            <fieldset>
              <legend className="mb-2 block font-mono text-[11px] uppercase tracking-[0.18em] text-bone-dim">Deadline</legend>
              <div className="flex flex-wrap gap-2">
                {DEADLINES.map((d) => (
                  <label key={d.v} className={`cursor-pointer rounded-full border px-4 py-2 text-sm transition has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-gold ${deadline === d.v ? "border-gold bg-gold text-ink" : "border-line text-bone-dim hover:border-bone-dim"}`}>
                    <input type="radio" name="deadline" value={d.v} checked={deadline === d.v} onChange={() => setDeadline(d.v)} className="sr-only" />
                    {d.l}
                  </label>
                ))}
              </div>
            </fieldset>
          </div>
        </form>
      </Panel>

      <div className="flex min-w-0 flex-col gap-6">
        <Panel kicker="Preview">
          <div className="flex items-center gap-4">
            <TokenAvatar src={imageOk ? image : undefined} ticker={ticker || "NEW"} />
            <div className="min-w-0">
              <p className="truncate font-display text-2xl font-extrabold tracking-tight text-bone">{name || "Your token"}</p>
              <p className="font-mono text-sm text-gold">${ticker || "TICKER"}</p>
            </div>
          </div>
          <p className="mt-5 font-serif text-xl italic leading-snug text-bone-dim">
            Survives if it holds <span className="text-bone">{fmtSol(targetN, 0)} SOL</span> market cap after <span className="text-bone">{deadlineLabel}</span>. Otherwise, the NO side eats.
          </p>
          <dl className="mt-6 space-y-2 border-t border-line pt-5 font-mono text-xs">
            <Row k="Curve" v="Meteora Dynamic Bonding Curve" />
            <Row k="Trade fee" v={`${FEE_BREAKDOWN_BPS.total / 100}% total`} />
            <Row k="Creator (you)" v={`${FEE_BREAKDOWN_BPS.creator / 100}% per trade`} />
            <Row k="Stovia" v={`${FEE_BREAKDOWN_BPS.partner / 100}% per trade`} />
            <Row k="Meteora protocol" v={`${FEE_BREAKDOWN_BPS.protocol / 100}% per trade`} />
            <Row k="Graduates to" v="Meteora DAMM v2 (LP locked)" />
            <Row k="Fee wallet" v={shortAddr(DBC_PARTNER.toBase58())} />
            <Row k="You pay" v="~0.02 SOL rent + network fee" />
          </dl>
        </Panel>
        <div>
          {!DBC_CONFIG && (
            <p role="status" className="mb-3 border-l-2 border-gold pl-3 text-sm text-bone-dim">
              <span className="font-semibold text-bone">Stovia config not created yet.</span> Launches open once the company console creates the Meteora partner config.
            </p>
          )}
          <button
            type="button"
            onClick={launch}
            disabled={wallet.connected && (!valid || busy || !DBC_CONFIG)}
            className="inline-flex h-14 w-full items-center justify-center gap-2 rounded-sm bg-gold px-6 font-display text-base font-bold tracking-tight text-ink transition hover:bg-gold-hot focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold disabled:cursor-not-allowed disabled:opacity-40"
          >
            {!wallet.connected ? (
              <>
                <Wallet className="h-4 w-4" aria-hidden /> Connect wallet to continue
              </>
            ) : busy ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> {phase.label}
              </>
            ) : (
              <>Launch ${ticker || "token"} on mainnet</>
            )}
          </button>
          {phase.s === "error" && (
            <p role="alert" className="mt-3 break-words border-l-2 border-blood-hot pl-3 text-sm text-bone">
              {phase.msg}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="uppercase tracking-[0.14em] text-bone-dim">{k}</dt>
      <dd className="truncate text-bone">{v}</dd>
    </div>
  );
}
