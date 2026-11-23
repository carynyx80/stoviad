import { SectionShell } from "@/components/app/SectionShell";
import { LaunchForm } from "@/components/app/LaunchForm";

export const metadata = { title: "Launch a token — Stovia" };

export default function LaunchPage() {
  return (
    <SectionShell k="launch">
      <LaunchForm />
    </SectionShell>
  );
}
