import { describe, it, expect } from "vitest";
import { IamService } from "../iam.js";
import type { UserAuthzRepository } from "../../repos/user-authz.js";
import type { OrgAuthzRepository } from "../../repos/org-authz.js";
import type {
  UserTenantAuthorization,
  OrgTenantAuthorization,
} from "@untenanted/types";

function makeUserAuthz(rows: UserTenantAuthorization[]): UserAuthzRepository {
  return {
    listByUser: async (userId: string) =>
      rows.filter((r) => r.userId === userId),
    listByTenant: async (tenantId: string) =>
      rows.filter((r) => r.tenantId === tenantId),
    grant: async () => rows[0]!,
    revoke: async () => true,
    deleteAllForUser: async () => 0,
  } as unknown as UserAuthzRepository;
}

function makeOrgAuthz(rows: OrgTenantAuthorization[]): OrgAuthzRepository {
  return {
    listByOrg: async (orgId: string) => rows.filter((r) => r.orgId === orgId),
    listByTenant: async (tenantId: string) =>
      rows.filter((r) => r.tenantId === tenantId),
    grant: async () => rows[0]!,
    revoke: async () => true,
    deleteAllForOrg: async () => 0,
  } as unknown as OrgAuthzRepository;
}

const ts = "2026-01-01T00:00:00.000Z";

describe("IamService.listUserTenants", () => {
  it("merges direct + via-org by tenant; roles are unioned", async () => {
    const userAuthz = makeUserAuthz([
      { userId: "u1", tenantId: "t-a", roles: ["campaign:read", "campaign:write"], createdAt: ts },
    ]);
    const orgAuthz = makeOrgAuthz([
      { orgId: "org-a", tenantId: "t-a", roles: ["campaign:read"], createdAt: ts },
      { orgId: "org-a", tenantId: "t-b", roles: ["campaign:read"], createdAt: ts },
    ]);
    const iam = new IamService(userAuthz, orgAuthz);
    const out = await iam.listUserTenants("u1", "org-a");
    expect(out).toEqual([
      {
        tenantId: "t-a",
        effectiveRoles: ["campaign:read", "campaign:write"],
        paths: ["direct", "org"],
      },
      {
        tenantId: "t-b",
        effectiveRoles: ["campaign:read"],
        paths: ["org"],
      },
    ]);
  });

  it("direct outside org still appears", async () => {
    const userAuthz = makeUserAuthz([
      { userId: "u1", tenantId: "t-x", roles: ["viewer"], createdAt: ts },
    ]);
    const orgAuthz = makeOrgAuthz([]);
    const iam = new IamService(userAuthz, orgAuthz);
    const out = await iam.listUserTenants("u1", "org-z");
    expect(out).toHaveLength(1);
    expect(out[0]?.paths).toEqual(["direct"]);
  });
});

describe("IamService.validateExchange (spec §8 scenarios)", () => {
  it("ok when all scopes present in all tids (scenario 1: dashboard a+b read)", async () => {
    const userAuthz = makeUserAuthz([
      { userId: "maria", tenantId: "t-a", roles: ["campaign:read", "campaign:write"], createdAt: ts },
    ]);
    const orgAuthz = makeOrgAuthz([
      { orgId: "agency-y", tenantId: "t-b", roles: ["campaign:read"], createdAt: ts },
    ]);
    const iam = new IamService(userAuthz, orgAuthz);
    const res = await iam.validateExchange(
      "maria",
      "agency-y",
      ["t-a", "t-b"],
      ["campaign:read"]
    );
    expect(res).toEqual({ ok: true, effectiveScopes: ["campaign:read"] });
  });

  it("missing write in t-b (scenario 2: edit in B fails)", async () => {
    const userAuthz = makeUserAuthz([
      { userId: "maria", tenantId: "t-a", roles: ["campaign:read", "campaign:write"], createdAt: ts },
    ]);
    const orgAuthz = makeOrgAuthz([
      { orgId: "agency-y", tenantId: "t-b", roles: ["campaign:read"], createdAt: ts },
    ]);
    const iam = new IamService(userAuthz, orgAuthz);
    const res = await iam.validateExchange(
      "maria",
      "agency-y",
      ["t-b"],
      ["campaign:write"]
    );
    expect(res).toEqual({ ok: false, missing: { "t-b": ["campaign:write"] } });
  });

  it("bulk write a+b fails on b only (scenario 4)", async () => {
    const userAuthz = makeUserAuthz([
      { userId: "maria", tenantId: "t-a", roles: ["campaign:read", "campaign:write"], createdAt: ts },
    ]);
    const orgAuthz = makeOrgAuthz([
      { orgId: "agency-y", tenantId: "t-b", roles: ["campaign:read"], createdAt: ts },
    ]);
    const iam = new IamService(userAuthz, orgAuthz);
    const res = await iam.validateExchange(
      "maria",
      "agency-y",
      ["t-a", "t-b"],
      ["campaign:write"]
    );
    expect(res).toEqual({
      ok: false,
      missing: { "t-b": ["campaign:write"] },
    });
  });

  it("full-fail when tid is unknown to user", async () => {
    const iam = new IamService(makeUserAuthz([]), makeOrgAuthz([]));
    const res = await iam.validateExchange("u1", "org-a", ["t-unknown"], ["s"]);
    expect(res).toEqual({ ok: false, missing: { "t-unknown": ["s"] } });
  });
});

describe("IamService.canDelegate", () => {
  it("ok when caller possesses all requested roles", async () => {
    const userAuthz = makeUserAuthz([
      { userId: "caller", tenantId: "t1", roles: ["campaign:read", "campaign:write", "iam:delegate"], createdAt: ts },
    ]);
    const orgAuthz = makeOrgAuthz([]);
    const iam = new IamService(userAuthz, orgAuthz);
    const res = await iam.canDelegate("caller", "org-a", "t1", ["campaign:read"]);
    expect(res).toEqual({ ok: true });
  });

  it("rejects when caller lacks a role", async () => {
    const userAuthz = makeUserAuthz([
      { userId: "caller", tenantId: "t1", roles: ["campaign:read"], createdAt: ts },
    ]);
    const orgAuthz = makeOrgAuthz([]);
    const iam = new IamService(userAuthz, orgAuthz);
    const res = await iam.canDelegate("caller", "org-a", "t1", ["campaign:read", "campaign:write"]);
    expect(res).toEqual({ ok: false, missing: ["campaign:write"] });
  });
});
