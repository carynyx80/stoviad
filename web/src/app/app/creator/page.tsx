import { SectionShell } from "@/components/app/SectionShell";
import { CreatorVault } from "@/components/app/CreatorVault";

export const metadata = { title: "Creator vault — Stovia" };

export default function CreatorPage() {
  return (
    <SectionShell k="creator">
      <CreatorVault />
    </SectionShell>
  );
}
