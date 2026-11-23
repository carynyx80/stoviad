import { ImageResponse } from "next/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: "#050403" }}>
        <svg width="132" height="132" viewBox="20 20 92 92">
          <path d="M66 24 A42 42 0 0 1 66 108 A21 21 0 0 1 66 66 A21 21 0 0 0 66 24 Z" fill="#8e0b0b" />
          <circle cx="66" cy="66" r="42" fill="none" stroke="#c4161c" strokeWidth="3" />
        </svg>
      </div>
    ),
    size,
  );
}
