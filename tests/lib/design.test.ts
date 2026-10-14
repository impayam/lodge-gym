import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// SPEC-v8 §2: the UI is built only from the Pulse library (design/pulse). web/src/styles holds its copies.
const files = env.TEST_UI_FILES;
const LIBRARY = ["tokens.css", "components.css"];
// Pre-Pulse styles, scoped under .legacy while screens move over; deleted with the last legacy screen (plan step 11).
const LEGACY = "web/src/styles/legacy.css";

describe("Pulse design rules", () => {
  it("web/src/styles holds exact copies of the design library", () => {
    for (const f of LIBRARY) expect(files[`web/src/styles/${f}`], f).toBe(files[`design/pulse/${f}`]);
  });

  it("no hex colour in web/src outside tokens.css and components.css (SPEC-v8 §2.1)", () => {
    const allowed = new Set([...LIBRARY.map((f) => `web/src/styles/${f}`), LEGACY]);
    const offenders = Object.entries(files)
      .filter(([p]) => p.startsWith("web/src/") && !allowed.has(p))
      .flatMap(([p, text]) => (text.match(/#[0-9a-fA-F]{3,8}/g) ?? []).map((m) => `${p}: ${m}`));
    expect(offenders).toEqual([]);
  });

  it("layout.css holds layout properties only", () => {
    const css = files["web/src/styles/layout.css"].replace(/\/\*[\s\S]*?\*\//g, "");
    const LAYOUT = /^(display|flex(-direction|-wrap)?|align-items|justify-content|gap|grid-template-columns|text-align|width|height|min-width|margin|padding|position|overflow|clip|white-space|border)$/;
    const props = [...css.matchAll(/([a-z-]+)\s*:/g)].map((m) => m[1]);
    expect(props.length).toBeGreaterThan(10);
    expect(props.filter((p) => !LAYOUT.test(p))).toEqual([]);
    expect(css).not.toMatch(/var\(--|#[0-9a-f]/i);
  });

  it("base.css holds resets only: no shadows, radii or font names", () => {
    const base = files["web/src/styles/base.css"].replace(/\/\*[\s\S]*?\*\//g, "");
    expect(base).not.toMatch(/box-shadow|border-radius/);
    for (const m of base.matchAll(/font-family:\s*([^;]+);/g)) expect(m[1].trim()).toMatch(/^var\(--font-[a-z]+\)$/);
  });
});
