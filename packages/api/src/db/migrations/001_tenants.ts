import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("tenants")
    .addColumn("id", "text", (c) => c.primaryKey())
    .addColumn("name", "text", (c) => c.notNull())
    .addColumn("owner_org_id", "text")
    .addColumn("status", "text", (c) => c.notNull().defaultTo("active"))
    .addColumn("plan", "text")
    .addColumn("properties", "jsonb", (c) =>
      c.notNull().defaultTo(sql`'{}'::jsonb`)
    )
    .addColumn("created_at", "timestamptz", (c) =>
      c.notNull().defaultTo(sql`now()`)
    )
    .execute();

  await db.schema
    .createIndex("tenants_owner_org_idx")
    .on("tenants")
    .column("owner_org_id")
    .execute();

  await db.schema
    .createIndex("tenants_status_idx")
    .on("tenants")
    .column("status")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("tenants").ifExists().execute();
}
