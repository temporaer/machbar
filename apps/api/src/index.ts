import { buildApp } from "./app.js";
import { openDb } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { seedDatabase } from "./db/seed.js";
import * as schema from "./db/schema.js";
import { loadEnv } from "./env.js";

async function main() {
  const env = loadEnv();
  const { db, sqlite } = openDb(env.databasePath);
  runMigrations(db);

  if (env.seedDatabase) {
    const hasMembers = db.select().from(schema.members).limit(1).all().length > 0;
    if (!hasMembers) {
      seedDatabase(db);
    }
  }

  const app = buildApp({ db, env, logger: true });

  const shutdown = async () => {
    await app.close();
    sqlite.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await app.listen({ port: env.port, host: env.host });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
