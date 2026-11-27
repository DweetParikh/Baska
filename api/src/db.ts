import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client";

export type Db = PrismaClient;

/** Prisma 7: queries go through a driver adapter (node-postgres). */
export function createDb(connectionString: string, opts: { maxConnections?: number } = {}): Db {
  const adapter = new PrismaPg({ connectionString, max: opts.maxConnections });
  return new PrismaClient({ adapter });
}
