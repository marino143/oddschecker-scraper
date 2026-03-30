/**
 * The Odds API Integration
 * https://the-odds-api.com
 *
 * Covers: Bet365, William Hill, Betway, Paddy Power, Sky Bet,
 *         Ladbrokes, Coral, Betfair Exchange, Unibet, BetVictor, etc.
 *
 * Free tier: 500 credits/month
 * Cache aggressively (2h) to stay within budget.
 */

const API_BASE = 'https://api.the-odds-api.com/v4';
const REGIONS  = 'uk';
const MARKETS  = 'h2h';
const ODDS_FORMAT = 'decimal';

// Sports to fetch — keep list small to preserve credits
const FOOTBALL_SPORTS = [
  'soccer_epl',
  'soccer_spain_la_liga',
  'soccer_germany_bundesliga',
  'soccer_italy_serie_a',
  'soccer_uefa_champs_league',
  'soccer_uefa_nations_league',
  'soccer_efl_champ',
  'soccer_france_ligue_one',
];
const BASKETBALL_SPORTS = ['basketball_nba', 'basketball_euroleague'];
const TENNIS_SPORTS     = ['tennis_wta_charleston_open'];

const SPORTS_BY_CATEGORY = {
  football:   FOOTBALL_SPORTS,
  basketball: BASKETBALL_SPORTS,
  tennis:     TENNIS_SPORTS,
};

// Cache: { sportKey → { data, fetchedAt } }
const cache = {};
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes — 20K plan (~10,000 credits/month at this rate)

// Bookmaker display names
const BM_NAMES = {
  williamhill:    'William Hill',
  bet365:         'Bet365',
  betway:         'Betway',
  paddypower:     'Paddy Power',
  skybet:         'Sky Bet',
  ladbrokes_uk:   'Ladbrokes',
  coral:          'Coral',
  betfair_ex_uk:  'Betfair Exchange',
  betfair_sb_uk:  'Betfair Sportsbook',
  unibet_uk:      'Unibet',
  betvictor:      'BetVictor',
  boylesports:    'Boylesports',
  sport888:       '888sport',
  smarkets:       'Smarkets',
  grosvenor:      'Grosvenor',
  casumo:         'Casumo',
  leovegas:       'LeoVegas',
  livescorebet:   'LiveScore Bet',
  virginbet:      'Virgin Bet',
};

function getApiKey() {
  const key = process.env.ODDS_API_KEY;
  if (!key) throw new Error('ODDS_API_KEY env var not set');
  return key;
}

async function fetchOddsForSport(sportKey) {
  const now = Date.now();
  if (cache[sportKey] && now - cache[sportKey].fetchedAt < CACHE_TTL) {
    return cache[sportKey].data;
  }

  const key = getApiKey();
  const url = `${API_BASE}/sports/${sportKey}/odds/?apiKey=${key}&regions=${REGIONS}&markets=${MARKETS}&oddsFormat=${ODDS_FORMAT}`;

  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });

  // Log remaining credits
  const remaining = res.headers.get('x-requests-remaining');
  const used = res.headers.get('x-requests-used');
  if (remaining) console.log(`[OddsAPI] ${sportKey}: ${remaining} credits remaining (used: ${used})`);

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OddsAPI ${res.status} for ${sportKey}: ${body}`);
  }

  const data = await res.json();
  cache[sportKey] = { data, fetchedAt: now };
  console.log(`[OddsAPI] ${sportKey}: ${data.length} events fetched`);
  return data;
}

function formatMatch(event, sport) {
  const { id, sport_title, commence_time, home_team, away_team, bookmakers } = event;

  const startTime = new Date(commence_time);
  const now = new Date();
  const isToday = startTime.toDateString() === now.toDateString();
  const isLive   = startTime < now;

  // Build odds map per bookmaker
  const oddsMap = {}; // bmKey → { home, draw, away }

  for (const bm of bookmakers) {
    const h2h = bm.markets?.find(m => m.key === 'h2h');
    if (!h2h) continue;

    const outcomes = h2h.outcomes;
    const homeOut  = outcomes.find(o => o.name === home_team);
    const awayOut  = outcomes.find(o => o.name === away_team);
    const drawOut  = outcomes.find(o => o.name === 'Draw');

    if (homeOut && awayOut) {
      oddsMap[bm.key] = {
        home: homeOut.price,
        draw: drawOut?.price ?? null,
        away: awayOut.price,
      };
    }
  }

  if (Object.keys(oddsMap).length === 0) return null;

  // Build selections with odds per bookmaker
  const homeOddsEntries = {};
  const drawOddsEntries = {};
  const awayOddsEntries = {};
  let hasDraw = false;

  for (const [bmKey, odds] of Object.entries(oddsMap)) {
    homeOddsEntries[bmKey] = decimalToOddsValue(odds.home);
    awayOddsEntries[bmKey] = decimalToOddsValue(odds.away);
    if (odds.draw !== null) {
      drawOddsEntries[bmKey] = decimalToOddsValue(odds.draw);
      hasDraw = true;
    }
  }

  // Mark best odds
  markBest(homeOddsEntries);
  markBest(drawOddsEntries);
  markBest(awayOddsEntries);

  const selections = [
    { name: '1', odds: homeOddsEntries },
    ...(hasDraw ? [{ name: 'X', odds: drawOddsEntries }] : []),
    { name: '2', odds: awayOddsEntries },
  ];

  return {
    id:         `oa-${id}`,
    source:     'theoddsapi',
    sport,
    league:     sport_title,
    country:    sportToRegion(sport),
    homeTeam:   home_team,
    awayTeam:   away_team,
    time:       startTime.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
    date:       isToday ? 'Today' : startTime.toLocaleDateString('en-GB'),
    isLive,
    isToday,
    bookmakerKeys: Object.keys(oddsMap),
    selections,
    scrapedAt:  new Date().toISOString(),
  };
}

function decimalToOddsValue(decimal) {
  const num = Math.round((decimal - 1) * 100);
  const denom = 100;
  const g = gcd(Math.abs(num), denom);
  return {
    decimal,
    fractional: `${num / g}/${denom / g}`,
    american:   decimal >= 2 ? `+${Math.round((decimal - 1) * 100)}` : `-${Math.round(100 / (decimal - 1))}`,
    isBest:     false,
  };
}

function gcd(a, b) { return b === 0 ? a : gcd(b, a % b); }

function markBest(oddsEntries) {
  let best = 0;
  for (const o of Object.values(oddsEntries)) if (o.decimal > best) best = o.decimal;
  for (const o of Object.values(oddsEntries)) o.isBest = o.decimal === best;
}

function sportToRegion(sport) {
  const map = {
    football:   'International',
    basketball: 'International',
    tennis:     'International',
  };
  return map[sport] || 'International';
}

async function scrapeSport(sport = 'football') {
  const sportKeys = SPORTS_BY_CATEGORY[sport] || SPORTS_BY_CATEGORY['football'];
  console.log(`[OddsAPI] Fetching ${sport} (${sportKeys.length} leagues)...`);

  const allMatches = [];

  for (const sportKey of sportKeys) {
    try {
      const events = await fetchOddsForSport(sportKey);
      for (const event of events) {
        const match = formatMatch(event, sport);
        if (match) allMatches.push(match);
      }
    } catch (err) {
      console.error(`[OddsAPI] Error for ${sportKey}:`, err.message);
    }
    // Small delay between requests
    await new Promise(r => setTimeout(r, 200));
  }

  console.log(`[OddsAPI] ${sport}: ${allMatches.length} total matches`);
  return allMatches;
}

// Get all available bookmaker keys (for frontend)
function getBookmakerNames() {
  return BM_NAMES;
}

module.exports = { scrapeSport, getBookmakerNames, BM_NAMES };
