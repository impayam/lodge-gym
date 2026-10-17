// Settings → AI reports and Settings → Backup and export (SPEC-v8 §6.06; from Settings since Profile replaced Me, SPEC-v12
// M15 §3.0): each on its own screen.

import { ScreenHead } from "../components/ScreenHead";
import { AiSettings, Backups } from "./Settings";

export function AiReports() {
  return (
    <main class="page" data-testid="ai-screen">
      <ScreenHead title="AI reports" sub="Settings" />
      <AiSettings />
    </main>
  );
}

export function Backup() {
  return (
    <main class="page" data-testid="backup-screen">
      <ScreenHead title="Backup and export" sub="Settings" />
      <Backups />
    </main>
  );
}
