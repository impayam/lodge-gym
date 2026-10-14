// Me → AI reports and Me → Backup and export (SPEC-v8 §6.06): the Settings sections of the same name, each on its own
// screen pushed from Me.

import { ScreenHead } from "../components/ScreenHead";
import { AiSettings, Backups } from "./Settings";

export function AiReports() {
  return (
    <main class="page" data-testid="ai-screen">
      <ScreenHead title="AI reports" sub="Me" />
      <AiSettings />
    </main>
  );
}

export function Backup() {
  return (
    <main class="page" data-testid="backup-screen">
      <ScreenHead title="Backup and export" sub="Me" />
      <Backups />
    </main>
  );
}
