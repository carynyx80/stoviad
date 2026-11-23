"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { RefreshCw } from "lucide-react";
import { Panel, Field, inputCls } from "@/components/app/ui";
import {
  COMPANY_WALLET,
  CONFIG_PDA,
  MAX_FEE_BPS,
  PROGRAM_ID,
  acceptAdminIx,
  decodeConfig,
  decodeProgramAccount,
  decodeProgramData,
  proposeAdminIx,
  setResolverIx,
  updateConfigIx,
  type StoviaConfig,
} from "@/lib/admin/anchor";
import { buildTx, confirmSignature, errText, simulate, type SimResult } from "@/lib/admin/tx";
import { AddrLink, Busy, Note, SimView, TxLink, btnGhost, btnGold } from "./bits";

type Status =
  | { state: "loading" }
  | { state: "error"; error: string }
  | {
      state: "ready";
      deployed: boolean;
      programData: PublicKey | null;
      upgradeAuthority: PublicKey | null;
      immutable: boolean;
      config: StoviaConfig | null;
      configError?: string;
    };

export function ProgramPanel() {
  const { connection } = useConnection();
  const [status, setStatus] = useState<Status>({ state: "loading" });

  const load = useCallback(async () => {
    setStatus({ state: "loading" });
    try {
      const [progAcc, cfgAcc] = await connection.getMultipleAccountsInfo([PROGRAM_ID, CONFIG_PDA], "confirmed");
      if (!progAcc) {
        setStatus({ state: "ready", deployed: false, programData: null, upgradeAuthority: null, immutable: false, config: null });
        return;
      }
      const programData = decodeProgramAccount(progAcc.data);
      let upgradeAuthority: PublicKey | null = null;
      let immutable = false;
      if (programData) {
        const pd = await connection.getAccountInfo(programData, { commitment: "confirmed", dataSlice: { offset: 0, length: 45 } });
        const dec = pd ? decodeProgramData(pd.data) : null;
        upgradeAuthority = dec?.upgradeAuthority ?? null;
        immutable = !!dec && !dec.upgradeAuthority;
      }
      let config: StoviaConfig | null = null;
      let configError: string | undefined;
      if (cfgAcc) {
        try {
          config = decodeConfig(cfgAcc.data);
        } catch (e) {
          configError = errText(e);
        }
      }
      setStatus({ state: "ready", deployed: true, programData, upgradeAuthority, immutable, config, configError });
    } catch (e) {
      setStatus({ state: "error", error: errText(e) });
    }
  }, [connection]);

  useEffect(() => {
    void load();
  }, [load]);

  const cfg = status.state === "ready" ? status.config : null;
  const isAdmin = !!cfg && cfg.admin.equals(COMPANY_WALLET);
  const pendingIsCompany = !!cfg?.pendingAdmin && cfg.pendingAdmin.equals(COMPANY_WALLET);

  return (
    <div className="space-y-6">
      <Panel
        kicker="On-chain"
        title={
          <span className="flex flex-wrap items-center justify-between gap-3">
            Program status
            <button type="button" onClick={() => void load()} className={`${btnGhost} h-9 px-3 text-xs`} disabled={status.state === "loading"}>
              <RefreshCw className={`h-3.5 w-3.5 ${status.state === "loading" ? "animate-spin" : ""}`} aria-hidden /> Refresh
            </button>
          </span>
        }
      >
        {status.state === "loading" && <Busy label="Reading mainnet…" />}
        {status.state === "error" && <Note tone="blood">RPC error: {status.error}</Note>}
        {status.state === "ready" && (
          <div className="space-y-5">
            {!status.deployed && (
              <Note tone="gold">
                <span className="font-semibold">Program not deployed yet.</span> <span className="text-bone-dim">No account at {PROGRAM_ID.toBase58()} on mainnet. Actions below can still be simulated.</span>
              </Note>
            )}
            <dl className="grid gap-x-8 gap-y-4 sm:grid-cols-2">
              <Row label="Program">
                <AddrLink addr={PROGRAM_ID.toBase58()} />
              </Row>
              <Row label="Upgrade authority">
                {!status.deployed ? (
                  <Dim>—</Dim>
                ) : status.immutable ? (
                  <Dim>None (immutable)</Dim>
                ) : (
                  <AddrLink addr={status.upgradeAuthority?.toBase58()} highlight={status.upgradeAuthority?.equals(COMPANY_WALLET)} />
                )}
              </Row>
              <Row label="Config PDA">
                <AddrLink addr={CONFIG_PDA.toBase58()} />
              </Row>
              {status.deployed && !cfg && (
                <Row label="Config">
                  <Dim>{status.configError ? `Unreadable: ${status.configError}` : "Not initialized (initialize_config not run)"}</Dim>
                </Row>
              )}
              {cfg && (
                <>
                  <Row label="Admin">
                    <AddrLink addr={cfg.admin.toBase58()} highlight={isAdmin} />
                  </Row>
                  <Row label="Pending admin">
                    <AddrLink addr={cfg.pendingAdmin?.toBase58()} highlight={pendingIsCompany} />
                  </Row>
                  <Row label="Treasury">
                    <AddrLink addr={cfg.treasury.toBase58()} />
                  </Row>
                  <Row label="Resolver">
                    <AddrLink addr={cfg.resolver.toBase58()} />
                  </Row>
                  <Row label="Platform fee">
                    <span className="font-display text-lg font-bold text-bone">{cfg.platformFeeBps} bps</span>
                  </Row>
                  <Row label="Creator fee">
                    <span className="font-display text-lg font-bold text-bone">{cfg.creatorFeeBps} bps</span>
                  </Row>
                  <Row label="Launches">
                    <span className="font-display text-lg font-bold text-bone">{cfg.launchCount.toString()}</span>
                  </Row>
                </>
              )}
            </dl>
            {cfg && !isAdmin && (
              <Note tone="blood">The company wallet is not the current config admin — admin-only actions will fail simulation{pendingIsCompany ? " until you accept the pending nomination below" : ""}.</Note>
            )}
          </div>
        )}
      </Panel>

      <div className="grid gap-6 lg:grid-cols-2">
        <UpdateConfigAction cfg={cfg} onDone={load} />
        <SetResolverAction cfg={cfg} onDone={load} />
        <AcceptAdminAction cfg={cfg} pendingIsCompany={pendingIsCompany} onDone={load} />
        <ProposeAdminAction onDone={load} />
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="mb-1 font-mono text-[10px] uppercase tracking-[0.2em] text-bone-dim">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}
const Dim = ({ children }: { children: ReactNode }) => <span className="text-sm text-bone-dim">{children}</span>;

function parseKey(s: string): PublicKey | null {
  try {
    // Off-curve (PDA) keys are allowed: a treasury may be a multisig vault.
    return s.trim().length >= 32 ? new PublicKey(s.trim()) : null;
  } catch {
    return null;
  }
}

function parseBps(s: string): number | null {
  if (!/^\d+$/.test(s.trim())) return null;
  const n = Number(s);
  return n >= 0 && n <= MAX_FEE_BPS ? n : null;
}

// ---------- generic action runner ----------

type Phase =
  | { p: "idle" }
  | { p: "simulating" }
  | { p: "simulated"; sim: SimResult }
  | { p: "sending"; sim: SimResult }
  | { p: "confirming"; sim: SimResult; sig: string }
  | { p: "done"; sig: string }
  | { p: "error"; error: string; sim?: SimResult; sig?: string };

function useAction(build: () => TransactionInstruction | string, onDone: () => void) {
  const { connection } = useConnection();
  const { publicKey, sendTransaction } = useWallet();
  const [phase, setPhase] = useState<Phase>({ p: "idle" });

  const reset = () => setPhase({ p: "idle" });

  const runSim = async () => {
    if (!publicKey) return;
    const ix = build();
    if (typeof ix === "string") return setPhase({ p: "error", error: ix });
    setPhase({ p: "simulating" });
    try {
      const { tx } = await buildTx(connection, publicKey, [ix]);
      setPhase({ p: "simulated", sim: await simulate(connection, tx) });
    } catch (e) {
      setPhase({ p: "error", error: errText(e) });
    }
  };

  const runSend = async () => {
    if (!publicKey || phase.p !== "simulated" || !phase.sim.ok) return;
    const sim = phase.sim;
    const ix = build();
    if (typeof ix === "string") return setPhase({ p: "error", error: ix, sim });
    setPhase({ p: "sending", sim });
    let sig: string | undefined;
    try {
      const { tx } = await buildTx(connection, publicKey, [ix]);
      sig = await sendTransaction(tx, connection, { preflightCommitment: "confirmed" });
      setPhase({ p: "confirming", sim, sig });
      await confirmSignature(connection, sig);
      setPhase({ p: "done", sig });
      onDone();
    } catch (e) {
      setPhase({ p: "error", error: errText(e), sim, sig });
    }
  };

  return { phase, runSim, runSend, reset };
}

function ActionCard({
  title,
  kicker,
  children,
  action,
  disabledReason,
}: {
  title: string;
  kicker: string;
  children?: ReactNode;
  action: ReturnType<typeof useAction>;
  disabledReason?: string | null;
}) {
  const { phase, runSim, runSend, reset } = action;
  const busy = phase.p === "simulating" || phase.p === "sending" || phase.p === "confirming";
  const canSend = phase.p === "simulated" && phase.sim.ok;
  const sim = "sim" in phase ? phase.sim : undefined;
  return (
    <Panel kicker={kicker} title={title}>
      <div className="space-y-4">
        {children}
        {disabledReason && <Note>{disabledReason}</Note>}
        <div className="flex flex-wrap gap-3">
          <button type="button" className={btnGhost} onClick={() => void runSim()} disabled={busy || !!disabledReason}>
            1 · Simulate
          </button>
          <button type="button" className={btnGold} onClick={() => void runSend()} disabled={busy || !canSend}>
            2 · Sign &amp; send
          </button>
          {(phase.p === "done" || phase.p === "error") && (
            <button type="button" className="font-mono text-[11px] uppercase tracking-[0.16em] text-bone-dim hover:text-gold" onClick={reset}>
              Reset
            </button>
          )}
        </div>
        {phase.p === "simulating" && <Busy label="Simulating on mainnet…" />}
        {phase.p === "sending" && <Busy label="Waiting for wallet signature…" />}
        {phase.p === "confirming" && <Busy label="Confirming…" />}
        {sim && <SimView sim={sim} />}
        {phase.p === "confirming" && <TxLink sig={phase.sig} />}
        {phase.p === "done" && (
          <Note tone="ok">
            Confirmed. <TxLink sig={phase.sig} />
          </Note>
        )}
        {phase.p === "error" && (
          <Note tone="blood">
            {phase.error}
            {phase.sig && (
              <span className="block pt-1">
                <TxLink sig={phase.sig} />
              </span>
            )}
          </Note>
        )}
      </div>
    </Panel>
  );
}

// ---------- concrete actions ----------

function UpdateConfigAction({ cfg, onDone }: { cfg: StoviaConfig | null; onDone: () => void }) {
  const [treasury, setTreasury] = useState("");
  const [platform, setPlatform] = useState("");
  const [creator, setCreator] = useState("");
  useEffect(() => {
    if (!cfg) return;
    setTreasury((v) => v || cfg.treasury.toBase58());
    setPlatform((v) => v || String(cfg.platformFeeBps));
    setCreator((v) => v || String(cfg.creatorFeeBps));
  }, [cfg]);
  const action = useAction(() => {
    const t = parseKey(treasury);
    const p = parseBps(platform);
    const c = parseBps(creator);
    if (!t) return "Treasury must be a valid address.";
    if (p == null || c == null) return `Fees must be whole numbers between 0 and ${MAX_FEE_BPS} bps.`;
    return updateConfigIx(COMPANY_WALLET, t, p, c);
  }, onDone);
  return (
    <ActionCard kicker="update_config" title="Treasury & fees" action={action}>
      <Field label="Treasury" htmlFor="adm-treasury">
        <input id="adm-treasury" className={`${inputCls} font-mono text-sm`} value={treasury} onChange={(e) => setTreasury(e.target.value)} placeholder="Treasury address" spellCheck={false} autoComplete="off" />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Platform fee (bps)" htmlFor="adm-pfee" hint={`max ${MAX_FEE_BPS}`}>
          <input id="adm-pfee" inputMode="numeric" className={inputCls} value={platform} onChange={(e) => setPlatform(e.target.value)} placeholder="10" />
        </Field>
        <Field label="Creator fee (bps)" htmlFor="adm-cfee" hint={`max ${MAX_FEE_BPS}`}>
          <input id="adm-cfee" inputMode="numeric" className={inputCls} value={creator} onChange={(e) => setCreator(e.target.value)} placeholder="10" />
        </Field>
      </div>
    </ActionCard>
  );
}

function SetResolverAction({ cfg, onDone }: { cfg: StoviaConfig | null; onDone: () => void }) {
  const [resolver, setResolver] = useState("");
  useEffect(() => {
    if (cfg) setResolver((v) => v || cfg.resolver.toBase58());
  }, [cfg]);
  const action = useAction(() => {
    const r = parseKey(resolver);
    return r ? setResolverIx(COMPANY_WALLET, r) : "Resolver must be a valid address.";
  }, onDone);
  return (
    <ActionCard kicker="set_resolver" title="Resolver key" action={action}>
      <Field label="New resolver" htmlFor="adm-resolver" hint="The key the resolver service signs sealed results with.">
        <input id="adm-resolver" className={`${inputCls} font-mono text-sm`} value={resolver} onChange={(e) => setResolver(e.target.value)} placeholder="Resolver address" spellCheck={false} autoComplete="off" />
      </Field>
    </ActionCard>
  );
}

function AcceptAdminAction({ cfg, pendingIsCompany, onDone }: { cfg: StoviaConfig | null; pendingIsCompany: boolean; onDone: () => void }) {
  const action = useAction(() => acceptAdminIx(COMPANY_WALLET), onDone);
  const reason = !cfg ? "Config not readable yet." : pendingIsCompany ? null : "Only available while pending_admin is the company wallet.";
  return (
    <ActionCard kicker="accept_admin" title="Accept admin role" action={action} disabledReason={reason}>
      <p className="text-sm text-bone-dim">Step 2 of the two-step admin handover: the nominated company wallet signs to become config admin.</p>
    </ActionCard>
  );
}

function ProposeAdminAction({ onDone }: { onDone: () => void }) {
  const [next, setNext] = useState("");
  const action = useAction(() => {
    const k = parseKey(next);
    if (!k) return "New admin must be a valid address.";
    if (k.equals(PublicKey.default)) return "The default (all-zero) key is rejected by the program.";
    return proposeAdminIx(COMPANY_WALLET, k);
  }, onDone);
  return (
    <ActionCard kicker="propose_admin" title="Nominate new admin" action={action}>
      <Field label="Nominee" htmlFor="adm-nominee" hint="Step 1 of 2. Nothing changes until the nominee signs accept_admin.">
        <input id="adm-nominee" className={`${inputCls} font-mono text-sm`} value={next} onChange={(e) => setNext(e.target.value)} placeholder="New admin address" spellCheck={false} autoComplete="off" />
      </Field>
    </ActionCard>
  );
}
