// Minimal Anchor (IDL spec 0.1.0) Borsh codec: enough for account decoding and simple ix encoding.
// The IDL is copied into resolver/idl/stovia.json (this service must not import ../target).
// Re-copy it whenever the program changes: cp ../target/idl/stovia.json idl/
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { pubkeyFromBytes, pubkeyBytes, u64le } from "./crypto.js";

const DEFAULT_IDL = fileURLToPath(new URL("../idl/stovia.json", import.meta.url));

export function loadIdl(path = process.env.STOVIA_IDL_PATH || DEFAULT_IDL) {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

export const anchorDiscriminator = (namespace, name) =>
  new Uint8Array(createHash("sha256").update(`${namespace}:${name}`).digest().subarray(0, 8));

class Reader {
  constructor(buf) {
    this.b = Buffer.from(buf);
    this.o = 0;
  }
  take(n) {
    if (this.o + n > this.b.length) throw new Error("account data too short for layout");
    const s = this.b.subarray(this.o, this.o + n);
    this.o += n;
    return s;
  }
}

function decodeType(type, r, idl) {
  if (typeof type === "string") {
    switch (type) {
      case "bool": return r.take(1)[0] !== 0;
      case "u8": return r.take(1)[0];
      case "i8": return r.take(1).readInt8(0);
      case "u16": return r.take(2).readUInt16LE(0);
      case "i16": return r.take(2).readInt16LE(0);
      case "u32": return r.take(4).readUInt32LE(0);
      case "i32": return r.take(4).readInt32LE(0);
      case "u64": return r.take(8).readBigUInt64LE(0);
      case "i64": return r.take(8).readBigInt64LE(0);
      case "u128": { const s = r.take(16); return s.readBigUInt64LE(0) | (s.readBigUInt64LE(8) << 64n); }
      case "i128": { const s = r.take(16); return BigInt.asIntN(128, s.readBigUInt64LE(0) | (s.readBigUInt64LE(8) << 64n)); }
      case "pubkey": return pubkeyFromBytes(r.take(32));
      case "string": { const n = r.take(4).readUInt32LE(0); return r.take(n).toString("utf8"); }
      case "bytes": { const n = r.take(4).readUInt32LE(0); return new Uint8Array(r.take(n)); }
      default: throw new Error(`unsupported IDL type ${type}`);
    }
  }
  if (type.array) {
    const [inner, len] = type.array;
    if (inner === "u8") return new Uint8Array(r.take(len));
    return Array.from({ length: len }, () => decodeType(inner, r, idl));
  }
  if (type.vec) {
    const n = r.take(4).readUInt32LE(0);
    return Array.from({ length: n }, () => decodeType(type.vec, r, idl));
  }
  if (type.option) return r.take(1)[0] ? decodeType(type.option, r, idl) : null;
  if (type.defined) {
    const def = idl.types.find((t) => t.name === type.defined.name);
    if (!def) throw new Error(`IDL type ${type.defined.name} not found`);
    return decodeDef(def, r, idl);
  }
  throw new Error(`unsupported IDL type ${JSON.stringify(type)}`);
}

function decodeDef(def, r, idl) {
  if (def.type.kind === "struct") {
    const out = {};
    for (const f of def.type.fields ?? []) out[f.name] = decodeType(f.type, r, idl);
    return out;
  }
  if (def.type.kind === "enum") {
    const idx = r.take(1)[0];
    const v = def.type.variants[idx];
    if (!v) throw new Error(`bad enum index ${idx} for ${def.name}`);
    if (v.fields?.length) throw new Error("enum variants with fields not supported");
    return v.name;
  }
  throw new Error(`unsupported def kind ${def.type.kind}`);
}

/** Decode an Anchor account by name; verifies the 8-byte discriminator. Returns null if the IDL lacks it. */
export function decodeAccount(idl, name, data) {
  if (!idl) return null;
  const acc = idl.accounts?.find((a) => a.name === name);
  const def = idl.types?.find((t) => t.name === name);
  if (!acc || !def) return null;
  const disc = Buffer.from(acc.discriminator ?? anchorDiscriminator("account", name));
  if (!Buffer.from(data).subarray(0, 8).equals(disc)) throw new Error(`${name}: discriminator mismatch`);
  return decodeDef(def, new Reader(Buffer.from(data).subarray(8)), idl);
}

export function encodeArg(type, value) {
  if (type === "u64") return u64le(value);
  if (type === "u8") return Uint8Array.of(Number(value));
  if (type === "bool") return Uint8Array.of(value ? 1 : 0);
  if (type === "pubkey") return pubkeyBytes(value);
  if (type?.array && type.array[0] === "u8") {
    if (value.length !== type.array[1]) throw new Error("array length mismatch");
    return Uint8Array.from(value);
  }
  throw new Error(`encodeArg: unsupported type ${JSON.stringify(type)}`);
}
