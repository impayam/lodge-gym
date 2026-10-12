// Weekly review: the latest review Claude wrote into D1 (table weekly_reviews). Read-only in the app.
// The review text stays in Persian (SPEC-v2 M6), so its content is rendered right-to-left inside the English UI.

import { useState } from "preact/hooks";
import { addDays } from "../../../worker/lib/time";
import { dayMonth } from "../format";
import { useStore } from "../store";

export function WeeklyReviewCard() {
  const review = useStore((s) => s.boot?.review ?? null);
  const [open, setOpen] = useState(false);
  if (!review) return null;
  const long = review.summary_fa.length > 220 || review.highlights.length + review.suggestions.length > 4;
  return (
    <section class="card review stack" data-testid="weekly-review">
      <div class="kv">
        <span class="eyebrow">Weekly review</span>
        <span class="muted" style={{ fontSize: "12px" }}>
          Week of {dayMonth(review.week_start)} – {dayMonth(addDays(review.week_start, 6))}
        </span>
      </div>
      <p class={`summary${long && !open ? " clamp" : ""}`} dir="rtl" lang="fa">
        {review.summary_fa}
      </p>
      {!long || open ? (
        <>
          {review.highlights.length ? (
            <div>
              <b class="rv-title">What went well</b>
              <ul class="rv-list" dir="rtl" lang="fa">
                {review.highlights.map((h) => (
                  <li>
                    <span aria-hidden="true">✓</span> {h}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {review.suggestions.length ? (
            <div>
              <b class="rv-title">Suggestions for next week</b>
              <ul class="rv-list" dir="rtl" lang="fa">
                {review.suggestions.map((h) => (
                  <li>
                    <span aria-hidden="true">←</span> {h}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      ) : null}
      {long ? (
        <button type="button" class="linkbtn" onClick={() => setOpen(!open)}>
          {open ? "Show less" : "Show more"}
        </button>
      ) : null}
    </section>
  );
}
