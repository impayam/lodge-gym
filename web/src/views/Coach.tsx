// Coach (SPEC-v8 §6.07), the screen shell only: the chat itself comes with M12 (Payam, 2026-10-14). The header
// states what the coach will know; the suggestions and the composer are shown, disabled.

import { useEffect } from "preact/hooks";
import { IconBack, IconCamera, IconPlus, IconSend } from "../components/PulseIcons";
import { dayMonth, plural } from "../format";
import { trainingSince } from "../model";
import { goBack, loadAllHistory, useStore } from "../store";

const SUGGESTIONS = ["سینه‌ام چطوره؟", "عکس امروزم رو بررسی کن", "هفته بعد چی بزنم؟"];

export function Coach() {
  const boot = useStore((s) => s.boot)!;
  const sessions = useStore((s) => s.sessions);
  useEffect(() => {
    void loadAllHistory();
  }, []);
  const since = trainingSince(boot);
  const done = Object.values(sessions).filter((s) => s.status === "done" && (!since || s.local_date >= since)).length;

  return (
    <main class="page" data-testid="coach">
      <header class="screen-head">
        <button type="button" class="clay press btn-icon t-muted" aria-label="Back" onClick={goBack}>
          <IconBack size={20} />
        </button>
        <div class="l-col l-gap-2 l-grow">
          <h1 class="screen-head__title l-m0">Coach</h1>
          <span class="screen-head__sub">
            Knows your {plural(done, "session")}
            {since ? ` since ${dayMonth(since)}` : ""}
          </span>
        </div>
        <button type="button" class="clay press btn-icon t-pink" aria-label="New chat" disabled>
          <IconPlus size={20} />
        </button>
      </header>

      <p class="state l-m0" data-testid="coach-empty">
        The coach comes with M12.
      </p>

      <div class="coach-dock">
        <div class="chip-scroll" aria-label="Suggested questions">
          {SUGGESTIONS.map((q) => (
            <button type="button" class="clay press chip fa" dir="rtl" lang="fa" disabled>
              {q}
            </button>
          ))}
        </div>
        <div class="composer" aria-disabled="true">
          <button type="button" class="clay press btn-icon t-violet" aria-label="Attach a photo" disabled>
            <IconCamera size={20} />
          </button>
          <label class="l-grow l-row">
            <span class="l-sr">Message the coach</span>
            <input class="composer__input fa" dir="auto" placeholder="Ask about your training" disabled />
          </label>
          <button type="button" class="clay press btn-icon t-orange" aria-label="Send" disabled>
            <IconSend size={20} />
          </button>
        </div>
      </div>
    </main>
  );
}
