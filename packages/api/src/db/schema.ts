import type { Generated, ColumnType, JSONColumnType } from "kysely";

type TenantStatus = "active" | "suspended" | "archived";

export interface TenantsTable {
  id: string;
  name: string;
  owner_org_id: ColumnType<string | null, string | null | undefined, string | null>;
  status: ColumnType<TenantStatus, TenantStatus | undefined, TenantStatus>;
  plan: ColumnType<string | null, string | null | undefined, string | null>;
  properties: JSONColumnType<Record<string, unknown>, Record<string, unknown> | undefined>;
  created_at: ColumnType<Date, Date | string | undefined, never>;
}

export interface UserTenantAuthorizationTable {
  user_id: string;
  tenant_id: string;
  roles: ColumnType<string[], string[] | undefined, string[]>;
  created_at: ColumnType<Date, Date | string | undefined, never>;
}

export interface OrgTenantAuthorizationTable {
  org_id: string;
  tenant_id: string;
  roles: ColumnType<string[], string[] | undefined, string[]>;
  created_at: ColumnType<Date, Date | string | undefined, never>;
}

export interface Database {
  tenants: TenantsTable;
  user_tenant_authorization: UserTenantAuthorizationTable;
  org_tenant_authorization: OrgTenantAuthorizationTable;
}

// silence unused-generic warning for typed inserts when needed
export type _Generated<T> = Generated<T>;
