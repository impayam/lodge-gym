import { useEffect } from "preact/hooks";
import type { WorkoutSession } from "../../../worker/lib/types";
import { monthLabel, plural } from "../format";
import { sortedSessions } from "../model";
import { loadAllHistory, useStore } from "../store";
import { HistoryItem } from "./HistoryItem";

export function History() {
  const boot = useStore((s) => s.boot)!;
  const sessions = useStore((s) => s.sessions);
  useEffect(() => {
    void loadAllHistory();
  }, []);
  const all = sortedSessions(sessions);
  if (!all.length)
    return (
      <>
        <h2>History</h2>
        <div class="empty">No sessions yet.</div>
      </>
    );
  const groups = new Map<string, WorkoutSession[]>();
  for (const s of all) {
    const k = monthLabel(s.local_date);
    groups.set(k, [...(groups.get(k) ?? []), s]);
  }
  return (
    <>
      {[...groups].map(([month, list]) => (
        <>
          <h2>
            {month} <small>· {plural(list.length, "session")}</small>
          </h2>
          <div class="stack">
            {list.map((s) => (
              <HistoryItem s={s} boot={boot} />
            ))}
          </div>
        </>
      ))}
    </>
  );
}
