import fs from 'node:fs';
import readline from 'node:readline';
import { chromium } from 'playwright';

/**
 * LOCAL helper — run this on your Mac, not on Apify.
 *
 *   npm run capture-session
 *
 * Opens a real Chromium window on SIXT. You log into your corporate account
 * BY HAND (including any 2FA / CAPTCHA). Press Enter and it writes your session
 * (cookies only) to ./sixt-session.json. Paste that JSON into the actor's
 * `loginSession` input, or upload it to the key-value store key SIXT_SESSION.
 *
 * Your password is never typed or stored.
 */

const BASE_URL = process.env.SIXT_BASE_URL || 'https://www.sixt.com/';
const OUT = process.env.SESSION_OUT || './sixt-session.json';

function waitForEnter(message) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(message, () => {
      rl.close();
      resolve();
    });
  });
}

const browser = await chromium.launch({ headless: false });
const context = await browser.newContext({ viewport: { width: 1380, height: 900 } });
const page = await context.newPage();

console.log('\nOpening SIXT...');
await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });

console.log(`
------------------------------------------------------------
  LOG IN TO YOUR SIXT CORPORATE ACCOUNT IN THE BROWSER
------------------------------------------------------------
  • Complete the full login yourself (incl. 2FA/CAPTCHA).
  • This script never reads or stores your password.
  • Only the session cookies SIXT sets are exported.
------------------------------------------------------------
`);

await waitForEnter('When fully logged in, press Enter to export the session... ');

const state = await context.storageState();
fs.writeFileSync(OUT, JSON.stringify(state, null, 2));
console.log(`\nSession written to ${OUT}`);
console.log('Paste its contents into the actor input "loginSession" (or KV key SIXT_SESSION).\n');

await browser.close();
process.exit(0);
