// Local-only Postgres for development: `npm run api:dev-db`, then run the API with
//   DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5433/postgres
// Data persists in api/.pgdata. Use a real Postgres in any shared/prod environment.
import * as path from "path";
import { startEmbeddedPostgres } from "../src/embeddedDb";

const port = Number(process.env.PGPORT ?? 5433);
startEmbeddedPostgres(port, path.join(__dirname, "..", ".pgdata")).then((pg) => {
  console.log(`embedded postgres ready: ${pg.url}`);
  const stop = async () => {
    await pg.stop();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
});
