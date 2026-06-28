/**
 * Defensive extraction. SIXT is a dynamic app whose markup changes, so we find
 * result cards via candidate selectors, pull their visible text + links, then
 * parse fields heuristically. Tune CARD_SELECTORS / parsing if the site shifts.
 */

export const CARD_SELECTORS = [
  '[data-testid*="offer" i]',
  '[data-testid*="vehicle" i]',
  '[data-testid*="rate" i]',
  '[class*="OfferCard" i]',
  '[class*="VehicleCard" i]',
  '[class*="offer-card" i]',
  '[class*="rental-card" i]',
  '[class*="rate-card" i]',
  'article',
];

export async function extractRawCards(page, selectors = CARD_SELECTORS) {
  return await page.evaluate((sels) => {
    const uniq = (arr) => [...new Set(arr)];
    let cards = [];
    for (const sel of sels) {
      const found = Array.from(document.querySelectorAll(sel));
      if (found.length) {
        cards = found;
        break;
      }
    }
    return cards
      .map((el) => ({
        text: (el.innerText || '').trim(),
        links: uniq(Array.from(el.querySelectorAll('a[href]')).map((a) => a.href)),
      }))
      .filter((c) => c.text.length > 0);
  }, selectors);
}

const RATE_KEYWORDS = [
  'pay now', 'pay at desk', 'pay at counter', 'pay at pick-up', 'pay at pickup',
  'free cancellation', 'flexible rate', 'flex rate', 'limited rate',
  'prepay', 'prepaid', 'corporate rate', 'best price',
];

const CATEGORY_WORDS = [
  'Mini', 'Economy', 'Compact', 'Intermediate', 'Standard', 'Full-size',
  'Fullsize', 'Premium', 'Luxury', 'Executive', 'SUV', 'Convertible',
  'Van', 'Estate', 'Wagon', 'Electric', 'Sports',
];

const MAKES = [
  'Range Rover', 'Land Rover', 'Mercedes-Benz', 'Mercedes', 'BMW', 'Audi',
  'Volkswagen', 'Toyota', 'Ford', 'Jeep', 'Nissan', 'Kia', 'Hyundai', 'Volvo',
  'Tesla', 'Mazda', 'Cadillac', 'Chevrolet', 'GMC', 'MINI', 'Cupra', 'Skoda',
  'Peugeot', 'Renault', 'Porsche', 'Genesis', 'Lexus', 'Lincoln', 'Acura',
];

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeCurrency(symbol) {
  const s = (symbol || '').toUpperCase();
  if (s.includes('€')) return 'EUR';
  if (s.includes('£')) return 'GBP';
  return 'USD';
}

function findLabeledAmount(text, amounts, labelRegexes, maxDistance = 60) {
  for (const lr of labelRegexes) {
    const lm = lr.exec(text);
    if (!lm) continue;
    let best = null;
    let bestDist = Infinity;
    for (const a of amounts) {
      const d = Math.abs(a.index - lm.index);
      if (d < bestDist && d <= maxDistance) {
        bestDist = d;
        best = a;
      }
    }
    if (best) return best.num;
  }
  return null;
}

function guessClass(lines, requestedClasses) {
  for (const want of requestedClasses || []) {
    const hit = lines.find((l) => new RegExp(escapeRe(want), 'i').test(l));
    if (hit) return hit.trim();
  }
  const hit = lines.find(
    (l) => l.length <= 40 && CATEGORY_WORDS.some((w) => new RegExp(`\\b${w}\\b`, 'i').test(l))
  );
  return hit ? hit.trim() : null;
}

// Detect make, preferring the user's preferredMakes order, then the general list.
function guessMake(text, preferredMakes) {
  const ordered = [...(preferredMakes || []), ...MAKES];
  for (const mk of ordered) {
    if (new RegExp(`\\b${escapeRe(mk)}\\b`, 'i').test(text)) return mk;
  }
  return null;
}

function collectExamples(lines, preferredMakes) {
  const makeList = [...(preferredMakes || []), ...MAKES];
  const hits = lines.filter(
    (l) =>
      /or similar/i.test(l) ||
      makeList.some((m) => new RegExp(`\\b${escapeRe(m)}\\b`, 'i').test(l))
  );
  const cleaned = hits.map((l) => l.replace(/\s*or similar.*/i, '').trim()).filter(Boolean);
  return [...new Set(cleaned)].slice(0, 4);
}

function pickBookingLink(links) {
  if (!links || !links.length) return null;
  const preferred = links.find((u) => /(offer|booking|checkout|reserve|rate|select)/i.test(u));
  return preferred || links[0];
}

/**
 * @param {Array<{text:string, links:string[]}>} rawCards
 * @param {{vehicleClasses:string[], preferredMakes:string[], rentalDays:number}} ctx
 */
export function parseCards(rawCards, ctx) {
  const out = [];

  for (const card of rawCards) {
    const text = card.text;
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);

    const amounts = [];
    const re = /(US\$|USD|\$|€|£)\s?([0-9][0-9.,]*)/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const num = parseFloat(m[2].replace(/,/g, ''));
      if (!Number.isNaN(num)) amounts.push({ symbol: m[1], num, index: m.index });
    }
    if (amounts.length === 0) continue;

    const currency = normalizeCurrency(amounts[0].symbol);

    let pricePerDay = findLabeledAmount(text, amounts, [/\/\s*day/i, /per day/i, /a day/i]);
    let totalPrice = findLabeledAmount(text, amounts, [/total/i, /est\.?\s*total/i]);

    const nums = amounts.map((a) => a.num);
    if (totalPrice == null) totalPrice = Math.max(...nums);
    if (pricePerDay == null && totalPrice != null && ctx.rentalDays) {
      pricePerDay = Math.round((totalPrice / ctx.rentalDays) * 100) / 100;
    }

    const vehicleClass = guessClass(lines, ctx.vehicleClasses);
    const vehicleExamples = collectExamples(lines, ctx.preferredMakes);
    const make = guessMake(text, ctx.preferredMakes);

    const lower = text.toLowerCase();
    const rateMatches = [...new Set(RATE_KEYWORDS.filter((k) => lower.includes(k)))];
    const rateType = rateMatches.length ? rateMatches.join(', ') : null;

    out.push({
      vehicle_class: vehicleClass,
      vehicle_examples: vehicleExamples,
      make,
      rate_type: rateType,
      price_per_day: pricePerDay ?? null,
      total_price: totalPrice ?? null,
      currency,
      booking_url: pickBookingLink(card.links),
      raw_text: text.slice(0, 2000),
    });
  }

  return out;
}

export function classMatches(classText, requested) {
  if (!classText) return false;
  return (requested || []).some((w) => new RegExp(escapeRe(w), 'i').test(classText));
}
