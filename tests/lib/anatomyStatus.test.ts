import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { CANONICAL_MUSCLES, groupOf } from "../../worker/lib/muscles";
import { BODY_TINT, bodyDay, profileTints } from "../../web/src/lib/anatomy-status";

// SPEC-v12 M15 §3.1: Profile → My body colours each mapped muscle by its report group: done today pink, this week
// violet, the rest dark.
describe("Profile body colours", () => {
  const tokens = env.TEST_UI_FILES["web/src/styles/tokens.css"];
  const value = (name: string) => tokens.match(new RegExp(`${name}:\\s*(#[0-9a-f]{6})`, "i"))![1].toLowerCase();

  it("are existing tokens: the Pulse pink and violet and the model's muted muscle", () => {
    expect(BODY_TINT).toEqual({ today: "--pink", week: "--violet", rest: "--model-none" });
    expect(new Set(Object.values(BODY_TINT).map(value)).size).toBe(3);
  });

  it("follow the report group of every muscle; today wins over this week", () => {
    const today = new Set(["chest", "triceps"]);
    const week = new Set(["chest", "triceps", "back", "quads"]);
    const tints = profileTints(today, week);
    expect([...tints.keys()]).toEqual([...CANONICAL_MUSCLES]);
    for (const m of CANONICAL_MUSCLES) {
      const g = groupOf(m) ?? m;
      expect(tints.get(m), m).toBe(today.has(g) ? "--pink" : week.has(g) ? "--violet" : "--model-none");
    }
    // Both the lat and the upper-back meshes show the back group.
    expect(bodyDay("back_lats", today, week)).toBe("week");
    expect(bodyDay("back_upper", today, week)).toBe("week");
    expect(bodyDay("chest", today, week)).toBe("today");
    expect(bodyDay("calves", today, week)).toBe("rest");
  });

  it("an empty week is dark everywhere", () => {
    expect([...profileTints(new Set(), new Set()).values()].every((t) => t === "--model-none")).toBe(true);
  });
});
