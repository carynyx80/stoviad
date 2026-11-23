import { SectionShell } from "@/components/app/SectionShell";
import { PortfolioView } from "@/components/app/PortfolioView";

export const metadata = { title: "Portfolio — Stovia" };

export default function PortfolioPage() {
  return (
    <SectionShell k="portfolio">
      <PortfolioView />
    </SectionShell>
  );
}
