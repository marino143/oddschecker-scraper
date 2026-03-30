// Playwright lazy-loaded — only needed if ZENROWS_BROWSER_WSS is set
let chromium = null;
function getChromium() {
  if (!chromium) chromium = require('playwright').chromium;
  return chromium;
}
const cheerio = require('cheerio');

// GoldenBet URL patterns to try (in order)
const GOLDENBET_URL_CANDIDATES = [
  'https://goldenbet.com/eng/sport/football',
  'https://www.goldenbet.com/eng/sport/football',
];

const SPORT_PATHS = {
  football:   '/eng/sport/football',
  tennis:     '/eng/sport/tennis',
  basketball: '/eng/sport/basketball',
};

// ─── ZenRows Scraping Browser (best method) ───────────────────────
async function scrapeViaBrowser(sportPath) {
  const wss = process.env.ZENROWS_BROWSER_WSS;
  if (!wss) throw new Error('ZENROWS_BROWSER_WSS not set in .env');

  const url = `https://goldenbet.com${sportPath}`;
  console.log(`[ScrapingBrowser] Connecting to ZenRows browser...`);

  const browser = await getChromium().connectOverCDP(wss);
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    console.log(`[ScrapingBrowser] Navigating to ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // Wait for page to fully load JS content
    await page.waitForTimeout(4000);

    // Check if Cloudflare blocked us
    const title = await page.title();
    console.log(`[ScrapingBrowser] Page title: "${title}"`);

    if (title.toLowerCase().includes('cloudflare') || title.toLowerCase().includes('attention')) {
      throw new Error('Cloudflare block detected even via Scraping Browser');
    }

    // Take screenshot for debugging
    if (process.env.DEBUG_SCRAPER) {
      await page.screenshot({ path: 'debug-goldenbet.png', fullPage: true });
      console.log('[ScrapingBrowser] Screenshot saved: debug-goldenbet.png');
    }

    // Try to find what URL we actually ended up on (redirects)
    const finalUrl = page.url();
    console.log(`[ScrapingBrowser] Final URL: ${finalUrl}`);

    // Wait for odds elements to appear
    await page.waitForSelector(
      '[class*="event"], [class*="match"], [class*="sport"], [class*="odd"]',
      { timeout: 10000 }
    ).catch(() => console.warn('[ScrapingBrowser] No event selector found — trying anyway'));

    // Get all visible text to understand page structure
    if (process.env.DEBUG_SCRAPER) {
      const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 2000));
      console.log('[ScrapingBrowser] Body text snippet:\n', bodyText);
    }

    // Get available CSS classes to understand DOM structure
    const classes = await page.evaluate(() => {
      const els = document.querySelectorAll('[class]');
      const classSet = new Set();
      els.forEach(el => {
        el.className.toString().split(' ').forEach(c => {
          if (c.length > 3 && c.length < 40) classSet.add(c);
        });
      });
      return [...classSet].slice(0, 50);
    });
    console.log('[ScrapingBrowser] Available classes:', classes.join(', '));

    const html = await page.content();
    await context.close();
    await browser.close();

    return parseGoldenBetHtml(html, sportPath.includes('football') ? 'football' : sportPath.split('/').pop());

  } catch (err) {
    console.error('[ScrapingBrowser] Error:', err.message);
    try { await context.close(); } catch (e) {}
    try { await browser.close(); } catch (e) {}
    throw err;
  }
}

// ─── ZenRows Universal API fallback ──────────────────────────────
async function fetchViaZenRowsAPI(url) {
  const apiKey = process.env.ZENROWS_API_KEY;
  if (!apiKey) throw new Error('ZENROWS_API_KEY not set');

  const params = new URLSearchParams({
    apikey: apiKey,
    url,
    js_render: 'true',
    wait: '4000',
    premium_proxy: 'true',
    proxy_country: 'gb',    // UK proxy — GoldenBet serves different content by region
  });

  console.log(`[ZenRowsAPI] Fetching: ${url}`);
  const res = await fetch(`https://api.zenrows.com/v1/?${params}`, {
    signal: AbortSignal.timeout(60000),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`ZenRows API ${res.status}: ${err.slice(0, 300)}`);
  }

  return await res.text();
}

// ─── Parse GoldenBet HTML ─────────────────────────────────────────
function parseGoldenBetHtml(html, sport) {
  const $ = cheerio.load(html);
  const matches = [];

  // Log all unique first-level class names for debugging
  const allClasses = new Set();
  $('[class]').each((i, el) => {
    const cls = $(el).attr('class') || '';
    cls.split(' ').filter(c => c.length > 2).forEach(c => allClasses.add(c.split('_')[0]));
  });
  if (process.env.DEBUG_SCRAPER) {
    console.log('[Parser] DOM classes found:', [...allClasses].slice(0, 30).join(', '));
  }

  // Try multiple selector strategies
  const selectorGroups = [
    // Strategy 1: data attributes
    '[data-event-id]',
    '[data-match-id]',
    '[data-testid*="event"]',
    // Strategy 2: common class patterns
    '[class*="EventRow"]',
    '[class*="event-row"]',
    '[class*="match-row"]',
    '[class*="SportEvent"]',
    '[class*="sport-event"]',
    '[class*="EventItem"]',
    '[class*="event-item"]',
    '[class*="MatchCard"]',
    '[class*="match-card"]',
  ];

  let eventRows = $();
  let usedSelector = '';
  for (const sel of selectorGroups) {
    const found = $(sel);
    if (found.length > 0) {
      eventRows = found;
      usedSelector = sel;
      console.log(`[Parser] Found ${found.length} events with: ${sel}`);
      break;
    }
  }

  if (eventRows.length === 0) {
    console.warn('[Parser] No events found. Page may need different selectors.');
    console.warn('[Parser] Total elements on page:', $('*').length);
    return [];
  }

  eventRows.each((i, row) => {
    try {
      const $row = $(row);

      // Find team/participant names
      const teamSelectors = [
        '[class*="team"]', '[class*="Team"]',
        '[class*="participant"]', '[class*="Participant"]',
        '[class*="competitor"]', '[class*="Competitor"]',
        '[class*="player"]', '[class*="Player"]',
      ];
      let homeTeam = '', awayTeam = '';
      for (const sel of teamSelectors) {
        const found = $row.find(sel);
        if (found.length >= 2) {
          homeTeam = found.eq(0).text().trim();
          awayTeam = found.eq(1).text().trim();
          break;
        }
      }
      if (!homeTeam || !awayTeam) return;

      // Find odds values
      const oddsSelectors = [
        '[class*="odd"]', '[class*="Odd"]',
        '[class*="price"]', '[class*="Price"]',
        '[class*="coef"]', '[class*="Coef"]',
        '[class*="coefficient"]',
        'button[class*="bet"]',
      ];
      let oddsValues = [];
      for (const sel of oddsSelectors) {
        $row.find(sel).each((j, el) => {
          const val = parseFloat($(el).text().trim().replace(',', '.'));
          if (!isNaN(val) && val > 1.01 && val < 999) oddsValues.push(val);
        });
        if (oddsValues.length >= 2) break;
      }
      if (oddsValues.length < 2) return;

      // Time/status
      const timeEl = $row.find('[class*="time"], [class*="Time"], [class*="date"], [class*="Date"], [class*="status"]').first();
      const time = timeEl.text().trim();
      const isLive = $row.text().toLowerCase().includes('live') ||
                     $row.find('[class*="live"], [class*="Live"]').length > 0;

      // League
      const leagueEl = $row.closest('[class*="league"], [class*="League"], [class*="competition"], [class*="Competition"]')
        .find('[class*="name"], [class*="title"]').first();
      const league = leagueEl.text().trim() || 'Football';

      matches.push({
        id: `gb-${sport}-${i}-${Date.now()}`,
        source: 'goldenbet',
        sport,
        league,
        homeTeam,
        awayTeam,
        time,
        isLive,
        odds: {
          home: oddsValues[0],
          draw: oddsValues.length >= 3 ? oddsValues[1] : null,
          away: oddsValues[oddsValues.length >= 3 ? 2 : 1],
        },
        scrapedAt: new Date().toISOString(),
      });
    } catch (e) { /* skip malformed rows */ }
  });

  console.log(`[Parser] Extracted ${matches.length} matches`);
  return matches;
}

// ─── Main public API ──────────────────────────────────────────────
async function scrapeFootball() {
  return await scrapeSport('football');
}

async function scrapeSport(sport) {
  const path = SPORT_PATHS[sport] || `/en/sport/${sport}`;

  // 1. Try ZenRows Scraping Browser first (best Cloudflare bypass)
  if (process.env.ZENROWS_BROWSER_WSS) {
    try {
      const results = await scrapeViaBrowser(path);
      if (results.length > 0) return results;
      console.warn('[scrapeSport] Browser returned 0 results, trying API fallback...');
    } catch (err) {
      console.error('[scrapeSport] Browser error:', err.message, '— trying API...');
    }
  }

  // 2. Try ZenRows Universal API
  if (process.env.ZENROWS_API_KEY) {
    for (const baseUrl of ['https://goldenbet.com']) {
      try {
        const html = await fetchViaZenRowsAPI(`${baseUrl}${path}`);
        const results = parseGoldenBetHtml(html, sport);
        if (results.length > 0) return results;
      } catch (err) {
        console.error(`[ZenRowsAPI] ${baseUrl}${path} failed:`, err.message);
      }
    }
  }

  console.warn('[scrapeSport] All methods failed — no data available');
  return [];
}

async function discoverApiEndpoints() {
  const wss = process.env.ZENROWS_BROWSER_WSS;
  if (!wss) return { error: 'ZENROWS_BROWSER_WSS not configured' };

  const browser = await getChromium().connectOverCDP(wss);
  const context = await browser.newContext();
  const page = await context.newPage();
  const apiCalls = [];

  // Intercept all XHR/fetch calls
  await page.route('**/*', async (route) => {
    const req = route.request();
    const url = req.url();
    const type = req.resourceType();
    if (['xhr', 'fetch'].includes(type)) {
      apiCalls.push({ url, method: req.method(), type });
      console.log(`[Network] ${req.method()} ${url}`);
    }
    await route.continue();
  });

  try {
    await page.goto('https://goldenbet.com/en/sport/football', {
      waitUntil: 'networkidle', timeout: 30000,
    });
    await page.waitForTimeout(5000);
  } catch (e) {}

  await context.close();
  await browser.close();

  return { apiCalls, count: apiCalls.length };
}

module.exports = { scrapeFootball, scrapeSport, discoverApiEndpoints };
