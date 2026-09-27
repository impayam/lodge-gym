import { faNum } from "../../../worker/lib/digits";
import { syncNow, useStore } from "../store";

export function StatusChip() {
  const sync = useStore((s) => s.sync);
  const offline = !sync.online;
  const cls = offline ? "offline" : sync.error ? "error" : sync.pending ? "pending" : "";
  const text = offline
    ? sync.pending
      ? `آفلاین · ${faNum(sync.pending)} در صف`
      : "آفلاین"
    : sync.error
      ? "خطای همگام‌سازی"
      : sync.pending
        ? `${faNum(sync.pending)} در صف`
        : "همگام";
  return (
    <button type="button" class={`chip ${cls}`} data-testid="sync-chip" title={sync.error ?? ""} onClick={() => void syncNow()}>
      <i />
      {text}
    </button>
  );
}
