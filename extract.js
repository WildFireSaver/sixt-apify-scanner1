/**
 * Defensive extraction: SIXT is a dynamic app whose markup changes, so we find
 * result cards via candidate selectors, pull their visible text + links, and
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
  'pay now',
  'pay at desk',
  'pay at counter',
  'pay at pick-up',
  'pay at pickup',
  'free cancellation',
  'flexible rate',
  'flex rate',
  'limited rate',
  'prepay',
  'prepaid',
  'corporate rate',
  'best price',
];

const CATEGORY_WORDS = [
  'Mini', 'Economy', 'Compact', 'Intermediate', 'Standard', 'Full-size',
  'Fullsize', 'Premium', 'Luxury', 'Executive', 'SUV', 'Convertible',
  'Van', 'Estate', 'Wagon', 'Electric', 'Sports',
];

const MAKES = [
  'BMW', 'Mercedes', 'Audi', 'Volkswagen', 'Toyota', 'Ford', 'Jeep',
  'Nissan', 'Kia', 'Hyundai', 'Volvo', 'Tesla', 'Mazda', 'Range Rover',
  'Land Rover', 'Cadillac', 'Chevrolet', 'GMC', 'MINI', 'Cupra', 'Skoda',
  'Peugeot', 'Renault', 'Porsche', 'Genesis', 'Lexus',
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

function guessCategory(lines, requestedCategories) {
  for (const want of requestedCategories || []) {
    const hit = lines.find((l) => new RegExp(escapeRe(want), 'i').test(l));
    if (hit) return hit.trim();
  }
  const hit = lines.find(
    (l) => l.length <= 40 && CATEGORY_WORDS.some((w) => new RegExp(`\\b${w}\\b`, 'i').test(l))
  );
  return hit ? hit.trim() : null;
}

function guessModel(lines) {
  const hit = lines.find((l) => MAKES.some((m) => new RegExp(`\\b${escapeRe(m)}\\b`, 'i').test(l)));
  return hit ? hit.trim() : null;
}

function pickBookingLink(links) {
  if (!links || !links.length) return null;
  const preferred = links.find((u) => /(offer|booking|checkout|reserve|rate|select)/i.test(u));
  return preferred || links[0];
}

/**
 * @param {Array<{text:string, links:string[]}>} rawCards
 * @param {{categories:string[], rentalDays:number}} ctx
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

    let dailyPrice = findLabeledAmount(text, amounts, [/\/\s*day/i, /per day/i, /a day/i]);
    let totalPrice = findLabeledAmount(text, amounts, [/total/i, /est\.?\s*total/i]);

    const nums = amounts.map((a) => a.num);
    if (totalPrice == null) totalPrice = Math.max(...nums);
    if (dailyPrice == null && totalPrice != null && ctx.rentalDays) {
      dailyPrice = Math.round((totalPrice / ctx.rentalDays) * 100) / 100;
    }

    const category = guessCategory(lines, ctx.categories);

    let example = lines.find((l) => /or similar/i.test(l)) || guessModel(lines);
    if (example) example = example.replace(/\s*or similar.*/i, '').trim();

    const lower = text.toLowerCase();
    const rateMatches = [...new Set(RATE_KEYWORDS.filter((k) => lower.includes(k)))];
    const rateType = rateMatches.length ? rateMatches.join(', ') : null;

    out.push({
      vehicle_category: category,
      example_vehicle: example || null,
      rate_type: rateType,
      total_price: totalPrice ?? null,
      daily_price: dailyPrice ?? null,
      currency,
      booking_url: pickBookingLink(card.links),
      raw_text: text.slice(0, 2000),
    });
  }

  return out;
}

/** True if the category text matches any requested category (case-insensitive). */
export function categoryMatches(categoryText, requested) {
  if (!categoryText) return false;
  return (requested || []).some((w) => new RegExp(escapeRe(w), 'i').test(categoryText));
}
