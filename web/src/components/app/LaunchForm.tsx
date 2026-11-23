"use client";

import { useState } from "react";
import { Panel, Field, inputCls, TokenAvatar } from "./ui";
import { TxButton } from "@/components/wallet/TxButton";
import { CREATOR_FEE_PCT, PLATFORM_FEE_PCT, STOVIA } from "@/lib/config";
import { fmtSol, fmtUsd, shortAddr } from "@/lib/format";

const DEADLINES = [
  { v: "24", l: "24 hours" },
  { v: "72", l: "3 days" },
  { v: "168", l: "7 days" },
  { v: "336", l: "14 days" },
  { v: "720", l: "30 days" },
];

export function LaunchForm() {
  const [name, setName] = useState("");
  const [ticker, setTicker] = useState("");
  const [image, setImage] = useState("");
  const [bond, setBond] = useState("1");
  const [target, setTarget] = useState("250000");
  const [deadline, setDeadline] = useState("168");

  const bondN = Number(bond);
  const targetN = Number(target);
  const imageOk = image === "" || /^https?:\/\/\S+$/i.test(image);
  const errors = {
    name: name.trim().length === 0 ? "Required" : name.length > 32 ? "Max 32 characters" : null,
    ticker: ticker.length === 0 ? "Required" : !/^[A-Z0-9]{2,10}$/.test(ticker) ? "2–10 letters/numbers" : null,
    image: imageOk ? null : "Must be an http(s) URL",
    bond: !(bondN >= 0.1) ? "Minimum 0.1 SOL" : null,
    target: !(targetN >= 10000) ? "Minimum $10,000" : null,
  };
  const valid = Object.values(errors).every((e) => e === null);
  const deadlineLabel = DEADLINES.find((d) => d.v === deadline)?.l ?? "";

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
            <Field label="Image URL" htmlFor="l-image" hint={errors.image ?? "Square PNG/JPG/GIF, hosted on IPFS, Arweave or https."}>
              <input id="l-image" type="url" inputMode="url" className={inputCls} value={image} onChange={(e) => setImage(e.target.value.trim())} placeholder="https://…" autoComplete="off" aria-invalid={!!errors.image} />
            </Field>
          </div>
          <Field label="Survival bond (SOL)" htmlFor="l-bond" hint={errors.bond ?? "Locked; returned if the token survives, slashed to NO bettors if it dies."}>
            <input id="l-bond" type="number" min={0.1} step={0.1} inputMode="decimal" className={`${inputCls} font-mono`} value={bond} onChange={(e) => setBond(e.target.value)} aria-invalid={!!errors.bond} />
          </Field>
          <Field label="Target market cap (USD)" htmlFor="l-target" hint={errors.target ?? "Survives if it holds this mcap at the deadline."}>
            <input id="l-target" type="number" min={10000} step={1000} inputMode="numeric" className={`${inputCls} font-mono`} value={target} onChange={(e) => setTarget(e.target.value)} aria-invalid={!!errors.target} />
          </Field>
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
            Survives if it holds <span className="text-bone">{fmtUsd(targetN)}</span> after <span className="text-bone">{deadlineLabel}</span>. Otherwise, the NO side eats.
          </p>
          <dl className="mt-6 space-y-2 border-t border-line pt-5 font-mono text-xs">
            <Row k="Bond" v={`${fmtSol(bondN)} SOL`} />
            <Row k="Platform fee" v={`${PLATFORM_FEE_PCT}% per trade`} />
            <Row k="Creator fee (you)" v={`${CREATOR_FEE_PCT}% per trade`} />
            <Row k="Fee wallet" v={shortAddr(STOVIA.companyWallet)} />
            <Row k="Network" v="Solana mainnet" />
          </dl>
        </Panel>
        <TxButton disabled={!valid}>Launch ${ticker || "token"} on mainnet</TxButton>
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
