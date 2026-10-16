import { describe, expect, it } from "vitest";
import { reportData } from "../fixtures/report-data";
import { balanceStatus, bestSet, muscleTargets, setsPerMuscle, weeklyReport } from "../../worker/lib/reports";
import { buildOverviewInput } from "../../worker/lib/ai/overview";
import { lastHeavyCompound } from "../../worker/lib/ai/advice";
import { callCostUsd } from "../../worker/lib/ai/cost";
import { COACH_TOOLS, getAdherence, getE1rmHistory, getPrs, getRecovery, getTrainingPattern, getVolume, runTool, type CoachData } from "../../worker/lib/coach/tools";
import type { WorkoutSession } from "../../worker/lib/types";
import { draftDayRows, proposeProgram } from "../../worker/lib/coach/draft";
import { contextWindow, estimateTokens, nextStamp, validHistory, type StoredMessage } from "../../worker/lib/coach/context";
import { COACH_SYSTEM, CONTEXT_HEADER, contextBlock } from "../../worker/lib/coach/prompt";
import { statusClaims, statusMismatches, type VolumeResult } from "../../worker/lib/coach/statusCheck";

const data = (today = "2026-09-27", now = "2026-09-28T03:00:00.000Z"): CoachData => ({ ...reportData(), today, now });

describe("coach tools use the Reports numbers", () => {
  it("get_volume: the fixture week's rows equal the Reports screen's rows, with the same status function", () => {
    const d = data();
    const reports = weeklyReport(d, "2026-09-23").muscles;
    const [week] = getVolume(d, "2026-09-21", "2026-09-27").weeks;
    expect(week).toMatchObject({ start: "2026-09-21", end: "2026-09-27", partial: true });
    expect(week.groups.map((g) => ({ muscle: g.group, sets: g.direct_sets, fractional: g.fractional_sets, target: g.target, status: g.status }))).toEqual(reports);
    for (const g of week.groups.filter((x) => x.target != null)) expect(g.status).toBe(balanceStatus(g.fractional_sets, g.target!));
  });

  it("status bands are the Reports ones: under below 80 %, on from 80 % to 120 %, over above 120 %, none at 0 sets", () => {
    expect(balanceStatus(0, 10)).toBe("none");
    expect(balanceStatus(7.9, 10)).toBe("under");
    expect(balanceStatus(8, 10)).toBe("on");
    expect(balanceStatus(12, 10)).toBe("on");
    expect(balanceStatus(12.1, 10)).toBe("over");
  });

  it("get_volume: a past week is not partial and counts only its own sessions", () => {
    const d = data();
    const [week] = getVolume(d, "2026-09-14", "2026-09-20").weeks;
    expect(week.partial).toBe(false);
    const ex = new Map(d.exercises.map((e) => [e.id, e]));
    const sets = setsPerMuscle(d.sessions.filter((s) => s.status === "done" && s.local_date >= "2026-09-14" && s.local_date <= "2026-09-20"), ex);
    const chest = week.groups.find((g) => g.group === "chest")!;
    expect(chest.fractional_sets).toBe(sets.chest.fractional);
    expect(chest.target).toBe(muscleTargets(d).chest);
  });

  it("get_e1rm_history: the best set of each session day (Epley), first to latest change", () => {
    const d = data();
    const r = getE1rmHistory(d, "bench", 12);
    expect(r.ok).toBe(true);
    const res = (r as { result: { points: { date: string; e1rm: number }[]; change_pct: number; first_e1rm: number; latest_e1rm: number } }).result;
    const p1 = bestSet(d.sessions.find((s) => s.id === "P1")!, "bench", "lb")!;
    const s1 = bestSet(d.sessions.find((s) => s.id === "S1")!, "bench", "lb")!;
    expect(res.points).toEqual([
      { date: "2026-09-15", ...p1 },
      { date: "2026-09-21", ...s1 },
    ]);
    expect(res.first_e1rm).toBe(p1.e1rm);
    expect(res.latest_e1rm).toBe(s1.e1rm);
    expect(res.change_pct).toBe(Math.round(((s1.e1rm - p1.e1rm) / p1.e1rm) * 1000) / 10);
    expect(getE1rmHistory(d, "nope", 12)).toMatchObject({ ok: false });
  });

  it("get_adherence: the training overview's planned and done counts for the same weeks", () => {
    const d = data("2026-09-27");
    const overview = buildOverviewInput(d, [], "2026-09-27", null);
    const a = getAdherence(d, overview.window.start, "2026-09-27");
    expect({ since: a.since, done: a.sessions_done, planned: a.sessions_planned }).toEqual({ since: overview.totals.since, done: overview.totals.sessions_done, planned: overview.totals.sessions_planned });
    expect(a.weeks.map((w) => [w.start, w.done, w.planned])).toEqual(overview.weeks.map((w) => [w.start, w.sessions_done, w.sessions_planned]));
  });

  it("get_prs: a record must beat every earlier session's best; the first session of a lift is not one", () => {
    const r = getPrs(data(), "bench");
    expect(r).toMatchObject({ ok: true });
    const res = (r as { result: { records: { date: string; previous_e1rm: number }[]; best: { date: string }[] } }).result;
    expect(res.records.map((x) => x.date)).toEqual(["2026-09-21"]);
    expect(res.best[0].date).toBe("2026-09-21");
  });

  it("get_recovery: the planner advice's list, from the same function", () => {
    const d = data();
    const ex = new Map(d.exercises.map((e) => [e.id, e]));
    const r = getRecovery(d);
    expect(r.groups).toEqual(lastHeavyCompound(d.sessions.filter((s) => s.status === "done"), ex, d.now));
    expect(r.groups.length).toBeGreaterThan(0);
    // The active session (A1) never counts.
    expect(r.groups.every((g) => g.date !== "2026-09-27")).toBe(true);
  });
});

describe("coach tool inputs", () => {
  it("bad inputs come back as errors the model can correct", () => {
    const d = data();
    expect(runTool(d, "get_sessions", { from: "2026-09-27", to: "2026-09-01" })).toMatchObject({ ok: false });
    expect(runTool(d, "get_sessions", { from: "2026-01-01", to: "2026-09-01" })).toMatchObject({ ok: false, error: expect.stringContaining("92 days") });
    expect(runTool(d, "get_library", {})).toMatchObject({ ok: false, error: expect.stringContaining("at least one filter") });
    expect(runTool(d, "get_volume", { from: "2026-09-21", to: "2026-09-27", extra: 1 })).toMatchObject({ ok: false });
    expect(runTool(d, "nope", {})).toMatchObject({ ok: false });
  });

  it("get_sessions includes the open session and converts kg sets to his unit", () => {
    const r = runTool(data(), "get_sessions", { from: "2026-09-21", to: "2026-09-27" });
    const sessions = (r as { result: { sessions: { id: string; status: string; exercises: { exercise_id: string; sets: { weight: number | null }[] }[] }[] } }).result.sessions;
    expect(sessions.map((s) => s.id)).toEqual(["A1", "S3", "S2", "S1"]);
    expect(sessions[0].status).toBe("active");
    expect(sessions[1].exercises.find((x) => x.exercise_id === "cs_row")!.sets[0].weight).toBe(55.1);
  });

  it("every tool has a strict object schema; there are 13 read tools, propose_schedule, propose_exercise, propose_session_additions and propose_program", () => {
    expect(COACH_TOOLS.map((t) => t.name)).toEqual([
      "get_sessions",
      "get_e1rm_history",
      "get_volume",
      "get_adherence",
      "get_prs",
      "get_program",
      "get_library",
      "get_body_weight",
      "get_photos",
      "get_recovery",
      "get_training_pattern",
      "get_calendar",
      "find_free_slots",
      "propose_schedule",
      "propose_exercise",
      "propose_session_additions",
      "propose_program",
    ]);
    for (const t of COACH_TOOLS) expect(t.input_schema).toMatchObject({ type: "object", additionalProperties: false });
  });
});

describe("propose_program", () => {
  const day = (exercises: object[], name = "Day 1 · Chest") => ({ name, exercises });
  const ex = (id: string, more: object = {}) => ({ exercise_id: id, sets: 3, reps_min: 8, reps_max: 10, rest_sec: 90, ...more });

  it("drops ids that are not in the library, says which, and a group left with one exercise is no longer a group", () => {
    const d = data();
    const r = proposeProgram(d, { name: "Chest", days: [day([ex("bench", { is_main: true }), ex("hack_squat_machine", { group: "A" }), ex("fly", { group: "A" })])] }, "01DRAFT00000000000000000000");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.dropped).toEqual([{ day: "Day 1 · Chest", exercise_id: "hack_squat_machine", reason: "not in the library" }]);
    expect(r.draft.days[0].exercises.map((x) => [x.exercise_id, x.group ?? null])).toEqual([["bench", null], ["fly", null]]);
    // The English names of the kept exercises, for the card (the phone may not have the library).
    expect(r.result.names).toEqual({ bench: d.exercises.find((e) => e.id === "bench")!.name_en, fly: d.exercises.find((e) => e.id === "fly")!.name_en });
    expect(r.result.weekly_sets.find((g) => g.group === "chest")!.planned).toBe(6);
  });

  it("archived exercises are dropped too; a draft with nothing left is an error", () => {
    const d = data();
    d.exercises = d.exercises.map((e) => (e.id === "fly" ? { ...e, archived_at: "2026-09-01T00:00:00.000Z" } : e));
    const r = proposeProgram(d, { name: "X", days: [day([ex("fly")])] }, "x");
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("fly") });
  });

  it("checks reps, target RIR, one main lift per day and groups of 2-3 consecutive exercises", () => {
    const d = data();
    const bad = (exercises: object[]) => proposeProgram(d, { name: "X", days: [day(exercises)] }, "x");
    expect(bad([ex("bench", { reps_min: 12, reps_max: 8 })])).toMatchObject({ ok: false, error: expect.stringContaining("reps_min") });
    expect(bad([ex("bench", { target_rir_min: 3, target_rir_max: 1 })])).toMatchObject({ ok: false });
    expect(bad([ex("bench", { target_rir_min: 1 })])).toMatchObject({ ok: false });
    expect(bad([ex("bench", { is_main: true }), ex("fly", { is_main: true })])).toMatchObject({ ok: false, error: expect.stringContaining("is_main") });
    expect(bad([ex("bench", { group: "A" }), ex("fly"), ex("lateral", { group: "A" })])).toMatchObject({ ok: false, error: expect.stringContaining("group A") });
    expect(bad([ex("bench", { group: "A" }), ex("fly", { group: "A" }), ex("lateral", { group: "A" }), ex("incline_db", { group: "A" })])).toMatchObject({ ok: false });
    expect(bad([ex("bench", { group: "A" }), ex("fly", { group: "A" }), ex("lateral", { group: "A" })])).toMatchObject({ ok: true });
  });

  it("saved day rows number each group's exercises A1, A2, A3 and count minutes like the generator", () => {
    const d = data();
    const r = proposeProgram(d, { name: "X", days: [day([ex("bench", { is_main: true, rest_sec: 180, sets: 4 }), ex("fly", { group: "B" }), ex("lateral", { group: "B" }), ex("facepull", { group: "B" })])] }, "x");
    if (!r.ok) throw new Error(r.error);
    const [row] = draftDayRows(r.draft);
    expect(row.exercises.map((x) => x.superset_tag)).toEqual([null, "B1", "B2", "B3"]);
    expect(row.exercises[0]).toMatchObject({ is_main: true, position: 1, per_leg: false, is_time: false, target_rir_min: null });
    expect(row.est_minutes).toBeGreaterThan(0);
  });

  it("carries the program generator's check as advice; no length warning ever, each day's length is information", () => {
    const d = data();
    const long = day([ex("bench", { is_main: true, sets: 10, rest_sec: 240 }), ex("incline_db", { sets: 10, rest_sec: 240 })]);
    const r = proposeProgram(d, { name: "X", days: [long, { ...long, name: "Day 2 · Chest" }] }, "x");
    if (!r.ok) throw new Error(r.error);
    const rows = draftDayRows(r.draft);
    expect(r.result.day_minutes).toEqual(rows.map((x) => x.est_minutes));
    expect(r.result.day_minutes[0]).toBeGreaterThan(90);
    expect(r.result.warnings.some((w) => / min/.test(w))).toBe(false);
    expect(r.result.warnings).toContain("No squat in the week.");
    expect(r.result.warnings.some((w) => w.startsWith("Back:"))).toBe(true);
  });

  it("spacing rules run on adjacent days (and the last day and Day 1), worded as a condition", () => {
    const d = data();
    const r = proposeProgram(
      d,
      {
        name: "X",
        days: [
          day([ex("bench", { is_main: true }), ex("rdl")], "Day 1 · A"),
          day([ex("incline_bb", { is_main: true }), ex("deadlift")], "Day 2 · B"),
          day([ex("squat", { is_main: true }), ex("curl")], "Day 3 · C"),
          day([ex("pullup", { is_main: true }), ex("fly")], "Day 4 · D"),
        ],
      },
      "x"
    );
    if (!r.ok) throw new Error(r.error);
    const spacing = r.result.warnings.filter((w) => w.startsWith("If you train"));
    expect(spacing).toEqual([
      "If you train Day 1 and Day 2 back to back, that is two heavy hinges within 24 h.",
      "If you train Day 1 and Day 2 back to back, Chest has a main lift on both days.",
      // Romanian deadlift (hamstrings) and deadlift (glutes) are both the Hamstrings & glutes group.
      "If you train Day 1 and Day 2 back to back, Hamstrings & glutes is trained on both days.",
      "If you train Day 4 and Day 1 back to back, Chest is trained on both days.",
    ]);
    // Day 1 and Day 3 are never adjacent in the day order.
    expect(spacing.some((w) => w.includes("Day 1 and Day 3"))).toBe(false);
  });

  it("two days are one pair; one day has none", () => {
    const d = data();
    const two = proposeProgram(d, { name: "X", days: [day([ex("bench", { is_main: true })]), day([ex("incline_bb", { is_main: true })], "Day 2 · B")] }, "x");
    if (!two.ok) throw new Error(two.error);
    expect(two.result.warnings.filter((w) => w.startsWith("If you train"))).toEqual(["If you train Day 1 and Day 2 back to back, Chest has a main lift on both days."]);
    const one = proposeProgram(d, { name: "X", days: [day([ex("bench", { is_main: true })])] }, "x");
    if (!one.ok) throw new Error(one.error);
    expect(one.result.warnings.some((w) => w.startsWith("If you train"))).toBe(false);
  });
});

describe("get_training_pattern", () => {
  // Today is Thursday 2026-10-15 in Denver (UTC−6 in October); the window is 2026-09-18 to 2026-10-15.
  const session = (date: string, start: string, end: string, day: string): WorkoutSession =>
    ({ id: `s-${date}`, program_day_id: day, local_date: date, started_at: start, ended_at: end, status: "done", unit: "lb", note: "", created_at: start, updated_at: start, source: "app", sets: [] }) as unknown as WorkoutSession;
  const withSessions = (list: WorkoutSession[]): CoachData => ({ ...data(), today: "2026-10-15", now: "2026-10-15T20:00:00.000Z", sessions: list });
  const noon = (date: string, day: string) => session(date, `${date}T18:05:00.000Z`, `${date}T18:58:00.000Z`, day);

  it("Mon, Tue, Thu, Sat around noon: a clear pattern with the usual time, two days in a row, and each day's weekday", () => {
    const dates: [string, string][] = [
      ["2026-09-19", "D4"], ["2026-09-21", "D1"], ["2026-09-22", "D2"], ["2026-09-24", "D3"], ["2026-09-26", "D4"],
      ["2026-09-28", "D1"], ["2026-09-29", "D2"], ["2026-10-01", "D3"], ["2026-10-03", "D4"], ["2026-10-05", "D1"],
      ["2026-10-06", "D2"], ["2026-10-08", "D3"], ["2026-10-10", "D4"], ["2026-10-12", "D1"], ["2026-10-13", "D2"], ["2026-10-15", "D3"],
    ];
    const r = getTrainingPattern(withSessions([...dates.map(([x, dd]) => noon(x, dd)), noon("2026-09-10", "D1")]));
    expect(r).toMatchObject({ from: "2026-09-18", to: "2026-10-15", sessions: 16, usual_days: ["Mon", "Tue", "Thu", "Sat"], usual_time: { from: "12:00", to: "13:00" }, max_days_in_a_row: 2, clear: true });
    expect(r.summary).toBe("Mon, Tue, Thu, Sat, usually 12:00–13:00");
    expect(r.program_days.find((p) => p.usual_weekday === "Mon")).toMatchObject({ times: 4 });
  });

  it("too few sessions, or sessions spread over the week: no clear pattern, so the coach asks", () => {
    const few = getTrainingPattern(withSessions([noon("2026-09-21", "D1"), noon("2026-10-01", "D2"), noon("2026-10-10", "D3")]));
    expect(few).toMatchObject({ sessions: 3, clear: false, summary: "No clear pattern in the last 4 weeks (3 sessions)." });
    const spread = getTrainingPattern(withSessions(["2026-09-21", "2026-09-23", "2026-09-26", "2026-09-30", "2026-10-02", "2026-10-04", "2026-10-07", "2026-10-11"].map((x) => noon(x, "D1"))));
    expect(spread.clear).toBe(false);
    expect(getTrainingPattern(withSessions([])).summary).toBe("No clear pattern in the last 4 weeks (0 sessions).");
  });

  it("days without a steady start time: the pattern stands, the time is given as varying", () => {
    const times = ["13:00", "02:00", "21:00", "15:00", "23:30", "16:00", "03:00", "19:00"];
    const dates = ["2026-09-21", "2026-09-22", "2026-09-28", "2026-09-29", "2026-10-05", "2026-10-06", "2026-10-12", "2026-10-13"];
    const r = getTrainingPattern(withSessions(dates.map((x, i) => session(x, `${x}T${times[i]}:00.000Z`, `${x}T${times[i]}:00.000Z`, "D1"))));
    expect(r).toMatchObject({ clear: true, usual_days: ["Mon", "Tue"], usual_time: null, summary: "Mon, Tue, at varying times" });
  });
});

describe("status claims in an answer vs get_volume", () => {
  const vol = (rows: Record<string, [string, number | null]>): VolumeResult => ({ weeks: [{ groups: Object.entries(rows).map(([group, [status, target]]) => ({ group, target, status: status as never })) }] });

  it("Persian: 'chest is under target' while get_volume says on target is a mismatch; the same text with under is not", () => {
    const text = "این هفته تا امروز سینه زیر هدف است؛ دو ست دیگر اضافه کن.";
    expect(statusMismatches(text, [vol({ chest: ["on", 13] })])).toEqual([{ group: "chest", status: "under" }]);
    expect(statusMismatches(text, [vol({ chest: ["under", 13] })])).toEqual([]);
    // 0 sets of a target (none) is under it.
    expect(statusMismatches(text, [vol({ chest: ["none", 13] })])).toEqual([]);
  });

  it("English clauses are read one by one; each group is checked against its own row", () => {
    const text = "So far chest is on target, but back is under target.";
    expect(statusClaims(text)).toEqual([{ group: "chest", status: "on" }, { group: "back", status: "under" }]);
    expect(statusMismatches(text, [vol({ chest: ["on", 13], back: ["under", 17.5] })])).toEqual([]);
    expect(statusMismatches(text, [vol({ chest: ["on", 13], back: ["on", 17.5] })])).toEqual([{ group: "back", status: "under" }]);
  });

  it("is cautious: negations, two statuses in one clause and groups without a target are not checked", () => {
    expect(statusClaims("Chest is not under target.")).toEqual([]);
    expect(statusClaims("Chest isn’t over target.")).toEqual([]);
    expect(statusClaims("سینه زیر هدف نیست.")).toEqual([]);
    expect(statusClaims("Chest is on target and back is under target.")).toEqual([]);
    expect(statusMismatches("Chest is over target.", [vol({ chest: ["untracked", null] })])).toEqual([]);
    expect(statusMismatches("Chest is over target.", [])).toEqual([]);
  });

  it("Persian names: the longer name wins (پشت بازو is triceps, not back), possessives and ZWNJ are read", () => {
    expect(statusClaims("پشت بازو بالای هدف است.")).toEqual([{ group: "triceps", status: "over" }]);
    expect(statusClaims("سینه زیر هدفش است.")).toEqual([{ group: "chest", status: "under" }]);
    const zwnj = String.fromCharCode(0x200c);
    expect(statusClaims(`سرشانه${zwnj}ها روی هدف هستند.`)).toEqual([{ group: "shoulders", status: "on" }]);
  });

  it("a claim that any week in the answer supports is not a mismatch", () => {
    const twoWeeks: VolumeResult = { weeks: [...vol({ chest: ["under", 13] }).weeks, ...vol({ chest: ["on", 13] }).weeks] };
    expect(statusMismatches("Chest is on target.", [twoWeeks])).toEqual([]);
    expect(statusMismatches("Chest is over target.", [twoWeeks])).toEqual([{ group: "chest", status: "over" }]);
  });
});

describe("coach cost", () => {
  it("is computed from the API's token counts with Opus 5.5 prices (input, output, cache write, cache read)", () => {
    expect(callCostUsd("claude-opus-5-5", { input_tokens: 1_000_000, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 })).toBe(4);
    expect(callCostUsd("claude-opus-5-5", { input_tokens: 0, output_tokens: 1_000_000, cache_read_tokens: 0, cache_write_tokens: 0 })).toBe(20);
    expect(callCostUsd("claude-opus-5-5", { input_tokens: 0, output_tokens: 0, cache_read_tokens: 1_000_000, cache_write_tokens: 0 })).toBeCloseTo(0.2, 10);
    expect(callCostUsd("claude-opus-5-5", { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 1_000_000 })).toBe(5);
    expect(callCostUsd("claude-opus-5-5", { input_tokens: 1200, output_tokens: 800, cache_read_tokens: 6000, cache_write_tokens: 500 })).toBeCloseTo((1200 * 4 + 800 * 20 + 6000 * 0.2 + 500 * 5) / 1e6, 12);
    expect(callCostUsd("unknown-model", { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0 })).toBeNull();
  });
});

describe("context budget", () => {
  let n = 0;
  const msg = (role: "user" | "assistant", content: StoredMessage["content"], error: string | null = null): StoredMessage => ({ id: `m${String(n++).padStart(3, "0")}`, role, content, created_at: `2026-10-15T10:${String(n).padStart(2, "0")}:00.000Z`, error });
  const q = (text: string) => msg("user", [{ type: "text", text }]);
  const a = (text: string) => msg("assistant", [{ type: "thinking", thinking: "", signature: "sig" }, { type: "text", text }]);

  it("sends the newest messages that fit, starting at a question; the latest question is always sent", () => {
    const rows = [q("x".repeat(3000)), a("y".repeat(3000)), q("second"), a("ok"), q("third")];
    const all = contextWindow(rows, 100_000);
    expect(all).toMatchObject({ omitted: 0 });
    expect(all.messages).toHaveLength(5);
    const small = contextWindow(rows, 100);
    expect(small.messages.map((m) => m.id)).toEqual(rows.slice(2).map((m) => m.id));
    expect(small.omitted).toBe(2);
    expect(contextWindow(rows, 1).messages.map((m) => m.id)).toEqual([rows[4].id]);
  });

  it("never resends a failed call, and leaves out a tool call whose results were not saved", () => {
    const call = msg("assistant", [{ type: "tool_use", id: "t1", name: "get_program", input: {} }]);
    const rows = [q("first"), msg("assistant", [], "api: overloaded"), call, q("again")];
    expect(validHistory(rows).map((m) => m.id)).toEqual([rows[0].id, rows[3].id]);
    const answered = [q("first"), call, msg("user", [{ type: "tool_result", tool_use_id: "t1", content: "{}" }]), a("done")];
    expect(validHistory(answered)).toHaveLength(4);
  });

  it("saves each row after the one before it, also when the clock has not moved", () => {
    const at = Date.parse("2026-10-15T10:00:00.000Z");
    expect(nextStamp(undefined, at)).toBe("2026-10-15T10:00:00.000Z");
    expect(nextStamp(null, at)).toBe("2026-10-15T10:00:00.000Z");
    expect(nextStamp("2026-10-15T09:59:59.000Z", at)).toBe("2026-10-15T10:00:00.000Z");
    // Same millisecond, or a previous row stamped ahead of the clock: 1 ms after it.
    expect(nextStamp("2026-10-15T10:00:00.000Z", at)).toBe("2026-10-15T10:00:00.001Z");
    expect(nextStamp("2026-10-15T10:00:00.004Z", at)).toBe("2026-10-15T10:00:00.005Z");
    let last: string | undefined;
    const stamps = Array.from({ length: 5 }, () => (last = nextStamp(last, at)));
    expect(stamps).toEqual([...stamps].sort());
    expect(new Set(stamps).size).toBe(5);
  });

  it("estimates images by their size, as the API counts them", () => {
    expect(estimateTokens(msg("user", [{ type: "image", attachment_id: "x", width: 1200, height: 1600 }]))).toBe(4 + 2560);
  });
});

describe("coach prompt", () => {
  it("carries Payam's 2026-10-15 rules", () => {
    expect(COACH_SYSTEM).toContain("under when its sets are below 80 % of the target, on from 80 % to 120 %, over above 120 %");
    expect(COACH_SYSTEM).toContain("every planned set had RIR 3 or more, the step is doubled");
    // The 48-hour rule is advice: the coach explains with options and leaves the choice to him.
    expect(COACH_SYSTEM).toContain("Recovery is advice, not a ban: a muscle group should get 48 hours between heavy compound lifts");
    expect(COACH_SYSTEM).toContain("Chest had heavy bench 24 h ago: today prefer isolation or a lighter incline, or move heavy incline to tomorrow");
    expect(COACH_SYSTEM).toContain("Then leave the choice to him. Never refuse a request and never remove an exercise because of this rule.");
    expect(COACH_SYSTEM).toContain("Keep every exercise he asks for.");
    expect(COACH_SYSTEM).not.toMatch(/no heavy compound/i);
    expect(COACH_SYSTEM).toContain("pulling volume at least equal to pushing volume");
    expect(COACH_SYSTEM).toContain("Me → Program → Drafts");
    expect(COACH_SYSTEM).not.toMatch(/Settings → Program/);
  });

  it("the CONTEXT block names the weekday, zone, unit, week start and active program", () => {
    expect(contextBlock({ today: "2026-10-14", timezone: "America/Denver", unit: "lb", week_start: "mon", program: { name: "Full body · 4 days", since: "2026-09-27" } })).toBe(
      [CONTEXT_HEADER, "Today: Wednesday 2026-10-14. Time zone: America/Denver.", "Weight unit: lb. Weeks start on Monday.", "Active program: Full body · 4 days, active since 2026-09-27."].join("\n")
    );
  });
});
