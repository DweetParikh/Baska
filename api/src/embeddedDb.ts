import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import * as fs from "fs";
import * as path from "path";

export interface EmbeddedPostgres {
  url: string;
  stop(): Promise<void>;
}

/**
 * Real Postgres engine (PGlite, WASM) exposed over the wire protocol so the
 * production Prisma + node-postgres code path runs unchanged. For local dev and
 * tests only: it serves one connection at a time, so use maxConnections: 1.
 * Production uses a normal Postgres via DATABASE_URL.
 */
export async function startEmbeddedPostgres(port: number, dataDir?: string): Promise<EmbeddedPostgres> {
  const db = await PGlite.create(dataDir);

  // Apply committed migrations once (tracked in a tiny table, like a mini `migrate deploy`).
  await db.exec(`CREATE TABLE IF NOT EXISTS _applied_migrations (name TEXT PRIMARY KEY)`);
  const dir = path.join(__dirname, "..", "prisma", "migrations");
  const names = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  for (const name of names) {
    const done = await db.query<{ name: string }>(`SELECT name FROM _applied_migrations WHERE name = $1`, [name]);
    if (done.rows.length) continue;
    await db.exec(fs.readFileSync(path.join(dir, name, "migration.sql"), "utf8"));
    await db.query(`INSERT INTO _applied_migrations (name) VALUES ($1)`, [name]);
  }

  const server = new PGLiteSocketServer({ db, port, host: "127.0.0.1", maxConnections: 1 });
  await server.start();
  return {
    url: `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`,
    async stop() {
      await server.stop();
      await db.close();
    },
  };
}
