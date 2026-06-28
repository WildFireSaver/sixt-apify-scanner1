# SIXT Deal Scanner — Apify Actor (private) · v0.2

Two modes, both running **entirely in Apify** — no local Mac step needed:

- **`save-session`** — opens SIXT in a real browser inside the run and exposes
  it interactively through **Live View** so you log in by hand. After the time
  window, it saves your session cookies to the Key-Value Store key
  **`SIXT_SESSION`**.
- **`scan`** — loads that session, scans the requested rates, saves to the
  dataset, and POSTs to your v0 ingest endpoint.

### Guardrails (enforced in code)
- **No password** — you log in yourself; the actor only keeps the session cookies.
- **No CAPTCHA / 2FA bypass** — you complete any challenge during `save-session`;
  during `scan`, if a challenge appears the actor saves a screenshot and **stops**.
- **No auto-booking** — only listings are read; a checkout-URL guard aborts.
- **Slow & private** — randomized delays between searches; optional Live View
  password.

---

## Mode 1 — `save-session` (interactive login, in cloud)

How it works: the run starts a headful Chromium on a virtual display, served to
you over **noVNC** on the container's web port. You drive it from the Apify
console.

Steps:
1. Run the actor with input `{ "mode": "save-session", "liveViewMinutes": 10 }`
   (optionally set `liveViewPassword`).
2. Open the run's **Live View** tab in the Apify console (the log also prints a
   direct `…/vnc.html` URL). If you set a password, noVNC will prompt for it.
3. Log into your SIXT corporate account by hand — including 2FA/CAPTCHA.
4. Stay logged in. When the window elapses, the actor writes `SIXT_SESSION` to
   the Key-Value Store and reports success (cookie count).

Run settings: give this run a **timeout ≥ `liveViewMinutes`·60 + 120s** and
**≥ 4096 MB** memory (headful Chromium + VNC).

Your password is never read or stored by the actor.

---

## Mode 2 — `scan`

Session resolution order:
1. `loginSession` from input, if provided.
2. Otherwise the saved `SIXT_SESSION` from the Key-Value Store.
3. If neither exists → the run fails with: **“Run mode save-session first.”**

Then it runs the sweep (pickup dates × pickup times × rental lengths), writes
each batch to the **dataset**, and **POSTs** to `ingestUrl` with header
**`x-scanner-secret`** (the secret is also mirrored in the JSON body). POSTs
retry up to 3× with backoff.

Example input:
```json
{
  "mode": "scan",
  "pickupLocation": "LAX",
  "dropoffLocation": "LAX",
  "preferredMakes": ["BMW", "Mercedes", "Range Rover", "Audi"],
  "vehicleClasses": ["Premium SUV", "Luxury SUV", "Executive SUV"],
  "minDays": 5,
  "maxDays": 27,
  "pickupTimes": ["10:00"],
  "dateWindowStart": "2026-07-01",
  "dateWindowEnd": "2026-07-31",
  "ingestUrl": "https://MY-V0-APP.com/api/ingest-deals",
  "scannerSecret": "MY_SECRET",
  "testRunOnly": true
}
```

> The full July × 5–27-day sweep is large, so `testRunOnly` defaults to **true**
> (one search, then stop). Set it to `false` and tune `dateStepDays` / `dayStep`
> / `maxSearches` for the full run.

### Reliable headless searches
For cloud reliability, prefer a **`searchUrlTemplate`** (a SIXT results URL with
the tokens `{pickup} {dropoff} {pickupDate} {dropoffDate} {pickupTime}
{dropoffTime}`; dates `YYYY-MM-DD`, times `HH:mm`). A residential proxy is
recommended either way.

---

## Output fields

`pickup_location, dropoff_location, vehicle_class, vehicle_examples, make,
pickup_at, dropoff_at, days, rate_type, price_per_day, total_price, currency,
booking_url, raw_text, scanned_at, source`

(written to the Apify dataset and posted to `ingestUrl`).

---

## Files

| File                     | Purpose                                         |
| ------------------------ | ----------------------------------------------- |
| `src/main.js`            | Dispatches by `mode`                            |
| `src/save_session.js`    | Interactive in-cloud login (Xvfb + x11vnc + noVNC) |
| `src/scan.js`            | Scan: search, dataset, ingest POST              |
| `src/lib/session.js`     | Defaults + session load (input → KV → error)    |
| `src/lib/extract.js`     | Card scraping + field/make parsing              |
| `src/lib/ingest.js`      | Batched POST with `x-scanner-secret`            |
| `tools/capture-session.js` | Optional legacy local capture (no longer required) |
| `.actor/*`, `Dockerfile` | Actor config + build (adds VNC packages)        |

## Notes
- Sessions expire — re-run `save-session` when `scan` comes back logged-out
  (it will report a challenge / no results).
- Keep volume modest and within SIXT's terms; this is for your own corporate
  rates. The delays support that.
- Parsing is heuristic (regex over visible card text), tuned for the US site and
  `$`/USD. If extraction misses cards, open the `no-results-*` HTML in the
  Key-Value Store and add the real card selector to the top of `CARD_SELECTORS`
  in `src/lib/extract.js`.
