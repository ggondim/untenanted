import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildServer, type BuiltServer } from "../../server.js";
import {
  pgTestEnabled,
  setupTestDb,
  buildTestConfig,
  type TestDb,
} from "./pg-helper.js";

const enabled = pgTestEnabled();
const d = enabled ? describe : describe.skip;

d("server integration (no auth)", () => {
  let testDb: TestDb;
  let built: BuiltServer;

  beforeAll(async () => {
    testDb = await setupTestDb();
    built = await buildServer({
      config: buildTestConfig(),
      db: testDb.db,
      disableAuth: true,
    });
  });

  afterAll(async () => {
    if (built) await built.app.close();
    if (testDb) await testDb.cleanup();
  });

  it("internal validate-exchange responds ok/missing per spec", async () => {
    // seed
    await built.app.inject({
      method: "POST",
      url: "/tenants",
      payload: { id: "t-rj", name: "RJ" },
      headers: { "x-internal-auth": "" }, // unauth, but auth disabled
    });
    // Without auth disabled we'd need scope; here disableAuth bypasses middleware
    // entirely, but the scope-guard preHandler still runs. We skip the tenants
    // create call via auth-disabled flow by writing directly through the db
    // before re-running this test if needed.

    // Use the validate-exchange endpoint with the shared secret.
    const res = await built.app.inject({
      method: "POST",
      url: "/iam/internal/validate-exchange",
      headers: { "x-internal-auth": "internal-test-secret" },
      payload: {
        userId: "nobody",
        orgId: "nobody",
        requestedTids: ["t-unknown"],
        requestedScopes: ["s"],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ok: false,
      missing: { "t-unknown": ["s"] },
    });
  });

  it("webhook endpoint rejects without secret", async () => {
    const res = await built.app.inject({
      method: "POST",
      url: "/webhooks/events",
      payload: { type: "user.removed", userId: "u" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("webhook endpoint accepts user.removed and cleans up", async () => {
    // Insert directly via db to avoid the unauth-vs-scope tussle in this test.
    await testDb.db.insertInto("tenants").values({ id: "tw", name: "W" }).execute();
    await testDb.db
      .insertInto("user_tenant_authorization")
      .values({ user_id: "uw", tenant_id: "tw", roles: ["x"] })
      .execute();

    const res = await built.app.inject({
      method: "POST",
      url: "/webhooks/events",
      headers: { "x-webhook-auth": "webhook-test-secret" },
      payload: { type: "user.removed", userId: "uw" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, type: "user.removed" });

    const remaining = await testDb.db
      .selectFrom("user_tenant_authorization")
      .selectAll()
      .where("user_id", "=", "uw")
      .execute();
    expect(remaining.length).toBe(0);
  });
});
