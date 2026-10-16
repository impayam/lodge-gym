// Weekly reviews (table weekly_reviews, written by Claude into D1). Read-only in the app. SPEC-v7 M9d replaced the card
// on Home and Reports with the training overview; every review stays readable from the reports timeline (in Reports
// since Step 3).
// The review text stays in Persian (SPEC-v2 M6), so its content is rendered right-to-left inside the English UI.

import { useState } from "preact/hooks";
import type { WeeklyReview } from "../../../worker/lib/types";
import { addDays } from "../../../worker/lib/time";
import { dayMonth } from "../format";

export function WeeklyReviewCard({ review }: { review: WeeklyReview }) {
  const [open, setOpen] = useState(false);
  const long = review.summary_fa.length > 220 || review.highlights.length + review.suggestions.length > 4;
  const list = (title: string, items: string[], mark: string) =>
    items.length ? (
      <div class="l-col l-gap-4">
        <h3 class="card__title l-m0">{title}</h3>
        <ul class="fa prose-fa" dir="rtl" lang="fa">
          {items.map((h) => (
            <li>
              <span aria-hidden="true">{mark}</span> {h}
            </li>
          ))}
        </ul>
      </div>
    ) : null;
  return (
    <section class="card l-col l-gap-12" data-testid="weekly-review" data-review={review.id} aria-label={`Weekly review, week of ${dayMonth(review.week_start)} – ${dayMonth(addDays(review.week_start, 6))}`}>
      <p class={`fa prose-fa${long && !open ? " prose-fa--clamp" : ""}`} dir="rtl" lang="fa">
        {review.summary_fa}
      </p>
      {!long || open ? (
        <>
          {list("What went well", review.highlights, "✓")}
          {list("Suggestions for next week", review.suggestions, "←")}
        </>
      ) : null}
      {long ? (
        <div class="l-row">
          <button type="button" class="clay press btn-sm btn--fit t-muted" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? "Show less" : "Show more"}
          </button>
        </div>
      ) : null}
    </section>
  );
}
