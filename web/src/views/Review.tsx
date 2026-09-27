// «مرور هفتگی»: the latest weekly review Claude wrote into D1 (table weekly_reviews). Read-only in the app.

import { useState } from "preact/hooks";
import { addDays } from "../../../worker/lib/time";
import { jalaliShort } from "../format";
import { useStore } from "../store";

export function WeeklyReviewCard() {
  const review = useStore((s) => s.boot?.review ?? null);
  const [open, setOpen] = useState(false);
  if (!review) return null;
  const long = review.summary_fa.length > 220 || review.highlights.length + review.suggestions.length > 4;
  return (
    <section class="card review stack" data-testid="weekly-review">
      <div class="kv">
        <span class="eyebrow">مرور هفتگی</span>
        <span class="muted" style={{ fontSize: "12px" }}>
          هفته‌ی {jalaliShort(review.week_start)} تا {jalaliShort(addDays(review.week_start, 6))}
        </span>
      </div>
      <p class={`summary${long && !open ? " clamp" : ""}`}>{review.summary_fa}</p>
      {!long || open ? (
        <>
          {review.highlights.length ? (
            <div>
              <b class="rv-title">نکته‌های خوب</b>
              <ul class="rv-list">
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
              <b class="rv-title">پیشنهادها برای هفته‌ی بعد</b>
              <ul class="rv-list">
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
          {open ? "بستن" : "ادامه"}
        </button>
      ) : null}
    </section>
  );
}
