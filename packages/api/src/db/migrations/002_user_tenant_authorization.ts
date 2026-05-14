import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("user_tenant_authorization")
    .addColumn("user_id", "text", (c) => c.notNull())
    .addColumn("tenant_id", "text", (c) =>
      c.notNull().references("tenants.id").onDelete("cascade")
    )
    .addColumn("roles", sql`text[]`, (c) =>
      c.notNull().defaultTo(sql`'{}'::text[]`)
    )
    .addColumn("created_at", "timestamptz", (c) =>
      c.notNull().defaultTo(sql`now()`)
    )
    .addPrimaryKeyConstraint("user_tenant_authz_pk", ["user_id", "tenant_id"])
    .execute();

  await db.schema
    .createIndex("user_tenant_authz_tenant_idx")
    .on("user_tenant_authorization")
    .column("tenant_id")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("user_tenant_authorization").ifExists().execute();
}
