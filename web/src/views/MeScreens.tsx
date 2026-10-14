// Me → AI reports and Me → Backup and export (SPEC-v8 §6.06): the Settings sections of the same name, each on its own
// screen pushed from Me.

import { goBack } from "../store";
import { AiSettings, Backups } from "./Settings";

function Back() {
  return (
    <button type="button" class="linkbtn" data-testid="back" onClick={goBack}>
      ← Me
    </button>
  );
}

export function AiReports() {
  return (
    <>
      <Back />
      <h2>AI reports</h2>
      <AiSettings />
    </>
  );
}

export function Backup() {
  return (
    <>
      <Back />
      <h2>Backup and export</h2>
      <Backups />
    </>
  );
}
