import { describe, it, expect } from "vitest";
import {
  Tenant,
  ValidateExchangeRequest,
  ValidateExchangeResponse,
  NormalizedWebhookEvent,
  CreateTenantRequest,
} from "../index.js";

describe("Tenant schema", () => {
  it("accepts a complete tenant", () => {
    const out = Tenant.parse({
      id: "t1",
      name: "Tenant 1",
      ownerOrgId: "org-a",
      status: "active",
      plan: null,
      properties: {},
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(out.id).toBe("t1");
  });

  it("rejects invalid status", () => {
    expect(() =>
      Tenant.parse({
        id: "t1",
        name: "Tenant 1",
        ownerOrgId: null,
        status: "ghost",
        plan: null,
        properties: {},
        createdAt: "2026-01-01T00:00:00.000Z",
      })
    ).toThrow();
  });
});

describe("CreateTenantRequest", () => {
  it("requires id and name", () => {
    expect(() => CreateTenantRequest.parse({})).toThrow();
    const out = CreateTenantRequest.parse({ id: "t", name: "T" });
    expect(out.id).toBe("t");
  });
});

describe("ValidateExchangeRequest", () => {
  it("requires non-empty tids and scopes", () => {
    expect(() =>
      ValidateExchangeRequest.parse({
        userId: "u",
        orgId: "o",
        requestedTids: [],
        requestedScopes: ["s"],
      })
    ).toThrow();
  });
});

describe("ValidateExchangeResponse", () => {
  it("accepts ok shape", () => {
    const out = ValidateExchangeResponse.parse({
      ok: true,
      effectiveScopes: ["a", "b"],
    });
    expect(out.ok).toBe(true);
  });

  it("accepts missing shape", () => {
    const out = ValidateExchangeResponse.parse({
      ok: false,
      missing: { "tenant-a": ["s1"] },
    });
    expect(out.ok).toBe(false);
  });
});

describe("NormalizedWebhookEvent", () => {
  it("discriminates by type", () => {
    const a = NormalizedWebhookEvent.parse({
      type: "user.removed",
      userId: "u",
    });
    const b = NormalizedWebhookEvent.parse({ type: "org.removed", orgId: "o" });
    expect(a.type).toBe("user.removed");
    expect(b.type).toBe("org.removed");
  });

  it("rejects unknown type", () => {
    expect(() =>
      NormalizedWebhookEvent.parse({ type: "user.created", userId: "u" })
    ).toThrow();
  });
});
