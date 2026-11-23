import { SectionShell } from "@/components/app/SectionShell";
import { BetForm } from "@/components/app/BetForm";

export const metadata = { title: "Sealed bets — Stovia" };

export default function BetsPage() {
  return (
    <SectionShell k="bets">
      <BetForm />
    </SectionShell>
  );
}
