import type { DB } from "../db/index.js";
import type { Tenant, TenantStatus } from "@untenanted/types";

export interface TenantRow {
  id: string;
  name: string;
  owner_org_id: string | null;
  status: TenantStatus;
  plan: string | null;
  properties: Record<string, unknown>;
  created_at: Date;
}

function rowToTenant(r: TenantRow): Tenant {
  return {
    id: r.id,
    name: r.name,
    ownerOrgId: r.owner_org_id,
    status: r.status,
    plan: r.plan,
    properties: r.properties ?? {},
    createdAt: r.created_at.toISOString(),
  };
}

export class TenantRepository {
  constructor(private readonly db: DB) {}

  async create(input: {
    id: string;
    name: string;
    ownerOrgId?: string | null;
    status?: TenantStatus;
    plan?: string | null;
    properties?: Record<string, unknown>;
  }): Promise<Tenant> {
    const row = await this.db
      .insertInto("tenants")
      .values({
        id: input.id,
        name: input.name,
        owner_org_id: input.ownerOrgId ?? null,
        status: input.status ?? "active",
        plan: input.plan ?? null,
        properties: input.properties ?? {},
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return rowToTenant(row as unknown as TenantRow);
  }

  async findById(id: string): Promise<Tenant | null> {
    const row = await this.db
      .selectFrom("tenants")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    return row ? rowToTenant(row as unknown as TenantRow) : null;
  }

  async list(input: {
    limit: number;
    cursor?: string;
    status?: TenantStatus;
    ownerOrgId?: string;
  }): Promise<{ tenants: Tenant[]; nextCursor: string | null }> {
    let q = this.db.selectFrom("tenants").selectAll().orderBy("id", "asc");
    if (input.cursor) q = q.where("id", ">", input.cursor);
    if (input.status) q = q.where("status", "=", input.status);
    if (input.ownerOrgId) q = q.where("owner_org_id", "=", input.ownerOrgId);
    q = q.limit(input.limit + 1);
    const rows = (await q.execute()) as unknown as TenantRow[];
    const slice = rows.slice(0, input.limit);
    const nextCursor =
      rows.length > input.limit ? slice[slice.length - 1]?.id ?? null : null;
    return { tenants: slice.map(rowToTenant), nextCursor };
  }

  async update(
    id: string,
    patch: {
      name?: string;
      ownerOrgId?: string | null;
      status?: TenantStatus;
      plan?: string | null;
      properties?: Record<string, unknown>;
    }
  ): Promise<Tenant | null> {
    const updates: Record<string, unknown> = {};
    if (patch.name !== undefined) updates.name = patch.name;
    if (patch.ownerOrgId !== undefined) updates.owner_org_id = patch.ownerOrgId;
    if (patch.status !== undefined) updates.status = patch.status;
    if (patch.plan !== undefined) updates.plan = patch.plan;
    if (patch.properties !== undefined) updates.properties = patch.properties;
    if (Object.keys(updates).length === 0) {
      return this.findById(id);
    }
    const row = await this.db
      .updateTable("tenants")
      .set(updates as never)
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirst();
    return row ? rowToTenant(row as unknown as TenantRow) : null;
  }

  async delete(id: string): Promise<boolean> {
    const res = await this.db
      .deleteFrom("tenants")
      .where("id", "=", id)
      .executeTakeFirst();
    return Number(res.numDeletedRows ?? 0) > 0;
  }
}
