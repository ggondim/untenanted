import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { TenantRepository } from "../../repos/tenant.js";
import { UserAuthzRepository } from "../../repos/user-authz.js";
import { OrgAuthzRepository } from "../../repos/org-authz.js";
import { pgTestEnabled, setupTestDb, type TestDb } from "./pg-helper.js";

const enabled = pgTestEnabled();
const d = enabled ? describe : describe.skip;

d("repositories integration", () => {
  let testDb: TestDb;
  let tenants: TenantRepository;
  let userAuthz: UserAuthzRepository;
  let orgAuthz: OrgAuthzRepository;

  beforeAll(async () => {
    testDb = await setupTestDb();
    tenants = new TenantRepository(testDb.db);
    userAuthz = new UserAuthzRepository(testDb.db);
    orgAuthz = new OrgAuthzRepository(testDb.db);
  });

  afterAll(async () => {
    if (testDb) await testDb.cleanup();
  });

  it("creates, reads, updates, deletes tenants", async () => {
    const t = await tenants.create({ id: "t1", name: "Tenant 1" });
    expect(t.id).toBe("t1");
    const got = await tenants.findById("t1");
    expect(got?.name).toBe("Tenant 1");
    const upd = await tenants.update("t1", { name: "Renamed" });
    expect(upd?.name).toBe("Renamed");
    const del = await tenants.delete("t1");
    expect(del).toBe(true);
    expect(await tenants.findById("t1")).toBeNull();
  });

  it("grants and revokes user/org authz; webhook cleanup nukes by user/org", async () => {
    await tenants.create({ id: "ta", name: "A" });
    await tenants.create({ id: "tb", name: "B" });
    await userAuthz.grant("u1", "ta", ["campaign:read"]);
    await userAuthz.grant("u1", "tb", ["campaign:read"]);
    await orgAuthz.grant("org-a", "ta", ["campaign:read", "iam:delegate"]);

    expect((await userAuthz.listByUser("u1")).length).toBe(2);
    expect((await orgAuthz.listByOrg("org-a")).length).toBe(1);

    await userAuthz.deleteAllForUser("u1");
    expect((await userAuthz.listByUser("u1")).length).toBe(0);

    await orgAuthz.deleteAllForOrg("org-a");
    expect((await orgAuthz.listByOrg("org-a")).length).toBe(0);
  });

  it("upsert overwrites roles atomically", async () => {
    await tenants.create({ id: "tc", name: "C" });
    await userAuthz.grant("u2", "tc", ["a"]);
    const r2 = await userAuthz.grant("u2", "tc", ["a", "b"]);
    expect(r2.roles).toEqual(["a", "b"]);
  });
});
