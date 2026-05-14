import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import type { Database } from "./schema.js";
import type { Config } from "../config.js";

export type DB = Kysely<Database>;

export function createDb(config: Config): { db: DB; pool: pg.Pool } {
  const ssl =
    config.DB_SSL === "disable"
      ? false
      : config.DB_SSL === "require"
      ? { rejectUnauthorized: false }
      : { rejectUnauthorized: true };

  const pool = new pg.Pool({
    host: config.DB_HOST,
    port: config.DB_PORT,
    database: config.DB_NAME,
    user: config.DB_USER,
    password: config.DB_PASSWORD,
    max: config.DB_POOL_MAX,
    ssl: ssl || undefined,
  });

  const db = new Kysely<Database>({
    dialect: new PostgresDialect({ pool }),
  });
  return { db, pool };
}
