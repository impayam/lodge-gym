// Weekly reviews (table weekly_reviews, written by Claude into D1). Read-only in the app. SPEC-v7 M9d replaced the card
// on Home and Reports with the training overview; every review stays readable from History → Reports timeline.
// The review text stays in Persian (SPEC-v2 M6), so its content is rendered right-to-left inside the English UI.

import { useState } from "preact/hooks";
import type { WeeklyReview } from "../../../worker/lib/types";
import { addDays } from "../../../worker/lib/time";
import { dayMonth } from "../format";

export function WeeklyReviewCard({ review }: { review: WeeklyReview }) {
  const [open, setOpen] = useState(false);
  const long = review.summary_fa.length > 220 || review.highlights.length + review.suggestions.length > 4;
  return (
    <section class="card review stack" data-testid="weekly-review" data-review={review.id}>
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
