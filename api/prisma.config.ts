import { defineConfig } from "prisma/config";

// DATABASE_URL is only needed by CLI commands that touch a database.
// `prisma generate` and `migrate diff --from-empty` work without it.
export default defineConfig({
  schema: "./prisma/schema.prisma",
  migrations: { path: "./prisma/migrations" },
  datasource: { url: process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/baska" },
});
