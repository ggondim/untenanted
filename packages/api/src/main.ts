import { loadConfig } from "./config.js";
import { buildServer } from "./server.js";
import { migrateToLatest } from "./db/migrator.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const { app, db, shutdown } = await buildServer({ config });

  if (config.AUTO_MIGRATE) {
    app.log.info("running database migrations");
    await migrateToLatest(db, app.log);
  }

  const close = async (signal: string): Promise<void> => {
    app.log.info({ signal }, "shutting down");
    try {
      await shutdown();
    } catch (e) {
      app.log.error({ err: e }, "shutdown error");
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void close("SIGINT"));
  process.on("SIGTERM", () => void close("SIGTERM"));

  try {
    await app.listen({ host: config.HTTP_HOST, port: config.HTTP_PORT });
  } catch (e) {
    app.log.error({ err: e }, "failed to start server");
    await shutdown();
    process.exit(1);
  }
}

void main();
