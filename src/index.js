require('dotenv').config();
const express = require('express');
const cors = require('cors');
const NodeCache = require('node-cache');
const { scrapeSport: scrapeFreshBet } = require('./freshbet');
const { scrapeSport: scrapeGoldenBet } = require('./goldenbet');
const { scrapeSport: scrapeOddsAPI, BM_NAMES } = require('./theoddsapi');

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

const HAS_ODDS_API = !!process.env.ODDS_API_KEY;

// ─── Health ───────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    sources: {
      freshbet:  true,
      goldenbet: true,
      theoddsapi: HAS_ODDS_API,
    },
    uptime: Math.round(process.uptime()),
    cached: {
      'football':   !!cache.get('odds-football'),
      'basketball': !!cache.get('odds-basketball'),
      'tennis':     !!cache.get('odds-tennis'),
    },
    timestamp: new Date().toISOString(),
  });
});

// ─── GET /bookmakers — list all supported bookmakers ──────────────
app.get('/bookmakers', (req, res) => {
  res.json({ bookmakers: BM_NAMES });
});

// ─── Helpers for merging FreshBet/GoldenBet odds into OddsAPI matches ──
function normName(s) { return (s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

function fuzzyMatch(a, b) {
  const na = normName(a), nb = normName(b);
  return na === nb || na.includes(nb) || nb.includes(na);
}

function findFbMatch(fbList, homeTeam, awayTeam) {
  return fbList.find(m =>
    fuzzyMatch(m.homeTeam, homeTeam) && fuzzyMatch(m.awayTeam, awayTeam)
  ) || null;
}

function decimalToOddsValue(decimal) {
  if (!decimal || decimal <= 1) return null;
  const num = Math.round((decimal - 1) * 100);
  const denom = 100;
  const g = (function gcd(a, b) { return b === 0 ? a : gcd(b, a % b); })(Math.abs(num), denom);
  return {
    decimal,
    fractional: `${num / g}/${denom / g}`,
    american:   decimal >= 2 ? `+${Math.round((decimal - 1) * 100)}` : `-${Math.round(100 / (decimal - 1))}`,
    isBest: false,
  };
}

function injectFbOdds(apiMatches, fbMatches, gbMatches) {
  return apiMatches.map(match => {
    const fb = findFbMatch(fbMatches, match.homeTeam, match.awayTeam);
    const gb = findFbMatch(gbMatches, match.homeTeam, match.awayTeam);
    if (!fb && !gb) return match;

    const selections = match.selections.map(sel => {
      const newOdds = { ...sel.odds };
      const key = sel.name; // '1', 'X', '2'

      if (key === '1') {
        const fv = fb ? decimalToOddsValue(fb.odds?.home) : null;
        const gv = gb ? decimalToOddsValue(gb.odds?.home) : null;
        if (fv) newOdds['freshbet'] = fv;
        if (gv) newOdds['goldenbet'] = gv;
      } else if (key === 'X') {
        const fv = fb ? decimalToOddsValue(fb.odds?.draw) : null;
        const gv = gb ? decimalToOddsValue(gb.odds?.draw) : null;
        if (fv) newOdds['freshbet'] = fv;
        if (gv) newOdds['goldenbet'] = gv;
      } else if (key === '2') {
        const fv = fb ? decimalToOddsValue(fb.odds?.away) : null;
        const gv = gb ? decimalToOddsValue(gb.odds?.away) : null;
        if (fv) newOdds['freshbet'] = fv;
        if (gv) newOdds['goldenbet'] = gv;
      }

      return { ...sel, odds: newOdds };
    });

    return { ...match, selections };
  });
}

// ─── GET /odds/:sport — primary endpoint (OddsAPI + FreshBet + GoldenBet) ──
app.get('/odds/:sport', async (req, res) => {
  const { sport } = req.params;
  const cacheKey = `odds-${sport}`;

  try {
    const cached = cache.get(cacheKey);
    if (cached) return res.json({ source: 'cache', data: cached, count: cached.length });

    let matches = [];

    if (HAS_ODDS_API) {
      // Fetch all three in parallel
      const [apiMatches, fb, gb] = await Promise.all([
        scrapeOddsAPI(sport),
        scrapeFreshBet(sport).catch(() => []),
        scrapeGoldenBet(sport).catch(() => []),
      ]);

      // Try to inject FB/GB odds into OddsAPI matches where team names match
      const enriched = injectFbOdds(apiMatches, fb, gb);

      // For FB/GB matches with NO OddsAPI equivalent, append them as standalone rows
      const apiKeys = new Set(apiMatches.map(m => normName(m.homeTeam) + normName(m.awayTeam)));
      const fbOnly = fb.filter(m => !apiKeys.has(normName(m.homeTeam) + normName(m.awayTeam)));
      const gbOnly = gb.filter(m => !apiKeys.has(normName(m.homeTeam) + normName(m.awayTeam)));

      // Convert FB/GB standalone matches to OddsAPI-compatible format
      function fbToApiFormat(m, source) {
        const homeOdds = m.odds?.home;
        const drawOdds = m.odds?.draw;
        const awayOdds = m.odds?.away;
        if (!homeOdds || !awayOdds) return null;
        const hv = decimalToOddsValue(homeOdds);
        const dv = drawOdds ? decimalToOddsValue(drawOdds) : null;
        const av = decimalToOddsValue(awayOdds);
        if (!hv || !av) return null;
        hv.isBest = true; av.isBest = true; if (dv) dv.isBest = true;
        const selections = [
          { name: '1', odds: { [source]: hv } },
          ...(dv ? [{ name: 'X', odds: { [source]: dv } }] : []),
          { name: '2', odds: { [source]: av } },
        ];
        return { ...m, source, selections };
      }

      const fbRows = fbOnly.map(m => fbToApiFormat(m, 'freshbet')).filter(Boolean);
      const gbRows = gbOnly.map(m => fbToApiFormat(m, 'goldenbet')).filter(Boolean);

      matches = [...enriched, ...fbRows, ...gbRows];
      console.log(`[API] ${sport}: ${enriched.length} enriched + ${fbRows.length} fb-only + ${gbRows.length} gb-only`);
    }

    if (matches.length === 0) {
      // Fallback: FreshBet + GoldenBet only
      const [fb, gb] = await Promise.all([scrapeFreshBet(sport), scrapeGoldenBet(sport)]);
      matches = [...fb, ...gb];
    }

    if (matches.length > 0) cache.set(cacheKey, matches);

    res.json({
      source: 'live',
      provider: HAS_ODDS_API ? 'theoddsapi' : 'freshbet',
      data: matches,
      count: matches.length,
      scrapedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error(`[API] /odds/${sport} error:`, err.message);
    try {
      const fb = await scrapeFreshBet(sport);
      res.json({ source: 'fallback', data: fb, count: fb.length });
    } catch {
      res.status(500).json({ error: err.message, data: [] });
    }
  }
});

// ─── GET /freshbet/:sport ─────────────────────────────────────────
app.get('/freshbet/:sport', async (req, res) => {
  const { sport } = req.params;
  try {
    const matches = await scrapeFreshBet(sport);
    res.json({ source: 'live', bookmaker: 'freshbet', data: matches, count: matches.length });
  } catch (err) {
    res.status(500).json({ error: err.message, data: [] });
  }
});

// ─── GET /goldenbet/:sport ────────────────────────────────────────
app.get('/goldenbet/:sport', async (req, res) => {
  const { sport } = req.params;
  try {
    const matches = await scrapeGoldenBet(sport);
    res.json({ source: 'live', bookmaker: 'goldenbet', data: matches, count: matches.length });
  } catch (err) {
    res.status(500).json({ error: err.message, data: [] });
  }
});

// ─── Background scrape — only FreshBet/GoldenBet (OddsAPI cached 2h internally) ─
const SPORTS   = ['football', 'basketball', 'tennis'];
const INTERVAL = parseInt(process.env.SCRAPE_INTERVAL_MS || '120000'); // 2 min default

async function backgroundScrape() {
  for (const sport of SPORTS) {
    try {
      if (HAS_ODDS_API) {
        // Refresh OddsAPI + inject/append FreshBet/GoldenBet
        const [apiMatches, fb, gb] = await Promise.all([
          scrapeOddsAPI(sport),
          scrapeFreshBet(sport).catch(() => []),
          scrapeGoldenBet(sport).catch(() => []),
        ]);
        const enriched = injectFbOdds(apiMatches, fb, gb);
        const apiKeys = new Set(apiMatches.map(m => normName(m.homeTeam) + normName(m.awayTeam)));
        function fbToApiFormat(m, source) {
          const hv = decimalToOddsValue(m.odds?.home);
          const dv = m.odds?.draw ? decimalToOddsValue(m.odds.draw) : null;
          const av = decimalToOddsValue(m.odds?.away);
          if (!hv || !av) return null;
          hv.isBest = true; av.isBest = true; if (dv) dv.isBest = true;
          return { ...m, source, selections: [{ name: '1', odds: { [source]: hv } }, ...(dv ? [{ name: 'X', odds: { [source]: dv } }] : []), { name: '2', odds: { [source]: av } }] };
        }
        const fbRows = fb.filter(m => !apiKeys.has(normName(m.homeTeam) + normName(m.awayTeam))).map(m => fbToApiFormat(m, 'freshbet')).filter(Boolean);
        const gbRows = gb.filter(m => !apiKeys.has(normName(m.homeTeam) + normName(m.awayTeam))).map(m => fbToApiFormat(m, 'goldenbet')).filter(Boolean);
        const merged = [...enriched, ...fbRows, ...gbRows];
        if (merged.length > 0) cache.set(`odds-${sport}`, merged);
        console.log(`[Background] ${sport}: ${merged.length} matches (api+fb+gb)`);
      } else {
        const [fb, gb] = await Promise.all([scrapeFreshBet(sport), scrapeGoldenBet(sport)]);
        const merged = [...fb, ...gb];
        if (merged.length > 0) cache.set(`odds-${sport}`, merged);
        console.log(`[Background] ${sport}: ${merged.length} matches (fb+gb)`);
      }
    } catch (err) {
      console.error(`[Background] ${sport} error:`, err.message);
    }
  }
}

setInterval(backgroundScrape, INTERVAL);
setTimeout(backgroundScrape, 3000);

// ─── Start ────────────────────────────────────────────────────────
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`\n🚀 OddsChecker Scraper running on port ${PORT}`);
  console.log(`   Sources: ${HAS_ODDS_API ? '✅ The Odds API (18+ bookmakers)' : '⚠️  FreshBet + GoldenBet only'}`);
  console.log(`\n   GET /health          — status`);
  console.log(`   GET /odds/:sport     — football / basketball / tennis`);
  console.log(`   GET /bookmakers      — list of supported bookmakers`);
  console.log(`   GET /freshbet/:sport — FreshBet only`);
  console.log(`   GET /goldenbet/:sport— GoldenBet only\n`);
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT',  () => process.exit(0));
