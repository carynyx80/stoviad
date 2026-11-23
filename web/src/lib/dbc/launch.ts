import { RESOLVER_URL } from "./constants";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function base58(bytes: Uint8Array): string {
  const digits: number[] = [];
  for (const byte of bytes) {
    let carry = byte;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = "";
  for (let i = 0; i < bytes.length && bytes[i] === 0; i++) out += "1";
  for (let i = digits.length - 1; i >= 0; i--) out += B58[digits[i]];
  return out;
}

export type LaunchRegistration = {
  pool: string;
  mint: string;
  creator: string;
  name: string;
  symbol: string;
  uri: string;
  targetMcapLamports: string;
  deadlineTs: number;
};

/** The exact message the creator's wallet signs to authorize the survival-market registration. */
export const launchMessage = (r: Pick<LaunchRegistration, "pool" | "mint" | "targetMcapLamports" | "deadlineTs">) =>
  `stovia-launch:${r.pool}:${r.mint}:${r.targetMcapLamports}:${r.deadlineTs}`;

export type RegisterResult = { ok: true } | { ok: false; pending: true; reason: string };

/** POST /launches on the resolver. 404 / network errors => "market registration pending". Never throws. */
export async function registerLaunch(r: LaunchRegistration, signMessage: (m: Uint8Array) => Promise<Uint8Array>): Promise<RegisterResult> {
  let signature: string;
  try {
    signature = base58(await signMessage(new TextEncoder().encode(launchMessage(r))));
  } catch (e) {
    return { ok: false, pending: true, reason: e instanceof Error ? e.message : "Message signature declined" };
  }
  try {
    const res = await fetch(`${RESOLVER_URL}/launches`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...r, signature }),
    });
    if (res.ok) return { ok: true };
    return { ok: false, pending: true, reason: res.status === 404 ? "Resolver endpoint not live yet" : `Resolver answered ${res.status}` };
  } catch {
    return { ok: false, pending: true, reason: "Resolver unreachable" };
  }
}
