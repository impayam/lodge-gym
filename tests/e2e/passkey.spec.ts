import { generateKeyPairSync, randomBytes } from "node:crypto";
import { expect, test } from "./fixtures";
import { resetWorkouts, sql, goTo, type Place } from "./helpers";

// Passkey ceremonies need a virtual authenticator (CDP), so this runs on Chromium only.
test.describe.configure({ mode: "serial" });

test("first-run setup, recovery codes, /setup closes, logout and Face ID login", async ({ page, context, browserName, baseURL }) => {
  test.skip(browserName !== "chromium", "virtual WebAuthn authenticator is Chromium-only");
  sql("DELETE FROM credentials");
  sql("DELETE FROM recovery_codes");
  sql("DELETE FROM rate_limits");
  resetWorkouts();

  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });

  await page.goto("/setup");
  await expect(page.getByRole("heading", { name: "Set up GYM time" })).toBeVisible();
  await page.getByPlaceholder("Setup code").fill("wrong-token");
  await page.getByRole("button", { name: "Register Face ID" }).click();
  await expect(page.getByRole("alert")).toContainText("The setup code is wrong");

  await page.getByPlaceholder("Setup code").fill("e2e-setup-token-0123456789");
  await page.getByRole("button", { name: "Register Face ID" }).click();
  const codes = page.getByTestId("recovery-codes").locator("span");
  await expect(codes).toHaveCount(10);
  await page.getByRole("button", { name: "I saved the codes, continue" }).click();
  await expect(page.getByTestId("next-card")).toHaveAttribute("data-day", "Day 1 · Chest");

  const setup = await page.request.get(`${baseURL}/setup`);
  expect(setup.status()).toBe(404);

  await goTo(page, "Settings");
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByTestId("login")).toBeVisible();
  await page.getByTestId("login").click();
  await expect(page.getByTestId("next-card")).toBeVisible();
  expect((await page.request.get(`${baseURL}/api/bootstrap`)).status()).toBe(200);
});

test("a passkey saved before the rename to GYM time still signs in", async ({ page, context, browserName, baseURL }) => {
  test.skip(browserName !== "chromium", "virtual WebAuthn authenticator is Chromium-only");
  sql("DELETE FROM credentials");
  sql("DELETE FROM rate_limits");
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  // A passkey made by the earlier build, not by this one: its key pair on the "phone", and its public key in D1 the
  // way that registration stored it (COSE, ES256). Only the RP ID (the domain) and the user handle tie it to the app.
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const x = Buffer.from(jwk.x!, "base64url");
  const y = Buffer.from(jwk.y!, "base64url");
  const cose = Buffer.concat([Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]), x, Buffer.from([0x22, 0x58, 0x20]), y]);
  const id = randomBytes(16);
  await cdp.send("WebAuthn.addCredential", {
    authenticatorId,
    credential: {
      credentialId: id.toString("base64"),
      isResidentCredential: true,
      rpId: new URL(baseURL!).hostname,
      privateKey: (privateKey.export({ format: "der", type: "pkcs8" }) as Buffer).toString("base64"),
      userHandle: Buffer.from("lodge-gym-owner").toString("base64"),
      signCount: 0,
    },
  });
  sql(`INSERT INTO credentials (id, public_key, counter, transports, created_at, label) VALUES ('${id.toString("base64url")}', X'${cose.toString("hex")}', 0, '["internal"]', '2026-09-27T12:00:00.000Z', 'iPhone')`);

  await page.goto("/");
  await page.getByTestId("login").click();
  await expect(page.getByTestId("next-card")).toBeVisible();
  expect((await page.request.get(`${baseURL}/api/bootstrap`)).status()).toBe(200);
  const used = sql("SELECT last_used_at FROM credentials") as { last_used_at: string | null }[];
  expect(used).toEqual([{ last_used_at: expect.any(String) }]);
});
