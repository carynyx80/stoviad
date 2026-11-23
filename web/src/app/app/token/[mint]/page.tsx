import { TokenView } from "./TokenView";

export const metadata = { title: "Token — Stovia" };

export default async function TokenPage({ params, searchParams }: { params: Promise<{ mint: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { mint } = await params;
  const sp = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  return <TokenView mint={mint} launchTx={one(sp.tx)} registrationPending={one(sp.registration) === "pending"} />;
}
