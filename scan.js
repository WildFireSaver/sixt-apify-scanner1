import { Actor, log } from 'apify';
import { chromium } from 'playwright';
import { CARD_SELECTORS, extractRawCards, parseCards, classMatches } from './lib/extract.js';
import { postResults } from './lib/ingest.js';
import { loadSession } from './lib/session.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randBetween = (a, b) => Math.floor(a + Math.random() * Math.max(0, b - a));
const pad = (n) => String(n).padStart(2, '0');

function addDaysStr(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

function eachDate(startStr, endStr, stepDays) {
  const out = [];
  let cur = startStr;
  let guard = 0;
  while (cur <= endStr && guard++ < 2000) {
    out.push(cur);
    cur = addDaysStr(cur, stepDays);
  }
  return out;
}

async function waitForAnySelector(page, selectors, timeout) {
  await Promise.any(selectors.map((s) => page.waitForSelector(s, { timeout })));
}

function isCheckoutUrl(u) {
  return /(checkout|payment|\/pay\b|confirm|reservation\/complete)/i.test(u || '');
}

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
    'two-factor', 'captcha',
  ];
  return indicators.find((i) => html.includes(i)) || null;
}

async function saveDebug(page, key) {
  try {
    await Actor.setValue(`${key}.png`, await page.screenshot({ fullPage: true }), { contentType: 'image/png' });
    await Actor.setValue(`${key}.html`, await page.content(), { contentType: 'text/html' });
    log.info(`Saved debug snapshot: ${key}.png / ${key}.html`);
  } catch (e) {
    log.warning(`Could not save debug snapshot: ${e.message}`);
  }
}

function buildSearchUrl(template, { pickup, dropoff, pickupDate, dropoffDate, pickupTime, dropoffTime }) {
  return template
    .replaceAll('{pickup}', encodeURIComponent(pickup))
    .replaceAll('{dropoff}', encodeURIComponent(dropoff))
    .replaceAll('{pickupDate}', pickupDate)
    .replaceAll('{dropoffDate}', dropoffDate)
    .replaceAll('{pickupTime}', encodeURIComponent(pickupTime))
    .replaceAll('{dropoffTime}', encodeURIComponent(dropoffTime));
}

async function tryFormSearch(page, input) {
  const pickup = page
    .locator('input[placeholder*="Pick" i], input[name*="pickup" i], input[id*="pickup" i], input[aria-label*="Pick" i]')
    .first();
  await pickup.waitFor({ timeout: 8000 });
  await pickup.click();
  await pickup.fill(input.pickupLocation);
  await sleep(1500);
  const suggestion = page.locator('[role="option"], [class*="suggestion" i] li, [class*="autocomplete" i] li').first();
  if (await suggestion.count()) await suggestion.click();
  const searchBtn = page
    .locator('button:has-text("Search"), button:has-text("Show cars"), button:has-text("Find a car"), [type="submit"]')
    .first();
  if (await searchBtn.count()) await searchBtn.click();
}

async function runOneSearch(page, input, combo) {
  const { pickupDate, pickupTime, lengthDays } = combo;
  const dropoffDate = addDaysStr(pickupDate, lengthDays);
  const dropoffTime = pickupTime;
  const pickupAt = `${pickupDate}T${pickupTime}`;
  const dropoffAt = `${dropoffDate}T${dropoffTime}`;

  log.info(`Search: ${input.pickupLocation}->${input.dropoffLocation} | ${pickupAt} -> ${dropoffAt} | ${lengthDays} days`);

  if (input.searchUrlTemplate) {
    const url = buildSearchUrl(input.searchUrlTemplate, {
      pickup: input.pickupLocation,
      dropoff: input.dropoffLocation,
      pickupDate,
      dropoffDate,
      pickupTime,
      dropoffTime,
    });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  } else {
    await page.goto(input.sixtBaseUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    try {
      await tryFormSearch(page, input);
    } catch (e) {
      log.warning(`Form search incomplete (${e.message}). Provide searchUrlTemplate for reliable runs.`);
    }
  }

  if (isCheckoutUrl(page.url())) {
    throw new Error(`Refusing to continue on a checkout/booking URL: ${page.url()}`);
  }

  const blocked = await detectBlock(page);
  if (blocked) {
    await saveDebug(page, `blocked-${Date.now()}`);
    throw new Error(`__BLOCKED__ Login/bot/2FA challenge detected ("${blocked}"). Not bypassing.`);
  }

  try {
    await waitForAnySelector(page, CARD_SELECTORS, 25000);
  } catch {
    await saveDebug(page, `no-results-${pickupDate}-${lengthDays}d-${Date.now()}`);
    log.warning(`No result cards for ${pickupDate} / ${lengthDays} days.`);
    return [];
  }

  await sleep(1500);

  const rawCards = await extractRawCards(page);
  const parsed = parseCards(rawCards, {
    vehicleClasses: input.vehicleClasses,
    preferredMakes: input.preferredMakes,
    rentalDays: lengthDays,
  });

  const matched = parsed.filter((r) => classMatches(r.vehicle_class, input.vehicleClasses));
  const chosen = matched.length ? matched : parsed;

  return chosen.map((r) => ({
    pickup_location: input.pickupLocation,
    dropoff_location: input.dropoffLocation,
    vehicle_class: r.vehicle_class,
    vehicle_examples: r.vehicle_examples,
    make: r.make,
    pickup_at: pickupAt,
    dropoff_at: dropoffAt,
    days: lengthDays,
    rate_type: r.rate_type,
    price_per_day: r.price_per_day,
    total_price: r.total_price,
    currency: r.currency,
    booking_url: r.booking_url,
    raw_text: r.raw_text,
    scanned_at: new Date().toISOString(),
    source: 'sixt',
  }));
}

/** mode: "scan" */
export async function runScan(input) {
  // Session: input.loginSession, else KV SIXT_SESSION, else clear error.
  const session = await loadSession(input);

  const proxyConfiguration = await Actor.createProxyConfiguration(input.proxyConfiguration);
  const launchOptions = {
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  };
  if (proxyConfiguration) launchOptions.proxy = { server: await proxyConfiguration.newUrl() };

  const browser = await chromium.launch(launchOptions);
  const context = await browser.newContext({
    storageState: session,
    locale: 'en-US',
    viewport: { width: 1380, height: 900 },
  });
  const page = await context.newPage();

  let combos = [];
  for (const date of eachDate(input.dateWindowStart, input.dateWindowEnd, input.dateStepDays)) {
    for (const t of input.pickupTimes) {
      for (let len = input.minDays; len <= input.maxDays; len += input.dayStep) {
        combos.push({ pickupDate: date, pickupTime: t, lengthDays: len });
      }
    }
  }

  if (input.testRunOnly) {
    combos = combos.slice(0, 1);
    log.info('testRunOnly is ON — running a single test search first.');
  }
  if (combos.length > input.maxSearches) {
    log.warning(`Capping ${combos.length} combinations to maxSearches=${input.maxSearches}.`);
    combos = combos.slice(0, input.maxSearches);
  }

  const allRows = [];
  let blocked = false;

  try {
    for (let i = 0; i < combos.length; i++) {
      if (i > 0) {
        const wait = randBetween(input.minDelayMs, input.maxDelayMs);
        log.info(`Scanning slowly — waiting ${Math.round(wait / 1000)}s...`);
        await sleep(wait);
      }

      let rows;
      try {
        rows = await runOneSearch(page, input, combos[i]);
      } catch (e) {
        if (e.message.startsWith('__BLOCKED__')) {
          log.error(e.message.replace('__BLOCKED__ ', ''));
          blocked = true;
          break;
        }
        log.warning(`Search failed: ${e.message}`);
        continue;
      }

      if (rows.length) {
        await Actor.pushData(rows);
        allRows.push(...rows);

        if (input.ingestUrl) {
          try {
            const { sent } = await postResults({
              ingestUrl: input.ingestUrl,
              scannerSecret: input.scannerSecret,
              rows,
              scanId: input.scanId ?? input.scan_id ?? null,
              batchSize: input.postBatchSize,
              log,
            });
            log.info(`Posted ${sent} row(s) to ingest endpoint (x-scanner-secret).`);
          } catch (e) {
            log.error(`Ingest POST failed: ${e.message}`);
          }
        }

        log.info(`Extracted ${rows.length} row(s) for this search.`);
      }
    }

    await Actor.setValue('SUMMARY', {
      combinations: combos.length,
      totalRows: allRows.length,
      posted: Boolean(input.ingestUrl),
      blocked,
      finishedAt: new Date().toISOString(),
    });

    log.info(`Done. Total rows: ${allRows.length}.${blocked ? ' (Stopped early due to a challenge.)' : ''}`);
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  return { rows: allRows.length, blocked };
}
