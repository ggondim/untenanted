import type { DB } from "../db/index.js";
import type { OrgTenantAuthorization } from "@untenanted/types";

interface Row {
  org_id: string;
  tenant_id: string;
  roles: string[];
  created_at: Date;
}

function toDto(r: Row): OrgTenantAuthorization {
  return {
    orgId: r.org_id,
    tenantId: r.tenant_id,
    roles: r.roles,
    createdAt: r.created_at.toISOString(),
  };
}

export class OrgAuthzRepository {
  constructor(private readonly db: DB) {}

  async grant(
    orgId: string,
    tenantId: string,
    roles: string[]
  ): Promise<OrgTenantAuthorization> {
    const row = await this.db
      .insertInto("org_tenant_authorization")
      .values({ org_id: orgId, tenant_id: tenantId, roles })
      .onConflict((c) =>
        c.columns(["org_id", "tenant_id"]).doUpdateSet({ roles })
      )
      .returningAll()
      .executeTakeFirstOrThrow();
    return toDto(row as unknown as Row);
  }

  async revoke(orgId: string, tenantId: string): Promise<boolean> {
    const res = await this.db
      .deleteFrom("org_tenant_authorization")
      .where("org_id", "=", orgId)
      .where("tenant_id", "=", tenantId)
      .executeTakeFirst();
    return Number(res.numDeletedRows ?? 0) > 0;
  }

  async listByOrg(orgId: string): Promise<OrgTenantAuthorization[]> {
    const rows = (await this.db
      .selectFrom("org_tenant_authorization")
      .selectAll()
      .where("org_id", "=", orgId)
      .execute()) as unknown as Row[];
    return rows.map(toDto);
  }

  async listByTenant(tenantId: string): Promise<OrgTenantAuthorization[]> {
    const rows = (await this.db
      .selectFrom("org_tenant_authorization")
      .selectAll()
      .where("tenant_id", "=", tenantId)
      .execute()) as unknown as Row[];
    return rows.map(toDto);
  }

  async deleteAllForOrg(orgId: string): Promise<number> {
    const res = await this.db
      .deleteFrom("org_tenant_authorization")
      .where("org_id", "=", orgId)
      .executeTakeFirst();
    return Number(res.numDeletedRows ?? 0);
  }
}
