import { Actor, log } from 'apify';
import { CARD_SELECTORS, extractRawCards, parseCards, categoryMatches } from './extract.js';
import { appendToSheet } from './sheets.js';

await Actor.init();

// ----------------------------- helpers --------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randBetween = (a, b) => Math.floor(a + Math.random() * Math.max(0, b - a));
const pad = (n) => String(n).padStart(2, '0');

function fmtDate(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; // YYYY-MM-DD
}

function computeDates({ daysUntilPickup, lengthDays, pickupTime, dropoffTime }) {
  const start = new Date();
  start.setDate(start.getDate() + daysUntilPickup);
  const [ph, pm] = pickupTime.split(':').map(Number);
  start.setHours(ph, pm, 0, 0);

  const end = new Date(start);
  end.setDate(end.getDate() + lengthDays);
  const [rh, rm] = dropoffTime.split(':').map(Number);
  end.setHours(rh, rm, 0, 0);

  return { start, end };
}

async function waitForAnySelector(page, selectors, timeout) {
  await Promise.any(selectors.map((s) => page.waitForSelector(s, { timeout })));
}

// We only ever READ result listings. If we ever land on a checkout/payment/
// confirmation page, abort — the actor must never book.
function isCheckoutUrl(u) {
  return /(checkout|payment|\/pay\b|confirm|reservation\/complete)/i.test(u || '');
}

// Detect a bot/login challenge. We never solve it — we stop and report.
async function detectBlock(page) {
  let html = '';
  try {
    html = (await page.content()).toLowerCase();
  } catch {
    return null;
  }
  const indicators = [
    'recaptcha', 'hcaptcha', 'g-recaptcha', 'datadome', 'px-captcha',
    'unusual traffic', 'access denied', 'are you a robot', 'verify you are human',
    'captcha',
  ];
  return indicators.find((i) => html.includes(i)) || null;
}

async function saveDebug(page, key) {
  try {
    const png = await page.screenshot({ fullPage: true });
    await Actor.setValue(`${key}.png`, png, { contentType: 'image/png' });
    await Actor.setValue(`${key}.html`, await page.content(), { contentType: 'text/html' });
    log.info(`Saved debug snapshot to key-value store: ${key}.png / ${key}.html`);
  } catch (e) {
    log.warning(`Could not save debug snapshot: ${e.message}`);
  }
}

function buildSearchUrl(template, { pickup, dropoff, start, end, pickupTime, dropoffTime }) {
  return template
    .replaceAll('{pickup}', encodeURIComponent(pickup))
    .replaceAll('{dropoff}', encodeURIComponent(dropoff))
    .replaceAll('{pickupDate}', fmtDate(start))
    .replaceAll('{dropoffDate}', fmtDate(end))
    .replaceAll('{pickupTime}', encodeURIComponent(pickupTime))
    .replaceAll('{dropoffTime}', encodeURIComponent(dropoffTime));
}

async function postToIngestEndpoint({ ingestUrl, scannerSecret, rows }) {
  if (!ingestUrl || !rows.length) return { posted: 0, skipped: true };

  const deals = rows.map((r) => ({
    pickup_location: r.pickup_location,
    dropoff_location: r.return_location,
    vehicle_class: r.vehicle_category,
    vehicle_examples: r.example_vehicle,
    make: r.example_vehicle || null,
    pickup_at: r.pickup_datetime,
    dropoff_at: r.return_datetime,
    days: r.rental_days,
    rate_type: r.rate_type,
    price_per_day: r.daily_price,
    total_price: r.total_price,
    currency: r.currency || 'USD',
    booking_url: r.booking_url,
    deal_score: r.deal_score || 0,
    raw: r,
  }));

  const headers = { 'content-type': 'application/json' };
  if (scannerSecret) headers['x-scanner-secret'] = scannerSecret;

  const res = await fetch(ingestUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({ deals }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Ingest endpoint failed: ${res.status} ${res.statusText} ${body}`);
  }

  return { posted: deals.length, skipped: false };
}

/** Best-effort form fill (used only when no searchUrlTemplate is given). */
async function tryFormSearch(page, input) {
  const pickup = page
    .locator(
      'input[placeholder*="Pick" i], input[name*="pickup" i], input[id*="pickup" i], input[aria-label*="Pick" i]'
    )
    .first();
  await pickup.waitFor({ timeout: 8000 });
  await pickup.click();
  await pickup.fill(input.pickupCode);
  await sleep(1500);
  const suggestion = page
    .locator('[role="option"], [class*="suggestion" i] li, [class*="autocomplete" i] li')
    .first();
  if (await suggestion.count()) await suggestion.click();

  // NOTE: date/time pickers are site-specific. For reliable headless runs,
  // provide `searchUrlTemplate` instead of relying on this.
  const searchBtn = page
    .locator(
      'button:has-text("Search"), button:has-text("Show cars"), button:has-text("Find a car"), [type="submit"]'
    )
    .first();
  if (await searchBtn.count()) await searchBtn.click();
}

async function runOneSearch(page, input, lengthDays) {
  const { start, end } = computeDates({
    daysUntilPickup: input.daysUntilPickup,
    lengthDays,
    pickupTime: input.pickupTime,
    dropoffTime: input.dropoffTime,
  });

  log.info(
    `Search: ${input.pickupCode}->${input.dropoffCode} | ${fmtDate(start)} ${input.pickupTime} -> ${fmtDate(end)} ${input.dropoffTime} | ${lengthDays} days`
  );

  if (input.searchUrlTemplate) {
    const url = buildSearchUrl(input.searchUrlTemplate, {
      pickup: input.pickupCode,
      dropoff: input.dropoffCode,
      start,
      end,
      pickupTime: input.pickupTime,
      dropoffTime: input.dropoffTime,
    });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  } else {
    await page.goto(input.sixtBaseUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    try {
      await tryFormSearch(page, input);
    } catch (e) {
      log.warning(`Form search could not complete (${e.message}). Provide searchUrlTemplate for reliable runs.`);
    }
  }

  // Safety: never proceed on a checkout/booking page.
  if (isCheckoutUrl(page.url())) {
    throw new Error(`Refusing to continue on a checkout/booking URL: ${page.url()}`);
  }

  // Stop immediately if a challenge appears — do not attempt to bypass it.
  const blocked = await detectBlock(page);
  if (blocked) {
    await saveDebug(page, `blocked-${Date.now()}`);
    throw new Error(`Login/bot challenge detected ("${blocked}"). Not bypassing — stopping this run.`);
  }

  try {
    await waitForAnySelector(page, CARD_SELECTORS, 25000);
  } catch {
    await saveDebug(page, `no-results-${lengthDays}d-${Date.now()}`);
    log.warning(`No result cards detected for ${lengthDays} days.`);
    return [];
  }

  await sleep(1500); // let lazy content settle

  const rawCards = await extractRawCards(page);
  const parsed = parseCards(rawCards, {
    categories: input.categories,
    rentalDays: lengthDays,
  });

  // Keep requested categories; if none match (parsing miss), keep all so data
  // isn't silently lost — flagged with category_matched=false.
  const matched = parsed.filter((r) => categoryMatches(r.vehicle_category, input.categories));
  const chosen = matched.length ? matched : parsed;

  return chosen.map((r) => ({
    scanned_at: new Date().toISOString(),
    pickup_location: input.pickupCode,
    return_location: input.dropoffCode,
    pickup_datetime: start.toISOString(),
    return_datetime: end.toISOString(),
    rental_days: lengthDays,
    requested_categories: (input.categories || []).join(', '),
    vehicle_category: r.vehicle_category,
    category_matched: categoryMatches(r.vehicle_category, input.categories),
    example_vehicle: r.example_vehicle,
    rate_type: r.rate_type,
    total_price: r.total_price,
    daily_price: r.daily_price,
    currency: r.currency,
    booking_url: r.booking_url,
    source: 'sixt',
  }));
}

// ------------------------------- main ---------------------------------------

const input = (await Actor.getInput()) || {};

// Defaults (mirror input_schema).
input.sixtBaseUrl ||= 'https://www.sixt.com/';
input.pickupCode ||= 'LAX';
input.dropoffCode ||= 'LAX';
input.pickupTime ||= '10:00';
input.dropoffTime ||= '10:00';
input.minDays ??= 5;
input.maxDays ??= 27;
input.dayStep ??= 1;
input.daysUntilPickup ??= 21;
input.categories ||= ['Premium SUV', 'Luxury SUV', 'Executive SUV'];
input.testRunOnly ??= true;
input.maxSearches ??= 30;
input.minDelayMs ??= 8000;
input.maxDelayMs ??= 20000;
input.googleSheetTabName ||= 'SIXT';

// Session: from input, else from key-value store key SIXT_SESSION.
let session = input.loginSession;
if (!session) session = await Actor.getValue('SIXT_SESSION');
if (!session || !session.cookies) {
  throw new Error(
    'No login session provided. Run `npm run capture-session` locally to log in by hand, ' +
      'then paste the JSON into the loginSession input (or store it as key-value key SIXT_SESSION). ' +
      'Your password is never used or stored.'
  );
}

// Google service account: from input, else key-value store.
let serviceAccount = input.googleServiceAccount;
if (!serviceAccount) serviceAccount = await Actor.getValue('GOOGLE_SERVICE_ACCOUNT');

// Proxy (recommended to reduce challenges; we still never bypass CAPTCHA).
const proxyConfiguration = await Actor.createProxyConfiguration(input.proxyConfiguration);
const launchContext = { launchOptions: { headless: true } };
if (proxyConfiguration) launchContext.proxyUrl = await proxyConfiguration.newUrl();

const browser = await Actor.launchPlaywright(launchContext);
const context = await browser.newContext({
  storageState: session,
  locale: 'en-US',
  viewport: { width: 1380, height: 900 },
});
const page = await context.newPage();

// Build the list of rental lengths.
let lengths = [];
for (let d = input.minDays; d <= input.maxDays; d += input.dayStep) lengths.push(d);
if (input.testRunOnly) {
  lengths = lengths.slice(0, 1); // one test search first
  log.info('testRunOnly is ON — running a single test search.');
}
lengths = lengths.slice(0, input.maxSearches);

const allRows = [];
let hadFatalBlock = false;

try {
  for (let i = 0; i < lengths.length; i++) {
    const lengthDays = lengths[i];

    if (i > 0) {
      const wait = randBetween(input.minDelayMs, input.maxDelayMs);
      log.info(`Scanning slowly — waiting ${Math.round(wait / 1000)}s before next search...`);
      await sleep(wait);
    }

    let rows;
    try {
      rows = await runOneSearch(page, input, lengthDays);
    } catch (e) {
      // A detected challenge is fatal (we won't bypass); stop the sweep.
      if (/challenge detected/i.test(e.message)) {
        log.error(e.message);
        hadFatalBlock = true;
        break;
      }
      log.warning(`Search for ${lengthDays} days failed: ${e.message}`);
      continue;
    }

    if (rows.length) {
      await Actor.pushData(rows); // Apify dataset
      allRows.push(...rows);
      log.info(`Extracted ${rows.length} row(s) for ${lengthDays} days.`);
    }
  }

  // v0 / Supabase app ingest endpoint (optional). This lets the Apify scanner
  // send deals straight into your v0 app. The app should protect this route with
  // x-scanner-secret.
  if (allRows.length && input.ingestUrl) {
    try {
      const { posted } = await postToIngestEndpoint({
        ingestUrl: input.ingestUrl,
        scannerSecret: input.scannerSecret,
        rows: allRows,
      });
      log.info(`Posted ${posted} deal(s) to ingest endpoint.`);
    } catch (e) {
      log.error(`Ingest endpoint POST failed: ${e.message}`);
    }
  }

  // Google Sheets (optional).
  if (allRows.length && input.googleSheetId && serviceAccount) {
    try {
      const { appended } = await appendToSheet({
        serviceAccount,
        spreadsheetId: input.googleSheetId,
        tabName: input.googleSheetTabName,
        rows: allRows,
      });
      log.info(`Appended ${appended} row(s) to Google Sheet "${input.googleSheetTabName}".`);
    } catch (e) {
      log.error(`Google Sheets write failed: ${e.message}`);
    }
  } else if (allRows.length && input.googleSheetId && !serviceAccount) {
    log.warning('googleSheetId set but no service account provided — skipping Sheets.');
  }

  await Actor.setValue('SUMMARY', {
    searches: lengths,
    totalRows: allRows.length,
    blocked: hadFatalBlock,
    finishedAt: new Date().toISOString(),
  });

  log.info(`Done. Total rows: ${allRows.length}.${hadFatalBlock ? ' (Stopped early due to a challenge.)' : ''}`);
} finally {
  await page.close().catch(() => {});
  await browser.close().catch(() => {});
}

await Actor.exit();
