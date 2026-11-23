// Stateless Metaplex token-metadata JSON for Stovia launches.
// The on-chain URI (immutable) carries name/symbol/image in its query string, so this route
// stores nothing and its output for a given URI can never change.
export const dynamic = "force-dynamic";

const clip = (v: string | null, max: number) => (v ?? "").slice(0, max);

export function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const name = clip(q.get("n"), 32);
  const symbol = clip(q.get("s"), 10);
  const rawImage = clip(q.get("i"), 200);
  const image = /^(https?:\/\/|ipfs:\/\/|ar:\/\/)\S+$/i.test(rawImage) ? rawImage : "";
  const body = {
    name,
    symbol,
    description: `${name} ($${symbol}), launched on Stovia: the memecoin survival market. https://www.stovia.xyz`,
    image,
    external_url: "https://www.stovia.xyz",
    properties: image ? { files: [{ uri: image, type: "image/png" }], category: "image" } : undefined,
  };
  return Response.json(body, {
    headers: {
      "cache-control": "public, max-age=31536000, immutable",
      "access-control-allow-origin": "*",
    },
  });
}
