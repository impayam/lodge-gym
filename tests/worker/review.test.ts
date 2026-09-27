import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { toStringList } from "../../worker/data";
import type { Bootstrap, WeeklyReview } from "../../worker/lib/types";
import { Client, resetAuth, setupOwner } from "./helpers";

let client: Client;
beforeAll(async () => {
  await resetAuth();
  ({ client } = await setupOwner("192.0.2.99"));
});

const insert = (id: string, week: string, created: string, highlights: string, suggestions: string) =>
  env.DB.prepare("INSERT INTO weekly_reviews (id, week_start, created_at, summary_fa, highlights, suggestions) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(id, week, created, `مرور ${id}`, highlights, suggestions)
    .run();

describe("weekly reviews (written by Claude into D1)", () => {
  it("bootstrap and /reviews/latest return the newest week (latest write wins within a week)", async () => {
    expect(((await (await client.fetch("/api/bootstrap")).json()) as Bootstrap).review).toBeNull();
    await insert("a", "2026-09-14", "2026-09-21T08:00:00Z", '["سه جلسه"]', '["پرس سینه ۱۴۰"]');
    await insert("b", "2026-09-21", "2026-09-28T08:00:00Z", '["چهار جلسه کامل"]', '["یک ست بیشتر برای پشت ران"]');
    await insert("c", "2026-09-21", "2026-09-28T09:30:00Z", '["چهار جلسه کامل", "رکورد اسکوات"]', '[]');
    const b = (await (await client.fetch("/api/bootstrap")).json()) as Bootstrap;
    expect(b.review).toEqual({ id: "c", week_start: "2026-09-21", created_at: "2026-09-28T09:30:00Z", summary_fa: "مرور c", highlights: ["چهار جلسه کامل", "رکورد اسکوات"], suggestions: [] });
    const r = (await (await client.fetch("/api/reviews/latest")).json()) as { review: WeeklyReview };
    expect(r.review.id).toBe("c");
  });

  it("the table rejects invalid JSON", async () => {
    await expect(insert("bad", "2026-09-21", "2026-09-28T10:00:00Z", "not json", "[]")).rejects.toThrow();
  });

  it("tolerates object items and plain strings", () => {
    expect(toStringList('[{"title":"حجم","detail":"پشت ۱۳ ست"},{"text":"خواب"},"پروتئین"]')).toEqual(["حجم: پشت ۱۳ ست", "خواب", "پروتئین"]);
    expect(toStringList('"یک نکته"')).toEqual(["یک نکته"]);
    expect(toStringList("[]")).toEqual([]);
    expect(toStringList(null)).toEqual([]);
  });
});
