import { SectionShell } from "@/components/app/SectionShell";
import { Leaderboard } from "@/components/app/Leaderboard";

export const metadata = { title: "Reputation leaderboard — Stovia" };

export default function LeaderboardPage() {
  return (
    <SectionShell k="leaderboard">
      <Leaderboard />
    </SectionShell>
  );
}
