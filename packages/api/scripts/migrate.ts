/* eslint-disable no-console */
import { loadConfig } from "../src/config.js";
import { createDb } from "../src/db/index.js";
import { migrateToLatest } from "../src/db/migrator.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const { db, pool } = createDb(config);
  try {
    await migrateToLatest(db, console);
    console.log("migrations applied");
  } finally {
    await db.destroy();
    await pool.end();
  }
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
