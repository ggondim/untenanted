/**
 * Sketch: a downstream application repository that mixes global and tenanted
 * rows in the same table, using @untenanted/middleware's tenancy filter.
 *
 * Not wired into the API — kept here as a reference. The pattern is identical
 * for any Postgres-backed table that has a nullable `tenant_id` column.
 */
import { buildTenancyFragment, renderPgFragment } from "@untenanted/middleware";
import type { Client } from "pg";

interface CampaignRow {
  id: string;
  name: string;
  tenant_id: string | null;
}

export class CampaignRepository {
  constructor(private readonly pg: Client) {}

  /** Lists campaigns visible to the caller (globals + accessible tenanted). */
  async list(tids: readonly string[]): Promise<CampaignRow[]> {
    const fragment = buildTenancyFragment("tenant_id", tids);
    const pg = renderPgFragment(fragment);
    const sql = `SELECT id, name, tenant_id FROM campaigns WHERE ${pg.sql}`;
    const res = await this.pg.query<CampaignRow>(sql, pg.values);
    return res.rows;
  }

  /**
   * Atomic UPDATE that scopes by tenant. Returns the affected count; the route
   * maps 0 → 404 to avoid info leaks (spec §13).
   */
  async update(
    id: string,
    patch: { name?: string },
    tids: readonly string[]
  ): Promise<number> {
    if (patch.name === undefined) return 0;
    const fragment = buildTenancyFragment("tenant_id", tids);
    const pg = renderPgFragment(fragment, 3); // $1=id, $2=name placeholders
    const sql =
      `UPDATE campaigns SET name = $2 WHERE id = $1 AND ${pg.sql} RETURNING id`;
    const values: unknown[] = [id, patch.name, ...pg.values];
    const res = await this.pg.query(sql, values);
    return res.rowCount ?? 0;
  }
}
