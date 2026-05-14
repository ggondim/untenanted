import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("org_tenant_authorization")
    .addColumn("org_id", "text", (c) => c.notNull())
    .addColumn("tenant_id", "text", (c) =>
      c.notNull().references("tenants.id").onDelete("cascade")
    )
    .addColumn("roles", sql`text[]`, (c) =>
      c.notNull().defaultTo(sql`'{}'::text[]`)
    )
    .addColumn("created_at", "timestamptz", (c) =>
      c.notNull().defaultTo(sql`now()`)
    )
    .addPrimaryKeyConstraint("org_tenant_authz_pk", ["org_id", "tenant_id"])
    .execute();

  await db.schema
    .createIndex("org_tenant_authz_tenant_idx")
    .on("org_tenant_authorization")
    .column("tenant_id")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("org_tenant_authorization").ifExists().execute();
}
