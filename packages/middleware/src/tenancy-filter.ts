/**
 * Helpers to build the row-level tenancy WHERE expression used by repositories
 * over global+tenanted tables (spec §13).
 *
 *   column IS NULL OR column IN (:tids)
 *
 * The helpers are framework-agnostic: they produce raw SQL fragments + bind
 * values. Adapters for Kysely / pg / drizzle can wrap them.
 */

export interface TenancyFragment {
  /** SQL with `?` placeholders. Caller maps to driver-specific syntax. */
  sql: string;
  /** Ordered bind values. Empty if tids is empty (only the IS NULL branch). */
  values: string[];
}

export function buildTenancyFragment(
  column: string,
  tids: readonly string[]
): TenancyFragment {
  if (tids.length === 0) {
    return { sql: `${column} IS NULL`, values: [] };
  }
  const placeholders = tids.map(() => "?").join(", ");
  return {
    sql: `(${column} IS NULL OR ${column} IN (${placeholders}))`,
    values: [...tids],
  };
}

/**
 * Renders the fragment with $1,$2,... placeholders (pg style). `startIndex`
 * lets the caller continue a positional bind count.
 */
export function renderPgFragment(
  fragment: TenancyFragment,
  startIndex = 1
): { sql: string; values: string[] } {
  let i = startIndex;
  const sql = fragment.sql.replace(/\?/g, () => `$${i++}`);
  return { sql, values: fragment.values };
}

/**
 * Kysely-style helper that accepts an ExpressionBuilder and returns a
 * tenancy predicate. Imported lazily inside packages that depend on Kysely so
 * that this module stays framework-free.
 */
export function kyselyTenancyWhere<
  EB extends {
    or: (preds: unknown[]) => unknown;
    eb: <K, OP, V>(k: K, op: OP, v: V) => unknown;
  },
>(eb: EB, column: string, tids: readonly string[]): unknown {
  const isNull = eb.eb(column, "is", null);
  if (tids.length === 0) return isNull;
  const inList = eb.eb(column, "in", tids as unknown);
  return eb.or([isNull, inList]);
}
