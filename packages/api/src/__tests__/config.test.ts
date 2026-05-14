import { describe, it, expect } from "vitest";
import { loadConfig } from "../config.js";

const base = {
  IDP_JWKS_URI: "https://idp.test/jwks",
  IDP_ISSUER: "https://idp.test",
  IDP_AUDIENCE: "platform-api",
  IDP_TOKEN_ENDPOINT: "https://idp.test/token",
  IDP_CLIENT_ID: "x",
  INTERNAL_AUTH_SECRET: "12345678",
  WEBHOOK_AUTH_SECRET: "12345678",
};

describe("loadConfig", () => {
  it("applies defaults for optional fields", () => {
    const c = loadConfig(base);
    expect(c.HTTP_PORT).toBe(3000);
    expect(c.CLAIM_ORG_ID).toBe("org_id");
    expect(c.AUTO_MIGRATE).toBe(true);
  });

  it("throws on missing required envs with readable message", () => {
    expect(() => loadConfig({})).toThrowError(/Invalid config/);
  });

  it("coerces AUTO_MIGRATE strings", () => {
    expect(loadConfig({ ...base, AUTO_MIGRATE: "false" }).AUTO_MIGRATE).toBe(
      false
    );
    expect(loadConfig({ ...base, AUTO_MIGRATE: "true" }).AUTO_MIGRATE).toBe(
      true
    );
  });
});
