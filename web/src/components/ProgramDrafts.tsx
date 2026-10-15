// Saved program drafts (SPEC-v2 §8.6): New program drafts and the coach's drafts (SPEC-v9 M12, Add to Planner), in
// Me → Program and in Settings. Opening one shows it with Approve.

import { useEffect, useState } from "preact/hooks";
import type { ProgramInfo } from "../../../worker/lib/types";
import { instantShort } from "../format";
import { loadProgramVersions, openProgramEditor, useStore } from "../store";
import { IconChevron } from "./PulseIcons";
import { LoadError, Loading } from "./States";

/** `card`: on a screen of its own (Me → Program), the list sits in a card when there are drafts. */
export function ProgramDrafts({ testId = "program-drafts", card = false }: { testId?: string; card?: boolean }) {
  const boot = useStore((s) => s.boot)!;
  const [drafts, setDrafts] = useState<ProgramInfo[] | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [round, setRound] = useState(0);
  useEffect(() => {
    setFailure(null);
    loadProgramVersions()
      .then((list) => setDrafts(list.filter((p) => p.status === "draft")))
      .catch((e) => setFailure(e));
  }, [round]);
  return (
    <div class={card && drafts?.length ? "card l-col l-gap-10" : "l-col"} data-testid={testId}>
      {/* Saved drafts, when there are any. */}
      {drafts === null && failure !== null ? (
        <LoadError what="Couldn't load your saved drafts." error={failure} onRetry={() => setRound((n) => n + 1)} />
      ) : drafts === null ? (
        <Loading label="Loading your saved drafts" heights={[56]} />
      ) : null}
      {drafts?.length ? (
        <div class="l-col">
          <h3 class="form-field__label l-m0">Drafts</h3>
          {drafts.map((d) => (
            <button type="button" class="list-row press" data-testid="open-draft" onClick={() => openProgramEditor(d.id)}>
              <span class="list-row__text">
                <span class="t-title">{d.name}</span>
                <span class="caption num">
                  {d.generated_by === "coach" ? "From the coach · " : ""}Saved {instantShort(d.created_at, boot.settings.timezone)}
                </span>
              </span>
              <span class="list-row__chevron">
                <IconChevron size={16} />
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
