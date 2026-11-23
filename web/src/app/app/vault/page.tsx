import { SectionShell } from "@/components/app/SectionShell";
import { PrivateVault } from "@/components/app/PrivateVault";

export const metadata = { title: "Private vault — Stovia" };

export default function VaultPage() {
  return (
    <SectionShell k="vault">
      <PrivateVault />
    </SectionShell>
  );
}
