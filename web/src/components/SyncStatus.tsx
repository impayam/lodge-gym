// Sync state in a screen header (SPEC-v8 §6.01): a dot coloured by state (Payam, 2026-10-14) and the state in words;
// tapping syncs now.

import { fmtNum } from "../../../worker/lib/digits";
import { syncNow, useStore } from "../store";

export function SyncStatus() {
  const sync = useStore((s) => s.sync);
  const state = !sync.online ? "offline" : sync.error ? "error" : sync.pending ? "pending" : "synced";
  const text = !sync.online
    ? sync.pending
      ? `Offline · ${fmtNum(sync.pending)} pending`
      : "Offline"
    : sync.error
      ? "Sync error"
      : sync.pending
        ? `${fmtNum(sync.pending)} pending`
        : "Synced";
  return (
    <button type="button" class="sync-status press" data-state={state} data-testid="sync-chip" title={sync.error ?? ""} onClick={() => void syncNow()}>
      <span class="sync-status__dot" aria-hidden="true" />
      {text}
    </button>
  );
}
