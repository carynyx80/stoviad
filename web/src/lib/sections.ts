export type SectionKey = "launch" | "markets" | "bets" | "portfolio" | "creator" | "leaderboard";

export type Section = {
  key: SectionKey;
  href: string;
  label: string;
  /** Display line 1 (grotesque, heavy) */
  title: string;
  /** Display line 2 (serif italic accent) */
  accent: string;
  pitch: string;
  cta: string;
  tone: "gold" | "blood";
  tag: string;
};

export const SECTIONS: Section[] = [
  {
    key: "launch",
    href: "/app/launch",
    label: "Launch a token",
    title: "Launch",
    accent: "something brave.",
    pitch: "Mint a memecoin, post a bond, set a target. The market decides if it lives.",
    cta: "Open launchpad",
    tone: "gold",
    tag: "Create",
  },
  {
    key: "markets",
    href: "/app/markets",
    label: "Live markets",
    title: "Markets",
    accent: "on the clock.",
    pitch: "Every token is a countdown. Watch the field race its own deadline in real time.",
    cta: "Open markets",
    tone: "blood",
    tag: "Watch",
  },
  {
    key: "bets",
    href: "/app/bets",
    label: "Sealed bets",
    title: "Sealed",
    accent: "until the end.",
    pitch: "Bet it survives or bet it dies. Side committed, amount ringed — nobody sees your hand.",
    cta: "Place a sealed bet",
    tone: "gold",
    tag: "Bet",
  },
  {
    key: "portfolio",
    href: "/app/portfolio",
    label: "Portfolio",
    title: "Portfolio",
    accent: "your quiet hand.",
    pitch: "Your launches, your sealed positions, your reveals — visible only to you.",
    cta: "Open portfolio",
    tone: "blood",
    tag: "Hold",
  },
  {
    key: "creator",
    href: "/app/creator",
    label: "Creator vault",
    title: "Vault",
    accent: "a tenth of a percent.",
    pitch: "Creators earn 0.1% of every trade on their token. Claim it whenever you like.",
    cta: "Open creator vault",
    tone: "gold",
    tag: "Earn",
  },
  {
    key: "leaderboard",
    href: "/app/leaderboard",
    label: "Reputation leaderboard",
    title: "Reputation",
    accent: "earned in survivals.",
    pitch: "Creators ranked by what actually made it. Rugs remembered, survivors crowned.",
    cta: "Open leaderboard",
    tone: "blood",
    tag: "Rank",
  },
];

export const sectionByKey = (k: SectionKey) => SECTIONS.find((s) => s.key === k)!;
export const sectionIndex = (k: SectionKey) => SECTIONS.findIndex((s) => s.key === k);
