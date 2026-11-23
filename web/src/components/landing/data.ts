export type TickerToken = {
  sym: string;
  status: "SURVIVED" | "DEAD" | "LIVE";
  pct: string;
  age: string;
};

// Deterministic sample feed (no randomness in render).
export const TICKER: TickerToken[] = [
  { sym: "$GRIM", status: "SURVIVED", pct: "+412%", age: "72h" },
  { sym: "$RUGLY", status: "DEAD", pct: "-99.2%", age: "4h" },
  { sym: "$MOTH", status: "LIVE", pct: "+38%", age: "11h" },
  { sym: "$BONEDOG", status: "SURVIVED", pct: "+1,204%", age: "72h" },
  { sym: "$EXIT", status: "DEAD", pct: "-100%", age: "19m" },
  { sym: "$SALT", status: "SURVIVED", pct: "+88%", age: "72h" },
  { sym: "$VELVET", status: "DEAD", pct: "-97.6%", age: "2h" },
  { sym: "$OMEN", status: "LIVE", pct: "+201%", age: "41h" },
  { sym: "$CRYPT", status: "SURVIVED", pct: "+640%", age: "72h" },
  { sym: "$LARP", status: "DEAD", pct: "-99.9%", age: "53m" },
  { sym: "$EMBER", status: "SURVIVED", pct: "+152%", age: "72h" },
  { sym: "$HUSK", status: "DEAD", pct: "-94.1%", age: "7h" },
];
