import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import Fastify from "fastify";
import { createZitadelAdapter } from "../plugin.js";

function sign(body: string, key: string, ts = Math.floor(Date.now() / 1000)): string {
  const sig = createHmac("sha256", key).update(`${ts}.${body}`).digest("hex");
  return `t=${ts},v1=${sig}`;
}

function makeIam(): {
  iam: Parameters<typeof createZitadelAdapter>[0]["iam"];
  userDeletions: string[];
  orgDeletions: string[];
} {
  const userDeletions: string[] = [];
  const orgDeletions: string[] = [];
  return {
    userDeletions,
    orgDeletions,
    iam: {
      listUserTenants: async (userId: string, orgId: string) => {
        if (userId === "u1" && orgId === "o1") {
          return [
            { tenantId: "t-a", effectiveRoles: ["campaign:read", "campaign:write"] },
            { tenantId: "t-b", effectiveRoles: ["campaign:read"] },
          ];
        }
        return [];
      },
      deleteAllUserAuthz: async (userId: string) => {
        userDeletions.push(userId);
        return 1;
      },
      deleteAllOrgAuthz: async (orgId: string) => {
        orgDeletions.push(orgId);
        return 1;
      },
    },
  };
}

describe("zitadel adapter plugin", () => {
  it("preaccesstoken returns append_claims with tids + intersected scope", async () => {
    const { iam } = makeIam();
    const app = Fastify();
    await createZitadelAdapter({ iam, signingKeys: [] })(app, {});

    const res = await app.inject({
      method: "POST",
      url: "/adapters/zitadel/preaccesstoken",
      payload: { user: { id: "u1" }, org: { id: "o1" } },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.append_claims).toEqual(
      expect.arrayContaining([
        { key: "urn:untenanted:org_id", value: "o1" },
        { key: "urn:untenanted:tids", value: ["t-a", "t-b"] },
        { key: "scope", value: "campaign:read" },
      ])
    );
    await app.close();
  });

  it("rejects bad signature when keys are configured", async () => {
    const { iam } = makeIam();
    const app = Fastify();
    await createZitadelAdapter({
      iam,
      signingKeys: ["k1"],
    })(app, {});
    const payload = JSON.stringify({ user: { id: "u1" }, org: { id: "o1" } });
    const res = await app.inject({
      method: "POST",
      url: "/adapters/zitadel/preaccesstoken",
      headers: {
        "content-type": "application/json",
        "zitadel-signature": "t=1700000000,v1=deadbeef",
      },
      payload,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("invalid_signature");
    await app.close();
  });

  it("accepts valid signature and processes", async () => {
    const { iam } = makeIam();
    const app = Fastify();
    await createZitadelAdapter({
      iam,
      signingKeys: ["k1"],
    })(app, {});
    const payload = JSON.stringify({ user: { id: "u1" }, org: { id: "o1" } });
    const res = await app.inject({
      method: "POST",
      url: "/adapters/zitadel/preaccesstoken",
      headers: {
        "content-type": "application/json",
        "zitadel-signature": sign(payload, "k1"),
      },
      payload,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().append_claims).toBeTruthy();
    await app.close();
  });

  it("events route dispatches user.removed and org.removed", async () => {
    const fixture = makeIam();
    const app = Fastify();
    await createZitadelAdapter({ iam: fixture.iam, signingKeys: [] })(app, {});

    const r1 = await app.inject({
      method: "POST",
      url: "/adapters/zitadel/events",
      payload: { event_type: "user.human.removed", aggregateID: "user-xyz" },
    });
    expect(r1.json()).toMatchObject({ forwarded: "user.removed", affected: 1 });
    expect(fixture.userDeletions).toContain("user-xyz");

    const r2 = await app.inject({
      method: "POST",
      url: "/adapters/zitadel/events",
      payload: { eventType: "org.removed", aggregateId: "org-zzz" },
    });
    expect(r2.json()).toMatchObject({ forwarded: "org.removed", affected: 1 });
    expect(fixture.orgDeletions).toContain("org-zzz");

    const r3 = await app.inject({
      method: "POST",
      url: "/adapters/zitadel/events",
      payload: { event_type: "user.profile.updated", aggregateID: "u1" },
    });
    expect(r3.json()).toMatchObject({ ignored: true });
    await app.close();
  });
});
