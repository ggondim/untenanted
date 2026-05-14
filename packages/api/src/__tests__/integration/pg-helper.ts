/**
 * Helper for integration tests against a real Postgres.
 *
 * Tests opt-in via env `UNTENANTED_PG_TEST=1` (or any truthy value). When not
 * set, the test files using this helper should skip themselves so CI on
 * developer machines without Postgres still passes.
 *
 * Connection params follow the same DB_* envs the API uses, with sensible
 * defaults pointing at `docker compose up`'s exposed postgres.
 */
import { createDb, type DB } from "../../db/index.js";
import { loadConfig, type Config } from "../../config.js";
import { migrateToLatest } from "../../db/migrator.js";

export function pgTestEnabled(): boolean {
  return !!process.env.UNTENANTED_PG_TEST;
}

export function buildTestConfig(): Config {
  const overrides: NodeJS.ProcessEnv = {
    HTTP_PORT: "0",
    AUTO_MIGRATE: "false",
    DB_HOST: process.env.DB_HOST ?? "localhost",
    DB_PORT: process.env.DB_PORT ?? "5432",
    DB_NAME: process.env.DB_NAME ?? "untenanted",
    DB_USER: process.env.DB_USER ?? "untenanted",
    DB_PASSWORD: process.env.DB_PASSWORD ?? "untenanted",
    IDP_JWKS_URI: process.env.IDP_JWKS_URI ?? "http://127.0.0.1:9091/jwks.json",
    IDP_ISSUER: process.env.IDP_ISSUER ?? "http://127.0.0.1:9091",
    IDP_AUDIENCE: process.env.IDP_AUDIENCE ?? "platform-api",
    IDP_TOKEN_ENDPOINT:
      process.env.IDP_TOKEN_ENDPOINT ?? "http://127.0.0.1:9091/token",
    IDP_CLIENT_ID: process.env.IDP_CLIENT_ID ?? "untenanted-api",
    INTERNAL_AUTH_SECRET: "internal-test-secret",
    WEBHOOK_AUTH_SECRET: "webhook-test-secret",
    ...process.env,
  };
  return loadConfig(overrides);
}

export interface TestDb {
  db: DB;
  cleanup: () => Promise<void>;
}

export async function setupTestDb(): Promise<TestDb> {
  const config = buildTestConfig();
  const { db, pool } = createDb(config);
  await migrateToLatest(db);
  await db.deleteFrom("user_tenant_authorization").execute();
  await db.deleteFrom("org_tenant_authorization").execute();
  await db.deleteFrom("tenants").execute();
  return {
    db,
    cleanup: async () => {
      await db.destroy();
      await pool.end();
    },
  };
}
