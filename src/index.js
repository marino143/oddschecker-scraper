require('dotenv').config();
const express = require('express');
const cors = require('cors');
const NodeCache = require('node-cache');
const { scrapeSport: scrapeFreshBet } = require('./freshbet');
const { scrapeSport: scrapeGoldenBet } = require('./goldenbet');

const app = express();
const cache = new NodeCache({ stdTTL: 60 });

const ALLOWED_ORIGINS = [
  'https://oddschecker2.netlify.app',
  'http://localhost:3000',
  'http://localhost:5173',
  ...(process.env.FRONTEND_URL ? [process.env.FRONTEND_URL] : []),
];

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error(`CORS blocked: ${origin}`));
  },
}));
app.use(express.json());

// ─── Health ───────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    sources: { freshbet: true, goldenbet: true },
    uptime: Math.round(process.uptime()),
    cached: {
      'freshbet-football':   !!cache.get('freshbet-football'),
      'freshbet-tennis':     !!cache.get('freshbet-tennis'),
      'freshbet-basketball': !!cache.get('freshbet-basketball'),
      'goldenbet-football':  !!cache.get('goldenbet-football'),
    },
    timestamp: new Date().toISOString(),
  });
});

// ─── Helper to serve odds from a bookmaker ────────────────────────
function oddsHandler(bookmaker, scrapeFn) {
  return async (req, res) => {
    const sport = req.params.sport || 'football';
    const cacheKey = `${bookmaker}-${sport}`;
    try {
      const cached = cache.get(cacheKey);
      if (cached) return res.json({ source: 'cache', bookmaker, data: cached, count: cached.length });

      const matches = await scrapeFn(sport);
      if (matches.length > 0) cache.set(cacheKey, matches);

      res.json({ source: 'live', bookmaker, data: matches, count: matches.length, scrapedAt: new Date().toISOString() });
    } catch (err) {
      console.error(`[API] /${bookmaker}/${sport} error:`, err.message);
      res.status(500).json({ error: err.message, data: [] });
    }
  };
}

// ─── GET /odds/:sport — returns both FreshBet + GoldenBet merged ──
app.get('/odds/:sport', async (req, res) => {
  const { sport } = req.params;
  try {
    const fbCached = cache.get(`freshbet-${sport}`);
    const gbCached = cache.get(`goldenbet-${sport}`);

    // If both cached, merge and return
    if (fbCached && gbCached) {
      return res.json({
        source: 'cache',
        bookmakers: ['freshbet', 'goldenbet'],
        data: [...fbCached, ...gbCached],
        count: fbCached.length + gbCached.length,
      });
    }

    // Fetch both in parallel
    const [fbMatches, gbMatches] = await Promise.all([
      fbCached ? Promise.resolve(fbCached) : scrapeFreshBet(sport),
      gbCached ? Promise.resolve(gbCached) : scrapeGoldenBet(sport),
    ]);

    if (fbMatches.length > 0) cache.set(`freshbet-${sport}`, fbMatches);
    if (gbMatches.length > 0) cache.set(`goldenbet-${sport}`, gbMatches);

    res.json({
      source: 'live',
      bookmakers: ['freshbet', 'goldenbet'],
      data: [...fbMatches, ...gbMatches],
      count: fbMatches.length + gbMatches.length,
      scrapedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error(`[API] /odds/${sport} error:`, err.message);
    res.status(500).json({ error: err.message, data: [] });
  }
});

// ─── GET /freshbet/:sport — explicit FreshBet endpoint ────────────
app.get('/freshbet/:sport', oddsHandler('freshbet', scrapeFreshBet));

// ─── GET /goldenbet/:sport — explicit GoldenBet endpoint ──────────
app.get('/goldenbet/:sport', oddsHandler('goldenbet', scrapeGoldenBet));

// ─── Background scrape every SCRAPE_INTERVAL_MS ───────────────────
const SPORTS   = ['football', 'basketball', 'tennis'];
const INTERVAL = parseInt(process.env.SCRAPE_INTERVAL_MS || '60000');

async function backgroundScrape() {
  console.log('[Background] Starting scrape cycle...');
  for (const sport of SPORTS) {
    // FreshBet
    try {
      const matches = await scrapeFreshBet(sport);
      if (matches.length > 0) {
        cache.set(`freshbet-${sport}`, matches);
        console.log(`[Background] freshbet ${sport}: ${matches.length} matches cached`);
      }
    } catch (err) {
      console.error(`[Background] freshbet ${sport} error:`, err.message);
    }
    await new Promise(r => setTimeout(r, 500));

    // GoldenBet
    try {
      const matches = await scrapeGoldenBet(sport);
      if (matches.length > 0) {
        cache.set(`goldenbet-${sport}`, matches);
        console.log(`[Background] goldenbet ${sport}: ${matches.length} matches cached`);
      }
    } catch (err) {
      console.error(`[Background] goldenbet ${sport} error:`, err.message);
    }
    await new Promise(r => setTimeout(r, 500));
  }
}

setInterval(backgroundScrape, INTERVAL);
setTimeout(backgroundScrape, 2000);

// ─── Start ────────────────────────────────────────────────────────
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`\n🚀 OddsChecker Scraper running on port ${PORT}`);
  console.log(`   Sources: FreshBet (ID 52) + GoldenBet (ID 73)`);
  console.log(`   Scrape interval: ${INTERVAL / 1000}s`);
  console.log(`\n   GET /health              — status`);
  console.log(`   GET /odds/:sport         — merged FreshBet + GoldenBet odds`);
  console.log(`   GET /freshbet/:sport     — FreshBet only`);
  console.log(`   GET /goldenbet/:sport    — GoldenBet only\n`);
});

process.on('SIGTERM', async () => { process.exit(0); });
process.on('SIGINT',  async () => { process.exit(0); });
