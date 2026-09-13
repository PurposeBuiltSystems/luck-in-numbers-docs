#!/usr/bin/env node
/**
 * Refresh docs/jackpots.json from the official lottery sites.
 *
 * Runs in CI on a daily cron. The app reads the published file as plain static
 * JSON, so the parsing lives here rather than on-device: when a source changes
 * its markup this is a five-minute fix for every user at once, instead of an
 * App Store release that users on older builds would never receive.
 *
 * No dependencies — Node 20 has global fetch.
 *
 * Sources:
 *   Powerball     — no JSON feed, so the homepage is parsed.
 *   Mega Millions — a real JSON feed, wrapped in a SOAP <string> element.
 *   Texas Lottery — lists both games on one page; used as a fallback.
 */

const fs = require('fs');
const path = require('path');

const OUTPUT = path.join(__dirname, '..', 'docs', 'jackpots.json');

const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Both games start at $20M and the all-time record is ~$2.04B. Anything outside
// this band means we parsed the wrong element, not that the jackpot moved.
const MIN_PLAUSIBLE_JACKPOT = 20_000_000;
const MAX_PLAUSIBLE_JACKPOT = 5_000_000_000;

const FETCH_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

/**
 * Fetch text, retrying when the response is unusable.
 *
 * powerball.com answers roughly a third of requests with HTTP 200 and an empty
 * body — measured at 5 usable responses out of 8 consecutive tries, against 8/8
 * for the other two sources. An empty 200 is throttling, not an outage, and
 * should not burn the fallback, so a suspiciously short body is retryable
 * alongside network errors and non-OK statuses.
 */
async function fetchText(url, { minLength = 1000, attempts = 4, accept } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': BROWSER_UA, ...(accept ? { Accept: accept } : {}) },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const text = await res.text();
      if (text.length < minLength) {
        throw new Error(`response too short (${text.length} bytes) — likely throttled`);
      }
      return text;
    } catch (err) {
      lastError = err;
      console.warn(`  ${url} attempt ${attempt}/${attempts}: ${err.message}`);
      if (attempt < attempts) await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
  throw new Error(`${url} failed after ${attempts} attempts: ${lastError.message}`);
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** Parse "$251 Million", "$1.5 Billion", "$251,000,000" or a bare number. */
function parseAmount(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isNaN(value) ? null : value;

  const text = String(value);
  const match = text.match(/([0-9][0-9,]*(?:\.[0-9]+)?)/);
  if (!match) return null;

  let amount = parseFloat(match[1].replace(/,/g, ''));
  if (Number.isNaN(amount)) return null;

  if (/billion/i.test(text)) amount *= 1e9;
  else if (/million/i.test(text)) amount *= 1e6;
  else if (/thousand/i.test(text)) amount *= 1e3;

  return amount;
}

function isPlausible(amount) {
  return (
    typeof amount === 'number' &&
    !Number.isNaN(amount) &&
    amount >= MIN_PLAUSIBLE_JACKPOT &&
    amount <= MAX_PLAUSIBLE_JACKPOT
  );
}

/**
 * Powerball's homepage renders the jackpot and its cash value as two
 * `game-jackpot-number` spans. Anchor each read on its own visible label rather
 * than on span order, so an inserted promo block cannot shift us onto the wrong
 * figure.
 */
function parsePowerballHtml(html) {
  const grab = (label) => {
    const i = html.indexOf(label);
    if (i === -1) return null;
    const m = html.slice(i, i + 600).match(/game-jackpot-number[^>]*>\s*([^<]+?)\s*</);
    return m ? parseAmount(m[1]) : null;
  };
  return { estimatedPrize: grab('Estimated Jackpot'), cashValue: grab('Cash Value') };
}

async function fetchPowerball() {
  return parsePowerballHtml(await fetchText('https://www.powerball.com/', { accept: 'text/html' }));
}

/**
 * `NextPrizePool` is the upcoming drawing, which is what players are playing
 * for. `CurrentPrizePool` is the draw that just happened — reading that by
 * mistake would publish a jackpot that has already been won or rolled.
 */
async function fetchMegaMillions() {
  const body = await fetchText(
    'https://www.megamillions.com/cmspages/utilservice.asmx/GetLatestDrawData',
    { minLength: 200, accept: 'application/json, text/xml' }
  );
  const inner = body
    .replace(/^[\s\S]*?<string[^>]*>/, '')
    .replace(/<\/string>[\s\S]*$/, '')
    .replace(/&quot;/g, '"');

  const jackpot = JSON.parse(inner).Jackpot || {};
  return {
    estimatedPrize: parseAmount(jackpot.NextPrizePool),
    cashValue: parseAmount(jackpot.NextCashValue),
  };
}

/** Texas lists, in order: PB jackpot, PB cash, MM jackpot, MM cash. */
async function fetchTexas() {
  const html = await fetchText(
    'https://www.texaslottery.com/export/sites/lottery/Games/Powerball/index.html'
  );
  const amounts = [...html.matchAll(/\$([0-9,.]+)\s*(Million|Billion)/gi)].map((m) =>
    parseAmount(m[0])
  );
  return {
    powerball: { estimatedPrize: amounts[0], cashValue: amounts[1] },
    megaMillions: { estimatedPrize: amounts[2], cashValue: amounts[3] },
  };
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Resolve one game: official source first, Texas as fallback.
 *
 * `valid` gates publication. The app refuses to display any amount whose status
 * is not a success, so a value we could not refresh must never be labelled as
 * one — that mislabelling is exactly what let a four-month-old jackpot render
 * as current.
 */
async function resolve(game, primary, texasPromise) {
  try {
    const result = await primary();
    if (isPlausible(result.estimatedPrize)) {
      return {
        estimatedPrize: result.estimatedPrize,
        cashValue: isPlausible(result.cashValue) ? result.cashValue : null,
        valid: true,
        source: 'official',
      };
    }
    console.warn(`  ${game}: official source returned implausible data`, result);
  } catch (err) {
    console.error(`  ${game}: official source failed: ${err.message}`);
  }

  try {
    const result = (await texasPromise)[game];
    if (result && isPlausible(result.estimatedPrize)) {
      console.log(`  ${game}: recovered via Texas Lottery fallback`);
      return {
        estimatedPrize: result.estimatedPrize,
        cashValue: isPlausible(result.cashValue) ? result.cashValue : null,
        valid: true,
        source: 'texas fallback',
      };
    }
    console.warn(`  ${game}: Texas fallback returned implausible data`, result);
  } catch (err) {
    console.error(`  ${game}: Texas fallback failed: ${err.message}`);
  }

  return { valid: false, source: 'none' };
}

function readExisting() {
  try {
    return JSON.parse(fs.readFileSync(OUTPUT, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * Build one game's published entry. On failure the previous amount is carried
 * forward but its `lastUpdated` is left untouched and the status records the
 * failure, so the app can tell a stale number from a fresh one.
 */
function entryFor(game, resolved, previous, now) {
  if (resolved.valid) {
    return {
      estimatedPrize: resolved.estimatedPrize,
      cashValue: resolved.cashValue,
      lastUpdated: now,
      status: `success (${resolved.source})`,
    };
  }
  if (previous?.[game]) {
    return { ...previous[game], status: 'failed - kept previous value' };
  }
  return { estimatedPrize: null, cashValue: null, lastUpdated: null, status: 'failed - no data' };
}

async function main() {
  const now = new Date().toISOString();
  const previous = readExisting();

  // One shared Texas request serves as the fallback for both games.
  const texasPromise = fetchTexas();
  texasPromise.catch(() => {}); // handled inside resolve(); avoids an unhandled rejection

  const [powerball, megaMillions] = await Promise.all([
    resolve('powerball', fetchPowerball, texasPromise),
    resolve('megaMillions', fetchMegaMillions, texasPromise),
  ]);

  if (!powerball.valid && !megaMillions.valid) {
    console.error('Every source failed for both games; leaving the published file untouched.');
    process.exit(1);
  }

  const output = {
    fetchedAt: now,
    powerball: entryFor('powerball', powerball, previous, now),
    megaMillions: entryFor('megaMillions', megaMillions, previous, now),
  };

  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, JSON.stringify(output, null, 2) + '\n');

  const describe = (e) =>
    e.estimatedPrize ? `$${e.estimatedPrize.toLocaleString()} [${e.status}]` : e.status;
  console.log(`Powerball:     ${describe(output.powerball)}`);
  console.log(`Mega Millions: ${describe(output.megaMillions)}`);
}

main().catch((err) => {
  console.error('Unrecoverable error:', err);
  process.exit(1);
});
