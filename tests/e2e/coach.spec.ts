import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "./fixtures";
import { aiCalls, aiMode, goTo, resetPrograms, setOffline, signIn, sql } from "./helpers";

// SPEC-v9 M12 Coach chat, with the Claude API mocked (scripts/e2e-ai-mock.mjs streams answers like the real API).
test.describe.configure({ mode: "serial" });

const clearCoach = () => sql("DELETE FROM coach_attachments; DELETE FROM coach_messages; DELETE FROM coach_threads");

test.beforeEach(async ({ context, baseURL }) => {
  clearCoach();
  await aiMode({ coach: "ok" });
  await signIn(context, baseURL!);
});
test.afterAll(async () => {
  clearCoach();
  resetPrograms();
  sql("DELETE FROM photos");
  await aiMode({ coach: "ok" });
});

async function openCoach(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Ask the coach" }).click();
  await expect(page.getByTestId("coach")).toBeVisible();
}

/** Records whether the typing line ever appeared (an answer can stream faster than a poll). */
async function watchTyping(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __typing?: boolean };
    w.__typing = false;
    new MutationObserver(() => {
      if (document.querySelector('[data-testid="coach-typing"]')) w.__typing = true;
    }).observe(document.body, { childList: true, subtree: true });
  });
  return () => page.evaluate(() => (window as unknown as { __typing?: boolean }).__typing === true);
}

/** Attach → Choose from library, as on the phone: the sheet closes and the photo picker opens. */
async function pickPhoto(page: Page, file: string) {
  await page.getByTestId("coach-attach").click();
  await expect(page.getByTestId("coach-attach-sheet")).toBeVisible();
  const chooser = page.waitForEvent("filechooser");
  await page.getByTestId("coach-choose-photo").click();
  await (await chooser).setFiles(file);
  await expect(page.getByTestId("coach-attach-sheet")).toBeHidden();
  await expect(page.getByTestId("coach-attachments").locator("img")).toHaveCount(1);
}

/** How the e2e mock words a group's status (a group with 0 sets of a target is under it). */
const STATUS_WORD: Record<string, string> = { none: "under target", under: "under target", on: "on target", over: "over target" };

async function ask(page: Page, text: string) {
  await page.getByTestId("coach-input").fill(text);
  await page.getByTestId("coach-send").click();
}

/** A JPEG with an EXIF block holding GPS data. */
async function exifJpeg(page: Page): Promise<string> {
  const b64 = await page.evaluate(() => {
    const cv = document.createElement("canvas");
    cv.width = 300;
    cv.height = 400;
    const ctx = cv.getContext("2d")!;
    ctx.fillStyle = "#a66";
    ctx.fillRect(0, 0, 300, 400);
    return cv.toDataURL("image/jpeg", 0.9).split(",")[1];
  });
  const jpeg = Buffer.from(b64, "base64");
  const payload = Buffer.concat([Buffer.from("Exif\0\0MM\0*GPSLatitude 39.7392 N", "latin1")]);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, (payload.length + 2) >> 8, (payload.length + 2) & 255]), payload]);
  const file = join(mkdtempSync(join(tmpdir(), "lg-coach-")), "photo.jpg");
  writeFileSync(file, Buffer.concat([jpeg.subarray(0, 2), app1, jpeg.subarray(2)]));
  return file;
}

test("a question streams: the coach's progress note in the typing line, the app's data card, the answer and its cost; the chat is saved", async ({ page }) => {
  await openCoach(page);
  await expect(page.getByTestId("coach-empty")).toBeVisible();
  await expect(page.getByLabel("Suggested questions")).toContainText("این هفته چطور بودم؟");
  const typed = await watchTyping(page);
  await ask(page, "How was my week?");

  const answer = page.getByTestId("coach-answer");
  await expect(answer).toContainText("So far this week chest is");
  expect(await typed()).toBe(true);
  await expect(answer).toContainText("I'll count this week's sets.");
  const card = answer.locator('[data-card="get_volume"]');
  await expect(card).toContainText("Sets vs target");
  await expect(card).toContainText("Numbers calculated by the app from your logs");
  // The mock writes its sentence from the card's numbers, as the real coach must: text and card agree, so no note.
  const status = await card.locator('tr[data-row="chest"]').getAttribute("data-status");
  await expect(answer).toContainText(`So far this week chest is ${STATUS_WORD[status!]}`);
  await expect(page.getByTestId("coach-cost")).toBeVisible();
  await expect(page.getByTestId("coach-status-note")).toHaveCount(0);
  await expect(answer.locator("li")).toHaveText(["Bench first", "Then flyes"]);
  await expect(page.getByTestId("coach-cost")).toHaveText(/^(~\$\d+\.\d\d|<\$0\.01)$/);

  // Opus 5.5 the approved way: never a forced tool, progress updates as text, cached prompt, thinking replayed.
  const { last, by_kind } = await aiCalls();
  expect(last!.kind).toBe("coach");
  expect(last!.tool_choice).toBeNull();
  expect(last!.thinking).toEqual({ type: "adaptive", display: "updates", block_binding: { prefix_mismatch_behavior: "drop_block" } });
  expect(last!.betas).toContain("thinking-display-updates-2026-08-18");
  expect(last!.max_tokens).toBe(8000);
  expect(last!.system_cached && last!.last_block_cached).toBe(true);
  expect(by_kind.coach!.thinking_replayed).toBeGreaterThan(0);

  // Saved: after a reload the chat is in the list and opens with its answer and card.
  await page.reload();
  await page.getByRole("button", { name: "Ask the coach" }).click();
  await page.getByTestId("coach-chats").click();
  await page.getByTestId("coach-thread").filter({ hasText: "How was my week?" }).getByTestId("coach-thread-open").click();
  await expect(page.getByTestId("coach-answer")).toContainText("So far this week chest is");
  await expect(page.locator('[data-card="get_volume"]')).toBeVisible();
});

test("a program draft card: Change prefills the question; Add to Planner saves an inactive draft under Profile → Program → Drafts", async ({ page }) => {
  const activeBefore = sql("SELECT id FROM programs WHERE active = 1");
  await openCoach(page);
  await ask(page, "Write me a chest program");
  const draft = page.getByTestId("coach-draft");
  await expect(draft).toContainText("Chest focus · 2 days");
  await expect(draft).toContainText("Left out (not in the library): hack_squat_machine");
  // Exercises by their English names, never by id.
  // Dumbbell Flyes is only in the library (not on the phone): its name comes with the draft.
  await expect(draft).toContainText("Barbell Bench Press 4 × 5, A Cable Chest Fly 3 × 10–12, A Dumbbell Lateral Raise 3 × 12–15, Dumbbell Flyes 3 × 10–12");
  await expect(draft).toContainText("Barbell Back Squat 4 × 5");
  // Each day's estimated length is information (no limit); the generator's check is advice under the card.
  await expect(draft).toContainText(/Day 1 · Chest · about \d+ min/);
  await expect(draft).toContainText(/Day 2 · Legs · about \d+ min/);
  const warnings = page.getByTestId("coach-draft-warnings");
  await expect(warnings).toContainText("Worth knowing");
  await expect(warnings).toContainText("No hinge in the week.");
  await expect(draft.getByTestId("coach-add-draft")).toBeEnabled();
  await expect(draft.locator('[dir="rtl"]')).toContainText("سینه دو بار در هفته");

  await draft.getByTestId("coach-change-draft").click();
  await expect(page.getByTestId("coach-input")).toHaveValue("Change this draft: ");
  await page.getByTestId("coach-input").fill("");

  await draft.getByTestId("coach-add-draft").click();
  await expect(draft.getByTestId("coach-draft-added")).toContainText("Profile → Program → Drafts");
  expect(sql("SELECT name, active, generated_by FROM programs WHERE generated_by = 'coach'")).toEqual([{ name: "Chest focus · 2 days", active: 0, generated_by: "coach" }]);
  expect(sql("SELECT id FROM programs WHERE active = 1")).toEqual(activeBefore);

  // Open goes to Profile → Program, where the draft is listed with the other drafts.
  await draft.getByTestId("coach-open-drafts").click();
  const drafts = page.getByTestId("program-screen-drafts");
  await expect(drafts).toContainText("From the coach");
  await drafts.getByTestId("open-draft").filter({ hasText: "Chest focus · 2 days" }).click();
  const screen = page.getByTestId("coach-draft-screen");
  await expect(screen).toContainText("Day 1 · Chest");
  await expect(screen.getByTestId("coach-draft-exercise")).toHaveCount(5);
  await expect(screen.getByTestId("coach-draft-exercise").first()).toContainText("Barbell Bench Press");
  await expect(screen.getByTestId("coach-draft-exercise").nth(3)).toContainText("Dumbbell Flyes");
  await expect(screen.getByTestId("coach-draft-approve")).toBeVisible();
});

test("a photo is resized and stripped of EXIF before it is sent; Save to progress photos adds it to the gallery", async ({ page }) => {
  sql("DELETE FROM photos");
  await openCoach(page);
  await pickPhoto(page, await exifJpeg(page));
  await expect(page.getByTestId("coach-send")).toBeEnabled();
  await ask(page, "Look at my shoulders");
  await expect(page.getByTestId("coach-answer")).toContainText("visual estimate");
  expect((await aiCalls()).last!.images).toBe(1);

  const src = await page.getByTestId("coach-photo").getAttribute("data-src");
  const bytes = Buffer.from(await (await page.request.get(src!)).body());
  expect(bytes.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
  expect(bytes.toString("latin1")).not.toContain("Exif");
  expect(bytes.toString("latin1")).not.toContain("GPS");

  await page.getByTestId("coach-save-photo").click();
  await page.getByTestId("coach-pose-sheet").getByRole("button", { name: "Side" }).click();
  await expect.poll(() => sql("SELECT pose FROM photos"), { timeout: 20_000 }).toEqual([{ pose: "side" }]);
});

test("a failed answer shows Answer failed with Retry; Retry answers the same question", async ({ page }) => {
  await aiMode({ coach: "fail" });
  await openCoach(page);
  await ask(page, "How was my week?");
  await expect(page.getByTestId("coach-failed")).toContainText("Answer failed");
  await aiMode({ coach: "ok" });
  await page.getByTestId("coach-retry").click();
  await expect(page.getByTestId("coach-answer")).toContainText("So far this week chest is");
  await expect(page.getByTestId("coach-failed")).toHaveCount(0);
  expect(sql("SELECT COUNT(*) AS n FROM coach_messages WHERE role = 'user' AND content_json LIKE '%How was my week?%'")).toEqual([{ n: 1 }]);
});

test("offline: the composer needs a connection and a saved chat is still readable", async ({ page, context }) => {
  await openCoach(page);
  await ask(page, "How was my week?");
  await expect(page.getByTestId("coach-answer")).toContainText("So far this week chest is");
  // The answer is saved and the chat reloaded (the composer is free again): the phone has its copy.
  await expect(page.getByTestId("coach-input")).toBeEnabled();
  // The list once online, so the phone has it.
  await page.getByTestId("coach-chats").click();
  await expect(page.getByTestId("coach-thread")).toHaveCount(1);

  await setOffline(context, page, true);
  await page.getByTestId("coach-back").click();
  await expect(page.getByTestId("coach-input")).toBeDisabled();
  await expect(page.getByTestId("coach-input")).toHaveAttribute("placeholder", "Needs connection");
  await page.getByTestId("coach-chats").click();
  await page.getByTestId("coach-thread").getByTestId("coach-thread-open").click();
  await expect(page.getByTestId("coach-offline")).toBeVisible();
  await expect(page.getByTestId("coach-answer")).toContainText("So far this week chest is");
  await setOffline(context, page, false);
});

test("offline: the reload after an answer that comes back late shows as the offline copy, never hides the offline note", async ({ page, context }) => {
  // The reload after the answer is held in the page until the chat has been reopened offline (it once came back last
  // on a busy machine and replaced the offline copy). In the page, not page.route: WebKit holds every request, the
  // streamed answer too, while a route is set.
  await page.addInitScript(() => {
    const real = window.fetch.bind(window);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const hold = { held: false, release };
    (window as unknown as { __hold: typeof hold }).__hold = hold;
    let first = true;
    window.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
      if (!first || method !== "GET" || !/^\/api\/coach\/threads\/[^/]+$/.test(url.pathname)) return real(input, init);
      first = false;
      const res = await real(input, init);
      hold.held = true;
      await gate;
      return res;
    };
  });
  await openCoach(page);
  await ask(page, "How was my week?");
  await expect(page.getByTestId("coach-answer")).toContainText("So far this week chest is");
  await expect.poll(() => page.evaluate(() => (window as unknown as { __hold: { held: boolean } }).__hold.held)).toBe(true);
  await page.getByTestId("coach-chats").click();
  await expect(page.getByTestId("coach-thread")).toHaveCount(1);

  await setOffline(context, page, true);
  await page.getByTestId("coach-thread").getByTestId("coach-thread-open").click();
  // Not saved on the phone yet: it cannot load.
  await expect(page.getByTestId("coach-chat")).toContainText("Couldn't load this chat.");
  // The held reload arrives: its copy shows, still as the offline one.
  await page.evaluate(() => (window as unknown as { __hold: { release: () => void } }).__hold.release());
  await expect(page.getByTestId("coach-answer")).toContainText("So far this week chest is");
  await expect(page.getByTestId("coach-offline")).toBeVisible();
  await expect(page.getByTestId("coach-chat")).not.toContainText("Couldn't load this chat.");
  await expect(page.getByTestId("coach-input")).toBeDisabled();
  await setOffline(context, page, false);
});

test("archive and unarchive; Delete permanently removes only that archived chat, never training data or progress photos", async ({ page }) => {
  await openCoach(page);
  await ask(page, "How was my week?");
  await expect(page.getByTestId("coach-answer")).toContainText("So far this week");
  await page.getByTestId("coach-new").click();
  await pickPhoto(page, await exifJpeg(page));
  await expect(page.getByTestId("coach-send")).toBeEnabled();
  await ask(page, "Look at this");
  await expect(page.getByTestId("coach-answer")).toContainText("visual estimate");
  const photo = await page.getByTestId("coach-photo").getAttribute("data-src");

  const counts = () => sql("SELECT (SELECT COUNT(*) FROM workout_sessions) AS s, (SELECT COUNT(*) FROM set_entries) AS e, (SELECT COUNT(*) FROM photos) AS p, (SELECT COUNT(*) FROM programs) AS g");
  const before = counts();
  await page.getByTestId("coach-chats").click();
  const list = page.getByTestId("coach-list");
  await expect(list.getByTestId("coach-thread")).toHaveCount(2);
  await list.getByTestId("coach-thread").filter({ hasText: "Look at this" }).getByTestId("coach-archive").click();
  await expect(list.getByTestId("coach-thread")).toHaveCount(1);
  await page.getByTestId("coach-open-archived").click();
  const archived = page.getByTestId("coach-archived");
  await expect(archived.getByTestId("coach-thread")).toHaveCount(1);
  await archived.getByTestId("coach-unarchive").click();
  await expect(archived.getByTestId("coach-thread")).toHaveCount(0);
  await page.getByTestId("coach-back").click();
  await expect(list.getByTestId("coach-thread")).toHaveCount(2);
  await list.getByTestId("coach-thread").filter({ hasText: "Look at this" }).getByTestId("coach-archive").click();
  await page.getByTestId("coach-open-archived").click();
  await archived.getByTestId("coach-delete").click();
  await expect(page.getByTestId("coach-delete-sheet")).toContainText("This chat and its photos will be deleted for good");
  await page.getByTestId("coach-delete-confirm").click();
  await expect(archived.getByTestId("coach-thread")).toHaveCount(0);

  expect(sql("SELECT title FROM coach_threads")).toEqual([{ title: "How was my week?" }]);
  expect(sql("SELECT COUNT(*) AS n FROM coach_attachments")).toEqual([{ n: 0 }]);
  expect((await page.request.get(photo!)).status()).toBe(404);
  expect(counts()).toEqual(before);
});

test("an answer whose text names a status its card does not show gets a note under it; the answer stays as it is", async ({ page }) => {
  await aiMode({ coach: "mismatch" });
  await openCoach(page);
  await ask(page, "How was my week?");
  await expect(page.getByTestId("coach-cost")).toBeVisible();
  const answer = page.getByTestId("coach-answer");
  const status = await answer.locator('[data-card="get_volume"] tr[data-row="chest"]').getAttribute("data-status");
  const shown = status === "none" ? "under" : status!;
  const said = ({ under: "over", on: "under", over: "under" } as Record<string, string>)[shown];
  // The mock's text names another status on purpose; the text is shown unchanged and the note sits under it.
  await expect(answer).toContainText(`So far this week chest is ${said} target`);
  const note = page.getByTestId("coach-status-note");
  await expect(note).toHaveText("The numbers in the card are the app's; the text may be wrong.");
  await expect(answer.locator('[data-card="get_volume"] tr[data-row="chest"]')).toHaveAttribute("data-status", status!);
  // A saved chat shows the same note when opened again.
  await page.reload();
  await page.getByRole("button", { name: "Ask the coach" }).click();
  await page.getByTestId("coach-chats").click();
  await page.getByTestId("coach-thread").filter({ hasText: "How was my week?" }).getByTestId("coach-thread-open").click();
  await expect(page.getByTestId("coach-answer")).toContainText(`So far this week chest is ${said} target`);
  await expect(page.getByTestId("coach-status-note")).toBeVisible();
});

test("which days: the training pattern card from the last 4 weeks, and an answer from it or a question when unclear", async ({ page }) => {
  await openCoach(page);
  await ask(page, "Which days do I usually train?");
  const card = page.getByTestId("coach-answer").locator('[data-card="get_training_pattern"]');
  await expect(card).toContainText("Training days");
  await expect(card).toContainText("Numbers calculated by the app from your logs");
  await expect(page.getByTestId("coach-cost")).toBeVisible();
  const summary = (await card.locator(".t-title").first().textContent())!.trim();
  const answer = page.getByTestId("coach-answer");
  if (summary.startsWith("No clear pattern")) await expect(answer).toContainText("Which days do you usually train?");
  else await expect(answer).toContainText(`You usually train ${summary}.`);
});

test.describe("moving to another chat while an answer finishes", () => {
  // The reload after the answer is held with page.route, so the service worker is blocked here (it would answer first).
  test.use({ serviceWorkers: "block" });

  test("New chat stays empty when the first chat's reload comes back late; each chat keeps its own answer", async ({ page }) => {
    await openCoach(page);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let held = 0;
    const threadGet = /\/api\/coach\/threads\/[0-9A-Z]{26}$/;
    await page.route(threadGet, async (route) => {
      if (route.request().method() === "GET" && held++ === 0) await gate;
      await route.continue();
    });
    await ask(page, "How was my week?");
    await expect(page.getByTestId("coach-answer")).toContainText("So far this week chest is");
    await expect.poll(() => held).toBe(1);

    await page.getByTestId("coach-new").click();
    await expect(page.getByTestId("coach-empty")).toBeVisible();
    const late = page.waitForResponse((r) => threadGet.test(r.url()) && r.request().method() === "GET");
    release();
    await late;
    await page.evaluate(() => new Promise((r) => setTimeout(r, 500)));
    await expect(page.getByTestId("coach-answer")).toHaveCount(0);
    await expect(page.getByTestId("coach-question")).toHaveCount(0);
    await expect(page.getByTestId("coach-empty")).toBeVisible();

    await pickPhoto(page, await exifJpeg(page));
    await ask(page, "Look at this");
    await expect(page.getByTestId("coach-answer")).toHaveCount(1);
    await expect(page.getByTestId("coach-answer")).toContainText("visual estimate");
    await expect(page.getByTestId("coach-question")).toHaveCount(1);

    await page.getByTestId("coach-chats").click();
    await page.getByTestId("coach-thread").filter({ hasText: "How was my week?" }).getByTestId("coach-thread-open").click();
    await expect(page.getByTestId("coach-answer")).toHaveCount(1);
    await expect(page.getByTestId("coach-answer")).toContainText("So far this week chest is");
  });
});

test("Me → AI reports shows this month's coach messages and cost", async ({ page }) => {
  await openCoach(page);
  await ask(page, "How was my week?");
  await expect(page.getByTestId("coach-cost")).toBeVisible();
  // Coach is full screen; Back returns to the tabs.
  await page.getByTestId("coach-back").click();
  await goTo(page, "AI reports");
  await expect(page.getByTestId("ai-coach-cost")).toHaveText(/^1 message, ~\$\d+\.\d\d$/);
});
