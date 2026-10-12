import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import program from "../../seed/program.json";
import equipmentReview from "../../seed/library/fedb-equipment.json";
import manual from "../../seed/library/manual.json";
import patterns from "../../seed/library/fedb-patterns.json";
import seedMatches from "../../seed/library/seed-matches.json";
import sample from "../fixtures/library/fedb-sample.json";
import { buildLibrary, librarySql, type EquipmentReview, type FedbExercise, type ManualExercise, type PatternFile, type SeedMatch } from "../../worker/lib/library";
import type { Bootstrap, Exercise, WorkoutSession } from "../../worker/lib/types";
import { ulid } from "../../worker/lib/ulid";
import { Client, resetAuth, setupOwner } from "./helpers";

const seedPrimary = Object.fromEntries(program.exercises.map((e) => [e.id, e.muscle_primary]));
const lib = buildLibrary(sample as FedbExercise[], patterns as PatternFile, seedMatches as SeedMatch[], manual as ManualExercise[], seedPrimary, equipmentReview as EquipmentReview);
const runImport = async () => {
  const res = await env.DB.batch(librarySql(lib.rows, lib.seedUpdates).map((s) => env.DB.prepare(s)));
  return res.reduce((n, r) => n + r.meta.changes, 0);
};
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);

let client: Client;
beforeAll(async () => {
  await resetAuth();
  ({ client } = await setupOwner());
});

describe("library import into D1 (SPEC-v2 §7 acceptance)", () => {
  it("is idempotent: a second run changes nothing", async () => {
    expect(await runImport()).toBe(lib.rows.length + lib.seedUpdates.length);
    expect(await runImport()).toBe(0);
    const counts = await env.DB.prepare("SELECT source, COUNT(*) AS n FROM exercises GROUP BY source ORDER BY source").all();
    expect(counts.results).toEqual([
      { source: "fedb", n: lib.rows.filter((r) => r.source === "fedb").length },
      { source: "manual", n: (manual as ManualExercise[]).length },
      { source: "seed", n: 27 },
    ]);
  });
  it("every imported exercise has a primary muscle key; seeds keep their ids and gain library data", async () => {
    const missing = await env.DB.prepare("SELECT COUNT(*) AS n FROM exercises WHERE muscle_primary IS NULL OR muscle_primary = ''").first<{ n: number }>();
    expect(missing?.n).toBe(0);
    const bench = await env.DB.prepare("SELECT id, source, muscles_secondary, pattern, level, json_array_length(media) AS media FROM exercises WHERE id = 'bench'").first();
    expect(bench).toEqual({ id: "bench", source: "seed", muscles_secondary: '["shoulders_front","triceps"]', pattern: "h_push", level: "beginner", media: 2 });
  });
  it("stores a category on every row: the dataset's, the reviewed override, strength for seed and manual (SPEC-v2 §7.4)", async () => {
    const none = await env.DB.prepare("SELECT COUNT(*) AS n FROM exercises WHERE category IS NULL").first<{ n: number }>();
    expect(none?.n).toBe(0);
    const rows = await env.DB.prepare(
      "SELECT id, category FROM exercises WHERE id IN ('bench', 'fedb-Hamstring_Stretch', 'fedb-Farmers_Walk', 'manual-pendlay-row') ORDER BY id"
    ).all();
    expect(rows.results).toEqual([
      { id: "bench", category: "strength" },
      { id: "fedb-Farmers_Walk", category: "strength" },
      { id: "fedb-Hamstring_Stretch", category: "stretching" },
      { id: "manual-pendlay-row", category: "strength" },
    ]);
    const seeds = await env.DB.prepare("SELECT DISTINCT category FROM exercises WHERE source = 'seed'").all();
    expect(seeds.results).toEqual([{ category: "strength" }]);
  });
});

describe("exercise API", () => {
  it("lists the library; bootstrap only carries the exercises the app needs offline", async () => {
    const all = (await (await client.fetch("/api/exercises")).json()) as { exercises: Exercise[] };
    expect(all.exercises.length).toBe(27 + lib.rows.length);
    const trap = all.exercises.find((e) => e.id === "fedb-Trap_Bar_Deadlift")!;
    expect(trap).toMatchObject({ source: "fedb", equipment: "barbell", pattern: "hinge", muscle_primary: "quads", archived_at: null });
    expect(trap.instructions_en.length).toBeGreaterThan(0);
    const b = (await (await client.fetch("/api/bootstrap")).json()) as Bootstrap;
    expect(b.exercises.map((e) => e.source).every((s) => s === "seed" || s === "custom")).toBe(true);
  });

  it("creates, edits and archives a custom exercise; never touches library rows", async () => {
    const id = ulid();
    const body = { name_en: "Landmine Row", muscle_primary: "back_upper", muscles_secondary: ["biceps", "back_upper"], equipment: "barbell", pattern: "h_pull", archived: false };
    const r = (await (await client.fetch(`/api/exercises/${id}`, { method: "PUT", json: body })).json()) as { exercise: Exercise };
    expect(r.exercise).toMatchObject({ id, source: "custom", muscles_secondary: ["biceps"], is_lower: false, archived_at: null, media: [] });
    const archived = (await (await client.fetch(`/api/exercises/${id}`, { method: "PUT", json: { ...body, archived: true } })).json()) as { exercise: Exercise };
    expect(archived.exercise.archived_at).toBeTruthy();
    expect((await client.fetch(`/api/exercises/bench`, { method: "PUT", json: body })).status).toBe(403);
    expect((await client.fetch(`/api/exercises/${ulid()}`, { method: "PUT", json: { ...body, muscle_primary: "hip_flexors" } })).status).toBe(400);
    const b = (await (await client.fetch("/api/bootstrap")).json()) as Bootstrap;
    expect(b.exercises.find((e) => e.id === id)?.archived_at).toBeTruthy();
  });

  it("custom category: strength by default, set from the form, kept when an edit omits it, validated", async () => {
    const id = ulid();
    const body = { name_en: "Couch Stretch", muscle_primary: "quads", muscles_secondary: [], equipment: "bodyweight", pattern: null, archived: false };
    const put = async (json: object) => (await (await client.fetch(`/api/exercises/${id}`, { method: "PUT", json })).json()) as { exercise: Exercise };
    expect((await put(body)).exercise.category).toBe("strength");
    expect((await put({ ...body, category: "stretching" })).exercise.category).toBe("stretching");
    expect((await put({ ...body, archived: true })).exercise.category).toBe("stretching");
    expect((await client.fetch(`/api/exercises/${id}`, { method: "PUT", json: { ...body, category: "yoga" } })).status).toBe(400);
    const all = (await (await client.fetch("/api/exercises")).json()) as { exercises: Exercise[] };
    expect(all.exercises.find((e) => e.id === id)?.category).toBe("stretching");
  });

  it("stores a custom exercise photo in R2 and serves library media only from the library prefixes", async () => {
    const id = ulid();
    await client.fetch(`/api/exercises/${id}`, { method: "PUT", json: { name_en: "Band-free Curl", muscle_primary: "biceps", muscles_secondary: [], equipment: "dumbbell", pattern: null, archived: false } });
    const up = await client.fetch(`/api/exercises/${id}/photo`, { method: "PUT", body: JPEG, headers: { "Content-Type": "image/jpeg" } });
    const { media } = (await up.json()) as { media: { r2_key: string }[] };
    expect(media[0].r2_key).toMatch(new RegExp(`^library/custom/${id}/[0-9A-Z]{26}\\.jpg$`));
    const img = await client.fetch(`/api/library/media/${media[0].r2_key}`);
    expect(img.status).toBe(200);
    expect(img.headers.get("Cache-Control")).toBe("private, max-age=31536000, immutable");
    expect((await client.fetch(`/api/exercises/bench/photo`, { method: "PUT", body: JPEG, headers: { "Content-Type": "image/jpeg" } })).status).toBe(403);
    await env.PHOTOS.put("photos/secret/full.jpg", JPEG);
    expect((await client.fetch("/api/library/media/photos/secret/full.jpg")).status).toBe(404);
    expect((await client.fetch("/api/library/media/library/custom/../../photos/secret/full.jpg")).status).toBe(404);
    expect((await new Client("192.0.2.77").fetch(`/api/library/media/${media[0].r2_key}`)).status).toBe(401);
  });
});

describe("extra exercises in a session (SPEC-v2 §7.3)", () => {
  it("stores is_extra and position, and reads them back", async () => {
    const now = new Date().toISOString();
    const id = ulid();
    const set = (i: number, ex: string, extra: boolean) => ({ id: ulid(), exercise_id: ex, set_index: i, weight: null, reps: null, seconds: null, done: false, rir: null, ...(extra ? { is_extra: true, position: 0 } : {}), updated_at: now });
    const doc: WorkoutSession = {
      id, program_day_id: "D1", local_date: "2026-10-12", started_at: now, ended_at: null, status: "active", unit: "lb", note: "", created_at: now, updated_at: now, source: "app",
      sets: [set(0, "bench", false), set(0, "fedb-Trap_Bar_Deadlift", true), set(1, "fedb-Trap_Bar_Deadlift", true)],
    };
    for (let i = 0; i < 2; i++) expect((await client.fetch(`/api/sessions/${id}`, { method: "PUT", json: doc })).status).toBe(200);
    const rows = await env.DB.prepare("SELECT exercise_id, is_extra, position FROM set_entries WHERE session_id = ? ORDER BY exercise_id, set_index").bind(id).all();
    expect(rows.results).toEqual([
      { exercise_id: "bench", is_extra: 0, position: null },
      { exercise_id: "fedb-Trap_Bar_Deadlift", is_extra: 1, position: 0 },
      { exercise_id: "fedb-Trap_Bar_Deadlift", is_extra: 1, position: 0 },
    ]);
    const s = ((await (await client.fetch("/api/sessions?from=2026-10-12&to=2026-10-12")).json()) as { sessions: WorkoutSession[] }).sessions.find((x) => x.id === id)!;
    expect(s.sets.filter((x) => x.is_extra)).toHaveLength(2);
    const b = (await (await client.fetch("/api/bootstrap")).json()) as Bootstrap;
    expect(b.exercises.some((e) => e.id === "fedb-Trap_Bar_Deadlift")).toBe(true);
  });
});
