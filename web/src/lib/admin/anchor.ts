/**
 * Hand-rolled Anchor encoding for the Stovia admin instructions.
 * Discriminators + arg order come straight from the IDL (stovia-idl.json); no Anchor client.
 * Kept free of "@/" aliases so it can be imported by plain node scripts.
 */
import { Buffer } from "buffer";
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import idl from "./stovia-idl.json";

export const PROGRAM_ID = new PublicKey("6f54qVP1zv9F36A5Cxj9ogzm5DSVY1pQFndZWTwcVL8");
export const COMPANY_WALLET = new PublicKey("3aeVzSa3XKR8vstMFkXzVCnokcC4LApQPH3S8G7ckLgm");
export const BPF_UPGRADEABLE_LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
/** Mirrors `MAX_FEE_BPS` in programs/stovia/src/lib.rs. */
export const MAX_FEE_BPS = 500;

export const CONFIG_PDA = PublicKey.findProgramAddressSync([new TextEncoder().encode("config")], PROGRAM_ID)[0];
export const PROGRAM_DATA_PDA = PublicKey.findProgramAddressSync([PROGRAM_ID.toBytes()], BPF_UPGRADEABLE_LOADER)[0];

type IdlArgType = string | { option?: IdlArgType; array?: [IdlArgType, number] };
type IdlIx = { name: string; discriminator: number[]; args: { name: string; type: IdlArgType }[] };
type IdlAccount = { name: string; discriminator: number[] };

export type AdminIxName = "update_config" | "set_resolver" | "accept_admin" | "propose_admin";

export function idlInstruction(name: AdminIxName): IdlIx {
  const ix = (idl.instructions as unknown as IdlIx[]).find((i) => i.name === name);
  if (!ix) throw new Error(`Instruction ${name} missing from IDL`);
  return ix;
}

function discriminator(name: AdminIxName): Uint8Array {
  const d = idlInstruction(name).discriminator;
  if (d.length !== 8) throw new Error(`Bad discriminator for ${name}`);
  return Uint8Array.from(d);
}

/** Borsh-encode a single value of the supported IDL types (pubkey, u16, u64). */
function encodeArg(type: IdlArgType, value: unknown): Uint8Array {
  if (type === "pubkey") {
    if (!(value instanceof PublicKey)) throw new Error("expected PublicKey");
    return value.toBytes();
  }
  if (type === "u16") {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 0 || n > 0xffff) throw new Error(`u16 out of range: ${String(value)}`);
    return Uint8Array.of(n & 0xff, n >> 8);
  }
  if (type === "u64") {
    const out = new Uint8Array(8);
    new DataView(out.buffer).setBigUint64(0, BigInt(value as bigint | number), true);
    return out;
  }
  throw new Error(`Unsupported IDL arg type ${JSON.stringify(type)}`);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** discriminator ++ borsh(args in IDL order). `args` is keyed by IDL arg name. */
export function encodeIxData(name: AdminIxName, args: Record<string, unknown> = {}): Uint8Array {
  const ix = idlInstruction(name);
  const parts = [discriminator(name)];
  for (const a of ix.args) {
    if (!(a.name in args)) throw new Error(`Missing arg ${a.name} for ${name}`);
    parts.push(encodeArg(a.type, args[a.name]));
  }
  return concat(parts);
}

function ix(name: AdminIxName, signer: PublicKey, args?: Record<string, unknown>): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: signer, isSigner: true, isWritable: false },
      { pubkey: CONFIG_PDA, isSigner: false, isWritable: true },
    ],
    data: Buffer.from(encodeIxData(name, args)),
  });
}

export function updateConfigIx(admin: PublicKey, treasury: PublicKey, platformFeeBps: number, creatorFeeBps: number) {
  return ix("update_config", admin, { treasury, platform_fee_bps: platformFeeBps, creator_fee_bps: creatorFeeBps });
}
export function setResolverIx(admin: PublicKey, resolver: PublicKey) {
  return ix("set_resolver", admin, { resolver });
}
export function proposeAdminIx(admin: PublicKey, newAdmin: PublicKey) {
  return ix("propose_admin", admin, { new_admin: newAdmin });
}
export function acceptAdminIx(newAdmin: PublicKey) {
  return ix("accept_admin", newAdmin);
}

// ---------- account decoding ----------

export type StoviaConfig = {
  admin: PublicKey;
  treasury: PublicKey;
  platformFeeBps: number;
  creatorFeeBps: number;
  launchCount: bigint;
  bump: number;
  pendingAdmin: PublicKey | null;
  resolver: PublicKey;
};

export function decodeConfig(data: Uint8Array): StoviaConfig {
  const disc = (idl.accounts as IdlAccount[]).find((a) => a.name === "Config")!.discriminator;
  if (data.length < 8 || disc.some((b, i) => data[i] !== b)) throw new Error("Not a Stovia Config account");
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let o = 8;
  const pk = () => {
    const k = new PublicKey(data.subarray(o, o + 32));
    o += 32;
    return k;
  };
  const admin = pk();
  const treasury = pk();
  const platformFeeBps = dv.getUint16(o, true);
  const creatorFeeBps = dv.getUint16(o + 2, true);
  o += 4;
  const launchCount = dv.getBigUint64(o, true);
  o += 8;
  const bump = data[o++];
  const tag = data[o++];
  const pendingAdmin = tag === 1 ? pk() : null;
  const resolver = pk();
  return { admin, treasury, platformFeeBps, creatorFeeBps, launchCount, bump, pendingAdmin, resolver };
}

/** BPF upgradeable loader `Program` account -> programdata address (tag u32 = 2, then 32 bytes). */
export function decodeProgramAccount(data: Uint8Array): PublicKey | null {
  if (data.length < 36) return null;
  const tag = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0, true);
  return tag === 2 ? new PublicKey(data.subarray(4, 36)) : null;
}

/** `ProgramData` account: tag u32 = 3, slot u64, Option<Pubkey> upgrade authority. */
export function decodeProgramData(data: Uint8Array): { slot: bigint; upgradeAuthority: PublicKey | null } | null {
  if (data.length < 13) return null;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (dv.getUint32(0, true) !== 3) return null;
  const slot = dv.getBigUint64(4, true);
  const upgradeAuthority = data[12] === 1 && data.length >= 45 ? new PublicKey(data.subarray(13, 45)) : null;
  return { slot, upgradeAuthority };
}
