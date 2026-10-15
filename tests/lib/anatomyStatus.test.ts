import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { CANONICAL_MUSCLES, groupOf } from "../../worker/lib/muscles";
import { progressReport } from "../../worker/lib/reports";
import { STAGE_STATUS_TOKEN, muscleState, stageTints } from "../../web/src/lib/anatomy-status";
import type { BalanceStatus } from "../../worker/lib/reports";
import { reportData } from "../fixtures/report-data";

// SPEC-v6 §8: the 3D muscle map in Reports colours each mapped muscle by its report group's weekly status.
describe("3D muscle map colours", () => {
  // The --model-* tokens hold the pre-Pulse dark theme's status colours unchanged (Payam, 2026-10-14).
  const tokens = env.TEST_UI_FILES["web/src/styles/tokens.css"];
  const value = (name: string) => tokens.match(new RegExp(`${name}:\\s*(#[0-9a-f]{6})`, "i"))![1].toLowerCase();
  const STAGE_STATUS_COLOR = Object.fromEntries(Object.entries(STAGE_STATUS_TOKEN).map(([s, t]) => [s, value(t)])) as Record<BalanceStatus, string>;

  it("are the --model-* status tokens, the pre-Pulse values unchanged", () => {
    expect(STAGE_STATUS_COLOR).toEqual({ under: "#e3a93a", on: "#56c98a", over: "#f08a4b", untracked: "#3fbfa6", none: "#5a4b49" });
    // Five different colours: status is told apart (and the card, legend and list add the icon and label).
    expect(new Set(Object.values(STAGE_STATUS_COLOR)).size).toBe(5);
  });

  it("match the report numbers of a fixture week, muscle by muscle", () => {
    const rows = progressReport(reportData(), "2026-09-27").balance.muscles;
    const tints = stageTints(rows, (st) => STAGE_STATUS_COLOR[st]);
    expect([...tints.keys()]).toEqual([...CANONICAL_MUSCLES]);
    for (const m of CANONICAL_MUSCLES) {
      const row = rows.find((r) => r.muscle === groupOf(m))!;
      expect(tints.get(m), m).toBe(STAGE_STATUS_COLOR[row.status]);
    }
    // The fixture week (see reports.test.ts): chest on, hamstrings & glutes under, forearms trained without a target,
    // traps not trained; both lat and upper-back meshes show the back group.
    expect(tints.get("chest")).toBe(STAGE_STATUS_COLOR.on);
    expect(tints.get("glutes")).toBe(STAGE_STATUS_COLOR.under);
    expect(tints.get("hamstrings")).toBe(STAGE_STATUS_COLOR.under);
    expect(tints.get("forearms")).toBe(STAGE_STATUS_COLOR.untracked);
    expect(tints.get("traps")).toBe(STAGE_STATUS_COLOR.none);
    expect(muscleState(rows, "back_lats")).toMatchObject({ group: "back", status: "on", row: { muscle: "back", target: 17.5 } });
    expect(muscleState(rows, "shoulders_side")).toMatchObject({ group: "shoulders", status: "under" });
  });

  it("an over-target group and an empty week", () => {
    const rows = progressReport(reportData(), "2026-09-27").balance.muscles.map((r) => (r.muscle === "chest" ? { ...r, fractional: 20, status: "over" as const } : r));
    expect(stageTints(rows, (st) => STAGE_STATUS_COLOR[st]).get("chest")).toBe(STAGE_STATUS_COLOR.over);
    expect([...stageTints([], (st) => STAGE_STATUS_COLOR[st]).values()].every((c) => c === STAGE_STATUS_COLOR.none)).toBe(true);
  });
});
