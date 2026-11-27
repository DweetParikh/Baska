// Screenshots the main pages in both themes (and a mobile viewport) and reports console errors.
//   APP_URL=http://localhost:3000 SHOTS=/tmp/shots node screenshots.mjs
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const APP = process.env.APP_URL ?? "http://localhost:3000";
const OUT = process.env.SHOTS ?? "shots";
mkdirSync(OUT, { recursive: true });

const pages = [
  ["markets", "/markets", 2500],
  ["fund", "/funds/1", 5000],
  ["watchlist", "/watchlist", 1500],
  ["docs", "/docs", 800],
];
const views = [
  ["desktop", { width: 1360, height: 900 }],
  ["mobile", { width: 390, height: 844 }],
];

const browser = await chromium.launch();
let problems = 0;
for (const theme of ["dark", "light"]) {
  for (const [vname, viewport] of views) {
    const ctx = await browser.newContext({ viewport });
    await ctx.addInitScript((t) => localStorage.setItem("baska-theme", t), theme);
    for (const [name, path, wait] of pages) {
      if (vname === "mobile" && (name === "watchlist" || name === "docs")) continue;
      const page = await ctx.newPage();
      const errs = [];
      page.on("pageerror", (e) => errs.push(e.message.split("\n")[0]));
      page.on("console", (m) => m.type() === "error" && errs.push(m.text().slice(0, 160)));
      await page.goto(APP + path, { waitUntil: "networkidle", timeout: 60000 }).catch((e) => errs.push(e.message.split("\n")[0]));
      await page.waitForTimeout(wait);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
      await page.screenshot({ path: `${OUT}/${theme}-${vname}-${name}.png`, fullPage: true });
      if (errs.length || overflow) problems++;
      console.log(`${theme}/${vname}/${name}: ${errs.length ? "ERRORS " + errs.join(" | ") : "ok"}${overflow ? " HORIZONTAL OVERFLOW" : ""}`);
      await page.close();
    }
    await ctx.close();
  }
}
await browser.close();
process.exit(problems ? 1 : 0);
