import { SectionShell } from "@/components/app/SectionShell";
import { MarketsList } from "@/components/app/MarketsList";

export const metadata = { title: "Live markets — Stovia" };

export default function MarketsPage() {
  return (
    <SectionShell k="markets">
      <MarketsList />
    </SectionShell>
  );
}
