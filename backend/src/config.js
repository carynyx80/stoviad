// Self-contained config (mirrors packages/config/stovia.json; Railway builds only backend/).
import { z } from 'zod';
import { PublicKey } from '@solana/web3.js';

export const VERSION = '0.1.0';

export const STOVIA = Object.freeze({
  name: 'Stovia',
  network: 'mainnet-beta',
  programId: '6f54qVP1zv9F36A5Cxj9ogzm5DSVY1pQFndZWTwcVL8',
  companyWallet: '3aeVzSa3XKR8vstMFkXzVCnokcC4LApQPH3S8G7ckLgm',
  platformFeeBps: 10,
  creatorFeeBps: 10,
  privacyRings: Object.freeze({
    program: 'ring1GaLCuJnkUMVkX2JeZLTTX17wKsV4fZmPVzXANW',
    userRegistry: 'regy3WAeRXMYuMYxr5iK3Bf9Arr3PcxGxyzAddbiqDQ',
    stateTree: '777pvSGe5LaBd9nCczvE2FXEauiwtfGJ5XRpjKyniGor',
    solInterfacePda: 'CiNmas621VuyofiDSrEPfTXHKrdZuB6jMKECyNiMpLXE',
  }),
  domain: 'www.stovia.xyz',
});

const DEFAULT_CORS = 'https://www.stovia.xyz,https://stovia.xyz,http://localhost:3100';

const pubkey = z.string().trim().refine((s) => {
  try { new PublicKey(s); return true; } catch { return false; }
}, 'invalid base58 public key');

const emptyToUndef = (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v);

const EnvSchema = z.object({
  PORT: z.preprocess(emptyToUndef, z.coerce.number().int().min(1).max(65535).default(8080)),
  HOST: z.preprocess(emptyToUndef, z.string().default('0.0.0.0')),
  NETWORK: z.preprocess(emptyToUndef, z.string().default('mainnet-beta')),
  HELIUS_RPC_URL: z.preprocess(emptyToUndef, z.string().url().default('https://api.mainnet-beta.solana.com')),
  HELIUS_WEBHOOK_SECRET: z.preprocess(emptyToUndef, z.string().optional()),
  HELIUS_API_KEY: z.preprocess(emptyToUndef, z.string().trim().optional()),
  PROXY_RPC_RATE_MAX: z.preprocess(emptyToUndef, z.coerce.number().int().positive().default(600)),
  PROXY_SPR_RATE_MAX: z.preprocess(emptyToUndef, z.coerce.number().int().positive().default(300)),
  PROGRAM_ID: z.preprocess(emptyToUndef, pubkey.default(STOVIA.programId)),
  COMPANY_WALLET: z.preprocess(emptyToUndef, pubkey.default(STOVIA.companyWallet)),
  CORS_ORIGINS: z.preprocess(emptyToUndef, z.string().default(DEFAULT_CORS)),
  DATABASE_URL: z.preprocess(emptyToUndef, z.string().optional()),
  RATE_LIMIT_MAX: z.preprocess(emptyToUndef, z.coerce.number().int().positive().default(300)),
  LOG_LEVEL: z.preprocess(emptyToUndef, z.string().default('info')),
});

/** Fallback: the api-key query param of a Helius HELIUS_RPC_URL. */
function keyFromRpcUrl(url) {
  try {
    const u = new URL(url);
    if (!/(^|\.)helius-rpc\.com$/.test(u.hostname)) return undefined;
    return u.searchParams.get('api-key') || undefined;
  } catch { return undefined; }
}

export function loadConfig(env = process.env) {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment: ${issues}`);
  }
  const e = parsed.data;
  if (e.NETWORK !== 'mainnet-beta') {
    throw new Error(`NETWORK must be "mainnet-beta" (Stovia is mainnet-only); got "${e.NETWORK}". Unset NETWORK or set it to mainnet-beta.`);
  }
  return Object.freeze({
    port: e.PORT,
    host: e.HOST,
    network: e.NETWORK,
    rpcUrl: e.HELIUS_RPC_URL,
    rpcIsDefault: !env.HELIUS_RPC_URL,
    webhookSecret: e.HELIUS_WEBHOOK_SECRET,
    heliusApiKey: e.HELIUS_API_KEY ?? keyFromRpcUrl(e.HELIUS_RPC_URL),
    proxyRpcRateMax: e.PROXY_RPC_RATE_MAX,
    proxySprRateMax: e.PROXY_SPR_RATE_MAX,
    programId: e.PROGRAM_ID,
    companyWallet: e.COMPANY_WALLET,
    corsOrigins: e.CORS_ORIGINS.split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean),
    databaseUrl: e.DATABASE_URL,
    rateLimitMax: e.RATE_LIMIT_MAX,
    logLevel: e.LOG_LEVEL,
  });
}

export function publicConfig(cfg) {
  return {
    name: STOVIA.name,
    network: cfg.network,
    programId: cfg.programId,
    companyWallet: cfg.companyWallet,
    platformFeeBps: STOVIA.platformFeeBps,
    creatorFeeBps: STOVIA.creatorFeeBps,
    totalFeeBps: STOVIA.platformFeeBps + STOVIA.creatorFeeBps,
    privacyRings: { ...STOVIA.privacyRings },
    heliusProxy: !!cfg.heliusApiKey,
    domain: STOVIA.domain,
    version: VERSION,
  };
}
