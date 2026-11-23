// Admin auth: the company wallet signs a server-issued, single-use nonce. No static passwords.
//   GET /admin/nonce            -> { nonce, message: "stovia-admin:<nonce>", expiresAt }
//   then on an admin request:     headers x-admin-nonce: <nonce>, x-admin-signature: <base58 ed25519 sig over message>
// Nonces expire after 5 minutes and are consumed on first verification attempt (success or failure).
// Kept in memory: a restart simply invalidates outstanding nonces (service runs as one replica).
import { randomBytes } from "node:crypto";
import nacl from "tweetnacl";
import { getBase58Encoder } from "@solana/kit";
import { pubkeyBytes } from "./crypto.js";

export const NONCE_TTL_MS = 5 * 60 * 1000;
const MAX_OUTSTANDING = 1000;
export const adminMessage = (nonce) => `stovia-admin:${nonce}`;

export class AdminAuth {
  constructor({ adminPubkey, now = () => Date.now() }) {
    this.pub = pubkeyBytes(adminPubkey);
    this.now = now;
    this.nonces = new Map();
  }

  issue() {
    this.#gc();
    if (this.nonces.size >= MAX_OUTSTANDING) throw new Error("too many outstanding nonces");
    const nonce = randomBytes(24).toString("hex");
    const expiresAt = this.now() + NONCE_TTL_MS;
    this.nonces.set(nonce, expiresAt);
    return { nonce, message: adminMessage(nonce), expiresAt: new Date(expiresAt).toISOString() };
  }

  /** Returns true iff the nonce is outstanding, unexpired and the signature is the admin's. Consumes the nonce. */
  verify(nonce, signatureB58) {
    if (typeof nonce !== "string" || typeof signatureB58 !== "string") return false;
    const exp = this.nonces.get(nonce);
    if (exp === undefined) return false;
    this.nonces.delete(nonce); // single use
    if (this.now() > exp) return false;
    let sig;
    try {
      sig = new Uint8Array(getBase58Encoder().encode(signatureB58));
    } catch {
      return false;
    }
    if (sig.length !== 64) return false;
    return nacl.sign.detached.verify(new TextEncoder().encode(adminMessage(nonce)), sig, this.pub);
  }

  #gc() {
    const t = this.now();
    for (const [n, exp] of this.nonces) if (t > exp) this.nonces.delete(n);
  }
}
