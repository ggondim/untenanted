import type { DB } from "../db/index.js";
import type { UserTenantAuthorization } from "@untenanted/types";

interface Row {
  user_id: string;
  tenant_id: string;
  roles: string[];
  created_at: Date;
}

function toDto(r: Row): UserTenantAuthorization {
  return {
    userId: r.user_id,
    tenantId: r.tenant_id,
    roles: r.roles,
    createdAt: r.created_at.toISOString(),
  };
}

export class UserAuthzRepository {
  constructor(private readonly db: DB) {}

  /** Idempotent upsert. Returns the resulting row. */
  async grant(
    userId: string,
    tenantId: string,
    roles: string[]
  ): Promise<UserTenantAuthorization> {
    const row = await this.db
      .insertInto("user_tenant_authorization")
      .values({ user_id: userId, tenant_id: tenantId, roles })
      .onConflict((c) =>
        c.columns(["user_id", "tenant_id"]).doUpdateSet({ roles })
      )
      .returningAll()
      .executeTakeFirstOrThrow();
    return toDto(row as unknown as Row);
  }

  async revoke(userId: string, tenantId: string): Promise<boolean> {
    const res = await this.db
      .deleteFrom("user_tenant_authorization")
      .where("user_id", "=", userId)
      .where("tenant_id", "=", tenantId)
      .executeTakeFirst();
    return Number(res.numDeletedRows ?? 0) > 0;
  }

  async listByUser(userId: string): Promise<UserTenantAuthorization[]> {
    const rows = (await this.db
      .selectFrom("user_tenant_authorization")
      .selectAll()
      .where("user_id", "=", userId)
      .execute()) as unknown as Row[];
    return rows.map(toDto);
  }

  async listByTenant(tenantId: string): Promise<UserTenantAuthorization[]> {
    const rows = (await this.db
      .selectFrom("user_tenant_authorization")
      .selectAll()
      .where("tenant_id", "=", tenantId)
      .execute()) as unknown as Row[];
    return rows.map(toDto);
  }

  async deleteAllForUser(userId: string): Promise<number> {
    const res = await this.db
      .deleteFrom("user_tenant_authorization")
      .where("user_id", "=", userId)
      .executeTakeFirst();
    return Number(res.numDeletedRows ?? 0);
  }
}
