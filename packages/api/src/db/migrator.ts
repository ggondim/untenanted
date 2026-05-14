import { Migrator, type MigrationProvider, type Migration } from "kysely";
import * as m001 from "./migrations/001_tenants.js";
import * as m002 from "./migrations/002_user_tenant_authorization.js";
import * as m003 from "./migrations/003_org_tenant_authorization.js";
import type { DB } from "./index.js";

const migrations: Record<string, Migration> = {
  "001_tenants": m001,
  "002_user_tenant_authorization": m002,
  "003_org_tenant_authorization": m003,
};

class StaticProvider implements MigrationProvider {
  async getMigrations(): Promise<Record<string, Migration>> {
    return migrations;
  }
}

export function createMigrator(db: DB): Migrator {
  return new Migrator({
    db,
    provider: new StaticProvider(),
    migrationTableName: "untenanted_migrations",
    migrationLockTableName: "untenanted_migrations_lock",
  });
}

export async function migrateToLatest(db: DB, logger?: {
  info: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}): Promise<void> {
  const migrator = createMigrator(db);
  const { error, results } = await migrator.migrateToLatest();
  for (const r of results ?? []) {
    if (r.status === "Success") {
      logger?.info({ migration: r.migrationName }, "applied migration");
    } else if (r.status === "Error") {
      logger?.error({ migration: r.migrationName }, "failed migration");
    }
  }
  if (error) throw error;
}
