// Weekly reviews (table weekly_reviews, written by Claude into D1). Read-only in the app. SPEC-v7 M9d replaced the card
// on Home and Reports with the training overview; every review stays readable under History → Weekly reviews.
// The review text stays in Persian (SPEC-v2 M6), so its content is rendered right-to-left inside the English UI.

import { useEffect, useState } from "preact/hooks";
import type { WeeklyReview } from "../../../worker/lib/types";
import { addDays } from "../../../worker/lib/time";
import { cachedReviews, fetchReviews } from "../ai";
import { ApiError } from "../api";
import { dayMonth } from "../format";
import { navigate, setState, useStore } from "../store";

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

/** History → Weekly reviews: every review, newest week first. Offline it shows the last saved list (or the latest one). */
export function WeeklyReviews() {
  const latest = useStore((s) => s.boot?.review ?? null);
  const [list, setList] = useState<WeeklyReview[] | null>(null);
  const [offline, setOffline] = useState(false);
  useEffect(() => {
    let stop = false;
    void (async () => {
      try {
        const r = await fetchReviews();
        if (!stop) setList(r);
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return setState({ auth: "login" });
        const cached = await cachedReviews();
        if (stop) return;
        setList(cached ?? (latest ? [latest] : []));
        setOffline(true);
      }
    })();
    return () => {
      stop = true;
    };
  }, []);
  return (
    <>
      <button type="button" class="linkbtn" onClick={() => navigate("history")}>
        ← History
      </button>
      <h2>Weekly reviews</h2>
      {offline ? <div class="banner">Offline: showing the last saved copy.</div> : null}
      {!list ? (
        <div class="empty">Loading…</div>
      ) : !list.length ? (
        <div class="empty">No weekly reviews yet.</div>
      ) : (
        <div class="stack" data-testid="weekly-reviews">
          {list.map((r) => (
            <WeeklyReviewCard review={r} />
          ))}
        </div>
      )}
    </>
  );
}
