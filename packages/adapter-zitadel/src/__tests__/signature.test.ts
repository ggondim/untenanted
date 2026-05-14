import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { verifyZitadelSignature } from "../signature.js";

function sign(body: string, key: string, ts: number): string {
  const sig = createHmac("sha256", key).update(`${ts}.${body}`).digest("hex");
  return `t=${ts},v1=${sig}`;
}

describe("verifyZitadelSignature", () => {
  const key = "test-signing-key";
  const now = 1700000000;
  const body = '{"hello":"world"}';

  it("accepts a correct signature within tolerance", () => {
    const header = sign(body, key, now);
    const r = verifyZitadelSignature(body, header, {
      signingKeys: [key],
      now: () => now,
    });
    expect(r.ok).toBe(true);
  });

  it("rejects tampered body", () => {
    const header = sign(body, key, now);
    const r = verifyZitadelSignature('{"hello":"tampered"}', header, {
      signingKeys: [key],
      now: () => now,
    });
    expect(r.ok).toBe(false);
  });

  it("rejects with wrong key", () => {
    const header = sign(body, key, now);
    const r = verifyZitadelSignature(body, header, {
      signingKeys: ["other-key"],
      now: () => now,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("no_match");
  });

  it("rejects when timestamp is outside tolerance", () => {
    const header = sign(body, key, now - 1000);
    const r = verifyZitadelSignature(body, header, {
      signingKeys: [key],
      toleranceSeconds: 300,
      now: () => now,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("timestamp_outside_tolerance");
  });

  it("accepts when ANY of the configured keys matches", () => {
    const header = sign(body, "key-b", now);
    const r = verifyZitadelSignature(body, header, {
      signingKeys: ["key-a", "key-b", "key-c"],
      now: () => now,
    });
    expect(r.ok).toBe(true);
  });

  it("accepts when ANY of the v1 signatures matches", () => {
    const ts = now;
    const sigA = createHmac("sha256", "key-a").update(`${ts}.${body}`).digest("hex");
    const sigB = createHmac("sha256", "key-b").update(`${ts}.${body}`).digest("hex");
    const header = `t=${ts},v1=${sigA},v1=${sigB}`;
    const r = verifyZitadelSignature(body, header, {
      signingKeys: ["key-b"],
      now: () => now,
    });
    expect(r.ok).toBe(true);
  });

  it("rejects missing header", () => {
    const r = verifyZitadelSignature(body, undefined, {
      signingKeys: [key],
      now: () => now,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("missing_header");
  });

  it("rejects when no signing keys configured", () => {
    const header = sign(body, key, now);
    const r = verifyZitadelSignature(body, header, {
      signingKeys: [],
      now: () => now,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("no_signing_keys_configured");
  });
});
