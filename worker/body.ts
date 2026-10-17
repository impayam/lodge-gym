// Goals and body measurements (SPEC-v12 M15 §2, §4; decisions by Payam 2026-10-17). Goals are settings keys
// (goal_training, goal_body, goal_set_at; no migration), written by PUT /api/settings; sizes are rows of
// body_measurements (migration 0014), upserted by client id from the outbox and deleted softly.

import { Hono } from "hono";
import { z } from "zod";
import type { AppBindings, Env } from "./env";
import { fail, nowISO, readJson } from "./http";
import { goalsFromSettings, type Goals } from "./lib/goals";
import type { BodyMeasurement } from "./lib/measurements";
import { DATE_RE } from "./lib/time";
import { ID_RE } from "./lib/ulid";

const iso = z.string().max(40).refine((s) => !Number.isNaN(Date.parse(s)) && /T/.test(s), "iso");

export async function readGoals(env: Env): Promise<Goals | null> {
  const rows = await env.DB.prepare("SELECT key, value FROM settings WHERE key IN ('goal_training', 'goal_body', 'goal_set_at')").all<{ key: string; value: string }>();
  return goalsFromSettings(Object.fromEntries(rows.results.map((r) => [r.key, r.value])));
}

/** Every body measurement that is not deleted, oldest first. */
export async function readMeasurements(env: Env): Promise<BodyMeasurement[]> {
  const rows = await env.DB.prepare("SELECT * FROM body_measurements WHERE deleted_at IS NULL ORDER BY local_date, created_at").all<BodyMeasurement>();
  return rows.results.map((r) => ({ ...r, note: r.note ?? "" }));
}

const cm = z.number().min(10).max(300).nullable();
const measurementSchema = z
  .object({
    id: z.string().regex(ID_RE),
    local_date: z.string().regex(DATE_RE),
    arm_cm: cm,
    chest_cm: cm,
    waist_cm: cm,
    hips_cm: cm,
    thigh_cm: cm,
    calf_cm: cm,
    neck_cm: cm,
    shoulders_cm: cm,
    note: z.string().max(500),
    created_at: iso,
    updated_at: iso,
  })
  .strict();

const FIELDS = ["arm_cm", "chest_cm", "waist_cm", "hips_cm", "thigh_cm", "calf_cm", "neck_cm", "shoulders_cm"] as const;

export const bodyRoutes = new Hono<AppBindings>();

bodyRoutes.get("/body/measurements", async (c) => c.json({ measurements: await readMeasurements(c.env) }));

/** Upserts one entry by its client id; an older copy (by updated_at) never replaces a newer one, and a deleted entry
 *  stays deleted. */
bodyRoutes.put("/body/measurements/:id", async (c) => {
  const m = await readJson(c, measurementSchema);
  if (m.id !== c.req.param("id")) return fail(c, 400, "invalid_input", "The id does not match.");
  if (FIELDS.every((f) => m[f] === null)) return fail(c, 400, "invalid_input", "Enter at least one size.");
  await c.env.DB.prepare(
    `INSERT INTO body_measurements (id, local_date, ${FIELDS.join(", ")}, note, created_at, updated_at)
     VALUES (?, ?, ${FIELDS.map(() => "?").join(", ")}, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET local_date = excluded.local_date, ${FIELDS.map((f) => `${f} = excluded.${f}`).join(", ")},
       note = excluded.note, updated_at = excluded.updated_at
     WHERE excluded.updated_at >= body_measurements.updated_at AND body_measurements.deleted_at IS NULL`
  )
    .bind(m.id, m.local_date, ...FIELDS.map((f) => m[f]), m.note, m.created_at, m.updated_at)
    .run();
  return c.json({ ok: true });
});

/** Deletes an entry softly; deleting one that is not there (or not synced yet) is fine. */
bodyRoutes.delete("/body/measurements/:id", async (c) => {
  const id = c.req.param("id");
  if (!ID_RE.test(id)) return fail(c, 400, "invalid_input", "Invalid id.");
  const now = nowISO();
  await c.env.DB.prepare("UPDATE body_measurements SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL").bind(now, now, id).run();
  return c.json({ ok: true });
});
