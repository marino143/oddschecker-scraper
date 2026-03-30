require('dotenv').config();
const express = require('express');
const cors = require('cors');
const NodeCache = require('node-cache');
const { scrapeSport: scrapeGoldenBet, discoverApiEndpoints } = require('./scraper');
const { scrapeSport: scrapeFreshBet, scrapeAll: scrapeAllFreshBet } = require('./freshbet');

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
    sources: {
      freshbet: true,
      goldenbet: !!process.env.ZENROWS_API_KEY,
    },
    uptime: Math.round(process.uptime()),
    cached: {
      football:   !!cache.get('freshbet-football'),
      tennis:     !!cache.get('freshbet-tennis'),
      basketball: !!cache.get('freshbet-basketball'),
    },
    timestamp: new Date().toISOString(),
  });
});

// ─── GET /odds/:sport — FreshBet (primary source) ─────────────────
app.get('/odds/:sport', async (req, res) => {
  const { sport } = req.params;
  const cacheKey = `freshbet-${sport}`;
  try {
    const cached = cache.get(cacheKey);
    if (cached) return res.json({ source: 'cache', bookmaker: 'freshbet', data: cached, count: cached.length });

    const matches = await scrapeFreshBet(sport);
    if (matches.length > 0) cache.set(cacheKey, matches);

    res.json({ source: 'live', bookmaker: 'freshbet', data: matches, count: matches.length, scrapedAt: new Date().toISOString() });
  } catch (err) {
    console.error(`[API] /odds/${sport} error:`, err.message);
    res.status(500).json({ error: err.message, data: [] });
  }
});

// ─── GET /odds/football shorthand ─────────────────────────────────
app.get('/odds/football', async (req, res) => {
  const cacheKey = 'freshbet-football';
  try {
    const cached = cache.get(cacheKey);
    if (cached) return res.json({ source: 'cache', bookmaker: 'freshbet', data: cached, count: cached.length });

    const matches = await scrapeFreshBet('football');
    if (matches.length > 0) cache.set(cacheKey, matches);

    res.json({ source: 'live', bookmaker: 'freshbet', data: matches, count: matches.length, scrapedAt: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message, data: [] });
  }
});

// ─── GET /freshbet/:sport — explicit FreshBet endpoint ────────────
app.get('/freshbet/:sport', async (req, res) => {
  const { sport } = req.params;
  const cacheKey = `freshbet-${sport}`;
  try {
    const cached = cache.get(cacheKey);
    if (cached) return res.json({ source: 'cache', bookmaker: 'freshbet', data: cached, count: cached.length });

    const matches = await scrapeFreshBet(sport);
    if (matches.length > 0) cache.set(cacheKey, matches);

    res.json({ source: 'live', bookmaker: 'freshbet', data: matches, count: matches.length, scrapedAt: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message, data: [] });
  }
});

// ─── GET /discover — GoldenBet API discovery ──────────────────────
app.get('/discover', async (req, res) => {
  try {
    const result = await discoverApiEndpoints();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Background scrape every SCRAPE_INTERVAL_MS ───────────────────
const SPORTS   = ['football', 'basketball', 'tennis'];
const INTERVAL = parseInt(process.env.SCRAPE_INTERVAL_MS || '60000');

async function backgroundScrape() {
  console.log('[Background] Starting scrape cycle...');
  for (const sport of SPORTS) {
    try {
      const matches = await scrapeFreshBet(sport);
      if (matches.length > 0) {
        cache.set(`freshbet-${sport}`, matches);
        console.log(`[Background] freshbet ${sport}: ${matches.length} matches cached`);
      } else {
        console.warn(`[Background] freshbet ${sport}: 0 matches`);
      }
    } catch (err) {
      console.error(`[Background] ${sport} error:`, err.message);
    }
    await new Promise(r => setTimeout(r, 800));
  }
}

setInterval(backgroundScrape, INTERVAL);
setTimeout(backgroundScrape, 2000); // initial scrape 2s after start

// ─── Start ────────────────────────────────────────────────────────
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`\n🚀 OddsChecker Scraper running on port ${PORT}`);
  console.log(`   Primary source: FreshBet (analytics-sp.googleserv.tech)`);
  console.log(`   Scrape interval: ${INTERVAL / 1000}s`);
  console.log(`\n   GET /health              — status`);
  console.log(`   GET /odds/football       — football odds (FreshBet)`);
  console.log(`   GET /odds/tennis         — tennis odds (FreshBet)`);
  console.log(`   GET /odds/basketball     — basketball odds (FreshBet)`);
  console.log(`   GET /freshbet/:sport     — explicit FreshBet endpoint`);
  console.log(`   GET /discover            — discover GoldenBet API endpoints\n`);
});

process.on('SIGTERM', async () => { process.exit(0); });
process.on('SIGINT',  async () => { process.exit(0); });
