// Site-wide top strip: "Powered by Helius Privacy Rings". Server component, no JS.
export default function HeliusBar() {
  return (
    <a
      href="https://www.helius.dev/docs/privacy"
      target="_blank"
      rel="noopener noreferrer"
      aria-label="Powered by Helius Privacy Rings"
      className="group relative z-[60] flex h-8 items-center justify-center gap-3 overflow-hidden border-b border-blood/60 bg-[linear-gradient(90deg,#3a0405_0%,#8e0b0b_50%,#3a0405_100%)] px-4 font-mono text-[10px] uppercase tracking-[0.28em] text-bone sm:text-[11px]"
    >
      <span aria-hidden className="relative flex h-2 w-2">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-gold opacity-60 motion-reduce:animate-none" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-gold" />
      </span>
      <span className="whitespace-nowrap">
        Powered by <span className="font-semibold text-gold">Helius Privacy Rings</span>
      </span>
      <span aria-hidden className="hidden text-bone/50 sm:inline">·</span>
      <span className="hidden whitespace-nowrap text-bone/70 sm:inline">amounts sealed on Solana mainnet</span>
      <span aria-hidden className="text-gold transition-transform group-hover:translate-x-1">→</span>
    </a>
  );
}
