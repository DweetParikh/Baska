// Copies the on-chain addresses and IDL the frontend needs into src/generated/.
// Run after `scripts/seed-devnet.ts` (deployments/<cluster>.json) and `anchor build` (target/idl).
//   CLUSTER=devnet node scripts/sync-config.mjs
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const cluster = process.env.CLUSTER ?? "devnet";
const out = join(here, "..", "src", "generated");

const files = [
  [join(root, "deployments", `${cluster}.json`), join(out, "deployment.json")],
  [join(root, "target", "idl", "baska_vault.json"), join(out, "baska_vault.json")],
];
mkdirSync(out, { recursive: true });
for (const [from, to] of files) {
  if (!existsSync(from)) {
    console.error(`missing ${from}`);
    process.exit(1);
  }
  copyFileSync(from, to);
  console.log(`copied ${from} -> ${to}`);
}
