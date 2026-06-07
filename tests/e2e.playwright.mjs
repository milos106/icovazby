#!/usr/bin/env node
/**
 * End-to-end test against a running ares-web server.
 *
 * Run prerequisites:
 *   npm run build  &&  PORT=3000 node dist/server.js &
 *
 * Then:
 *   node tests/e2e.playwright.mjs
 *
 * Playwright must be installed in a parent / accessible path. The file is not
 * wired into npm test because Playwright is heavy and ARES is rate-limited.
 */

import { chromium } from "playwright";

const BASE = process.env.E2E_BASE_URL ?? "http://127.0.0.1:3000";

function pass(name) { console.log(`  ✓ ${name}`); }
function fail(name, reason) { console.log(`  ✗ ${name} — ${reason}`); process.exitCode = 1; }

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1600, height: 1100 },
  permissions: ["clipboard-read", "clipboard-write"],
});
const page = await ctx.newPage();
page.on("pageerror", (err) => console.log("[PAGE ERR]", err.message));

console.log(`\n→ Testing against ${BASE}\n`);

// 1. Profile by IČO
await page.goto(BASE);
await page.waitForTimeout(800);
await page.fill("#search input", "26185610");
await page.click("#search button[type=submit]");
await page.waitForTimeout(2500);
const profileText = await page.textContent("#search");
profileText.includes("AGROFERT") ? pass("profile loads AGROFERT") : fail("profile loads AGROFERT", "no name");

// 2. URL state
const url = page.url();
url.includes("ico=26185610") && url.includes("action=profile")
  ? pass("URL reflects ico+action")
  : fail("URL state", url);

// 3. RES toggle
await page.getByText("Klasifikace (RES)").click();
await page.waitForTimeout(1500);
const resText = await page.textContent("#search");
resText.includes("MEDIUM SME") && resText.includes("Soukromé")
  ? pass("RES toggle shows SME + sector")
  : fail("RES toggle", "missing labels");

// 4. Fakturoid export → clipboard
await page.locator("#search button:has-text('Fakturoid')").first().click();
await page.waitForTimeout(800);
const clip = await page.evaluate(() => navigator.clipboard.readText());
clip.includes("AGROFERT") && clip.includes("registration_no")
  ? pass("Fakturoid export → clipboard")
  : fail("Fakturoid clipboard", clip.slice(0, 80));

// 5. DD shows RED for insolvent
await page.goto(`${BASE}/?ico=45193258&action=dd`);
await page.waitForTimeout(5000);
const ddText = await page.textContent("#dd");
ddText.includes("Liberty Ostrava") && ddText.includes("🔴")
  ? pass("DD deep link → RED for Liberty Ostrava")
  : fail("DD deep link", "missing");

// 6. Cross-company graph renders Mermaid SVG
await page.goto(`${BASE}/?icos=26185610,46967851,46900411,27435148`);
await page.waitForTimeout(6000);
const svgPresent = await page.evaluate(() => !!document.querySelector("#graph svg"));
svgPresent ? pass("graph deep link → Mermaid SVG") : fail("graph SVG", "missing");

// 7. Address shell detection
await page.fill("#address input", "Vratimovská 689/117, Ostrava");
await page.click("#address button[type=submit]");
await page.waitForTimeout(3000);
const addressText = await page.textContent("#address");
/sídlí\s+\d+/.test(addressText) ? pass("address shell detection") : fail("address shell", "no count");

// 8. History dropdown contains recent
await page.click("header button:has-text('Historie')");
await page.waitForTimeout(500);
const dropdownText = await page.textContent("header").catch(() => "");
dropdownText.includes("26185610") ? pass("history dropdown shows visited IČO") : fail("history", "no recent");

await browser.close();
console.log("\n→ E2E complete\n");
