// Loads every page in headless Chromium against the running app + API, and reports console
// errors, failed network requests, and whether real data rendered. Optional screenshots.
//
//   npm i playwright && npx playwright install chromium     (one-off, outside the app deps)
//   APP_URL=http://localhost:3000 SHOTS=/tmp/shots node browser-check.mjs
//
// It does NOT connect a wallet (no extension in headless Chromium), so signing flows are not covered.
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const APP = process.env.APP_URL ?? "http://localhost:3000";
const SHOTS = process.env.SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const pages = [
  { path: "/", expect: ["Mutual funds of tokenized stocks", "Mag7 Index", "Total value locked"], name: "home" },
  { path: "/funds", expect: ["Mag7 Index", "Memory & Semis", "S&P Core", "Space & Frontier", "NAV / share"], name: "funds" },
  { path: "/funds/1", expect: ["Mag7 Index", "Holdings", "AAPL", "NAV per share", "Not guaranteed", "Connect wallet"], name: "fund-mag7", wait: 4000 },
  { path: "/funds/3", expect: ["S&P Core", "SPY", "Deposit"], name: "fund-spy", wait: 3000 },
  { path: "/portfolio", expect: ["Your portfolio", "Connect a wallet"], name: "portfolio" },
  { path: "/admin", expect: ["Admin", "Connect the admin wallet"], name: "admin", wait: 2500 },
  { path: "/funds/99", expect: ["Fund not found"], name: "not-found" },
];

const browser = await chromium.launch();
let failed = 0;
for (const p of pages) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const problems = [];
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message.split("\n")[0]}`));
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(`console.error: ${m.text().split("\n")[0].slice(0, 200)}`);
  });
  page.on("requestfailed", (r) => problems.push(`request failed: ${r.url().slice(0, 90)} ${r.failure()?.errorText}`));
  page.on("response", (r) => {
    if (r.status() >= 400 && !r.url().includes("favicon")) problems.push(`HTTP ${r.status()}: ${r.url().slice(0, 90)}`);
  });

  await page.goto(APP + p.path, { waitUntil: "networkidle", timeout: 60000 }).catch((e) => problems.push(`goto: ${e.message.split("\n")[0]}`));
  await page.waitForTimeout(p.wait ?? 1500);
  const text = await page.locator("body").innerText();
  // innerText reflects CSS text-transform (labels render as "NAV / SHARE"), so compare case-insensitively.
  const missing = p.expect.filter((s) => !text.toLowerCase().includes(s.toLowerCase()));
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${p.name}.png`, fullPage: true });

  const ok = missing.length === 0 && problems.length === 0;
  if (!ok) failed++;
  console.log(`${ok ? "✔" : "✘"} ${p.path}${missing.length ? `  missing: ${JSON.stringify(missing)}` : ""}`);
  for (const pr of [...new Set(problems)].slice(0, 6)) console.log(`    ${pr}`);
  await ctx.close();
}
await browser.close();
console.log(failed ? `\n${failed} page(s) with problems` : "\nall pages rendered cleanly");
process.exit(failed ? 1 : 0);
