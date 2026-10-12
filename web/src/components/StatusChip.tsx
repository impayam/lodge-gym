import { fmtNum } from "../../../worker/lib/digits";
import { syncNow, useStore } from "../store";

export function StatusChip() {
  const sync = useStore((s) => s.sync);
  const offline = !sync.online;
  const cls = offline ? "offline" : sync.error ? "error" : sync.pending ? "pending" : "";
  const text = offline
    ? sync.pending
      ? `Offline · ${fmtNum(sync.pending)} pending`
      : "Offline"
    : sync.error
      ? "Sync error"
      : sync.pending
        ? `${fmtNum(sync.pending)} pending`
        : "Synced";
  return (
    <button type="button" class={`chip ${cls}`} data-testid="sync-chip" title={sync.error ?? ""} onClick={() => void syncNow()}>
      <i />
      {text}
    </button>
  );
}
