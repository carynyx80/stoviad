import { ImageResponse } from "next/og";

export const alt = "Stovia — bet on what survives";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function TwitterImage() {
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", background: "#050403", gap: 36 }}>
        <svg width="220" height="220" viewBox="20 20 92 92">
          <path d="M66 24 A42 42 0 0 1 66 108 A21 21 0 0 1 66 66 A21 21 0 0 0 66 24 Z" fill="#8e0b0b" />
          <circle cx="66" cy="66" r="42" fill="none" stroke="#c4161c" strokeWidth="2" />
        </svg>
        <div style={{ display: "flex", fontSize: 84, letterSpacing: 10, color: "#c4161c", fontFamily: "serif" }}>Stovia</div>
        <div style={{ display: "flex", fontSize: 28, letterSpacing: 6, color: "#8e0b0b", textTransform: "uppercase" }}>Bet on what survives · Solana</div>
      </div>
    ),
    size,
  );
}
