# SIXT Deal Finder — Apify Actor for v0/Supabase

This is the cloud scanner part. It runs on **Apify**, opens SIXT with Playwright, uses your saved corporate session, reads visible rental offers, and can send the results back to your **v0 app**.

## Simple setup

Use only:

1. **v0** = app/dashboard + Supabase
2. **Apify** = cloud scanner
3. Optional: **Google Sheets** = backup export

## What this actor does

- Opens SIXT in a cloud browser.
- Uses a saved logged-in SIXT session/cookies.
- Scans a test search first: LAX → LAX, 10:00 → 10:00, 5 days, SUV categories.
- Extracts visible offer cards: category, example vehicle, price/day, total, rate type, booking link.
- Saves results to the Apify dataset.
- Optionally POSTs results to your v0 endpoint: `/api/ingest-deals`.
- Optionally appends rows to Google Sheets.

## Important truth about login

This scanner should **not** store your SIXT password and should **not** bypass CAPTCHA/2FA.

For the first version, you need a saved Playwright `storageState` session. The included helper captures cookies after you log in manually:

```bash
npm install
npx playwright install chromium
npm run capture-session
```

That creates `sixt-session.json`. Paste that JSON into the Apify input field `loginSession`, or store it in Apify Key-Value Store as `SIXT_SESSION`.

If you do not want to use your Mac even once for session capture, ask Claude/v0 to add a separate Apify “session capture” mode using Apify browser/live view. The current zip from Claude still assumes local session capture.

## Correct Apify folder structure

This fixed zip uses the required folder structure:

```text
src/main.js
src/lib/extract.js
src/lib/sheets.js
tools/capture-session.js
.actor/actor.json
.actor/input_schema.json
Dockerfile
package.json
```

## v0 connection

In the Apify input, set:

```json
{
  "ingestUrl": "https://YOUR-V0-APP.vercel.app/api/ingest-deals",
  "scannerSecret": "YOUR_SECRET"
}
```

Your v0 app must have this endpoint:

```text
POST /api/ingest-deals
Header: x-scanner-secret: YOUR_SECRET
Body: { "deals": [...] }
```

The actor maps its output to the v0 deal fields:

```text
pickup_location
dropoff_location
vehicle_class
vehicle_examples
pickup_at
dropoff_at
days
rate_type
price_per_day
total_price
currency
booking_url
deal_score
raw
```

## First run settings

Keep these defaults first:

```text
testRunOnly: true
pickupCode: LAX
dropoffCode: LAX
minDays: 5
maxDays: 27
pickupTime: 10:00
dropoffTime: 10:00
```

After it works, change:

```text
testRunOnly: false
```

## Strong recommendation

Use a `searchUrlTemplate` if possible. Do one normal SIXT search in your browser, copy the results URL, and replace the changing parts with:

```text
{pickup}
{dropoff}
{pickupDate}
{dropoffDate}
{pickupTime}
{dropoffTime}
```

Without that, form filling is best-effort and may need tuning.

## Safety rules

- No password storage.
- No CAPTCHA bypass.
- No auto-booking.
- If the actor lands on checkout/payment, it stops.
- Scan slowly.
