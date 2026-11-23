"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import type { Keypair, Transaction } from "@solana/web3.js";
import { RefreshCw } from "lucide-react";
import { Panel } from "@/components/app/ui";
import { errText } from "@/lib/admin/tx";
import { DBC_CONFIG, DBC_PARTNER, DBC_PROGRAM_ID, FEE_BREAKDOWN_BPS, INITIAL_MCAP_SOL, MIGRATION_MCAP_SOL } from "@/lib/dbc/constants";
import { buildCreateConfigTx, readConfigStatus, signSendConfirm, simulateCost, type ConfigStatus, type CostSim } from "@/lib/dbc/client";
import { AddrLink, Busy, Note, SimView, TxLink, btnGhost, btnGold } from "./bits";

const sol = (l: number) => `${(l / 1e9).toFixed(6)} SOL`;

type Prepared = { tx: Transaction; configKp: Keypair; sim: CostSim };

export function DbcConfigPanel() {
  const { connection } = useConnection();
  const wallet = useWallet();
  const [status, setStatus] = useState<ConfigStatus | null | "loading" | { error: string }>("loading");
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ address: string; sig: string } | null>(null);

  const load = useCallback(async () => {
    setStatus("loading");
    try {
      setStatus(await readConfigStatus(connection));
    } catch (e) {
      setStatus({ error: errText(e) });
    }
  }, [connection]);
  useEffect(() => {
    load();
  }, [load]);

  const exists = status && status !== "loading" && !("error" in status) && status.exists;

  async function simulateCreate() {
    setError(null);
    setPrepared(null);
    setBusy("Building and simulating on mainnet…");
    try {
      const { tx, configKp } = await buildCreateConfigTx(connection, DBC_PARTNER);
      const sim = await simulateCost(connection, tx, DBC_PARTNER);
      setPrepared({ tx, configKp, sim });
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(null);
    }
  }

  async function create() {
    if (!prepared) return;
    setError(null);
    try {
      const sig = await signSendConfirm(connection, wallet, prepared.tx, [prepared.configKp], (s) =>
        setBusy(s === "signing" ? "Approve in your wallet…" : s === "sending" ? "Sending…" : "Confirming on mainnet…"),
      );
      setCreated({ address: prepared.configKp.publicKey.toBase58(), sig });
      setPrepared(null);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(null);
    }
  }

  const sim = prepared?.sim;
  const affordable = sim?.costLamports != null && sim.balanceLamports != null && sim.costLamports <= sim.balanceLamports;

  return (
    <Panel kicker="Meteora Dynamic Bonding Curve" title="Stovia launch config">
      <div className="space-y-5">
        <dl className="grid grid-cols-1 gap-x-8 gap-y-2 font-mono text-xs sm:grid-cols-2">
          <Row k="DBC program" v={<AddrLink addr={DBC_PROGRAM_ID.toBase58()} />} />
          <Row k="Partner / fee claimer" v={<AddrLink addr={DBC_PARTNER.toBase58()} highlight />} />
          <Row k="Trade fee" v={`${FEE_BREAKDOWN_BPS.total / 100}% = Stovia ${FEE_BREAKDOWN_BPS.partner / 100}% + creator ${FEE_BREAKDOWN_BPS.creator / 100}% + Meteora ${FEE_BREAKDOWN_BPS.protocol / 100}%`} />
          <Row k="Curve" v={`${INITIAL_MCAP_SOL} → ${MIGRATION_MCAP_SOL} SOL mcap, then DAMM v2`} />
          <Row k="NEXT_PUBLIC_DBC_CONFIG" v={DBC_CONFIG ? <AddrLink addr={DBC_CONFIG.toBase58()} /> : <span className="text-bone-dim">unset</span>} />
        </dl>

        {status === "loading" ? (
          <Busy label="Checking config on mainnet…" />
        ) : status && "error" in status ? (
          <Note tone="blood">Couldn&apos;t read the config: {status.error}</Note>
        ) : status === null ? (
          <Note tone="gold">Stovia config not created yet (NEXT_PUBLIC_DBC_CONFIG is unset).</Note>
        ) : status.exists ? (
          <Note tone="ok">
            Config is live on mainnet · fee claimer {status.feeClaimer === DBC_PARTNER.toBase58() ? "is the company wallet" : status.feeClaimer} · creator share {status.creatorFeePct}% of the post-protocol fee.
          </Note>
        ) : (
          <Note tone="blood">NEXT_PUBLIC_DBC_CONFIG points at an account that is not a DBC config.</Note>
        )}

        {created && (
          <Note tone="ok">
            Config created at <span className="font-mono text-bone">{created.address}</span>. Set <span className="font-mono">NEXT_PUBLIC_DBC_CONFIG={created.address}</span> on the web deployment and redeploy to open launches. <TxLink sig={created.sig} />
          </Note>
        )}

        {!exists && !created && (
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" className={btnGhost} onClick={simulateCreate} disabled={!!busy}>
              Simulate create config
            </button>
            <button type="button" className={btnGold} onClick={create} disabled={!!busy || !prepared?.sim.ok || !affordable}>
              Sign &amp; create config
            </button>
            <button type="button" className={btnGhost} onClick={load} disabled={!!busy} aria-label="Refresh status">
              <RefreshCw className="h-4 w-4" aria-hidden />
            </button>
          </div>
        )}
        {busy && <Busy label={busy} />}

        {sim && (
          <div className="space-y-3">
            <SimView sim={{ ok: sim.ok, err: sim.err, logs: sim.logs, unitsConsumed: sim.unitsConsumed }} />
            {sim.costLamports != null && sim.balanceLamports != null && (
              <Note tone={affordable ? "ok" : "blood"}>
                Exact cost <span className="font-mono">{sol(sim.costLamports)}</span> (config rent + network fee) vs company balance <span className="font-mono">{sol(sim.balanceLamports)}</span>
                {affordable ? <> · leaves {sol(sim.balanceLamports - sim.costLamports)}</> : " · not enough SOL"}
              </Note>
            )}
            <p className="text-xs text-bone-dim">
              New config address <span className="font-mono text-bone">{prepared!.configKp.publicKey.toBase58()}</span>. The config keypair is generated in this tab only to co-sign its own creation; it has no authority afterwards.
            </p>
          </div>
        )}
        {error && <Note tone="blood">{error}</Note>}
      </div>
    </Panel>
  );
}

function Row({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="uppercase tracking-[0.14em] text-bone-dim">{k}</dt>
      <dd className="min-w-0 break-words text-bone">{v}</dd>
    </div>
  );
}
