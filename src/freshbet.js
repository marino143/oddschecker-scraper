/**
 * FreshBet Sports API Integration
 *
 * API base: https://analytics-sp.googleserv.tech
 * Company ID: 52 (FreshBet)
 * No authentication required — public API endpoints
 *
 * Team names come from /api/sport/getheader/teams/en (3,799+ teams)
 * cached for 30 minutes and refreshed in background.
 */

const BASE_URL = 'https://analytics-sp.googleserv.tech';
const COMPANY_ID = 52;
const LANG = 'en';

// Sport IDs
const SPORT_IDS = {
  football:     1,
  basketball:   2,
  baseball:     3,
  'ice-hockey': 4,
  tennis:       5,
};

// Market ID 448 = Match Result (1X2), positions: 1=Home, 2=Draw, 3=Away
// Market ID 60  = Match Winner (2-way, no draw)
const MATCH_RESULT_MARKET = 448;
const MATCH_WINNER_MARKET = 60;

// ─── Caches ───────────────────────────────────────────────────────
let headerCache = null;
let headerCacheTime = 0;
const HEADER_TTL = 5 * 60 * 1000; // 5 minutes

let teamCache = null;         // Map: teamId (number) → teamName (string)
let teamCacheTime = 0;
const TEAM_TTL = 30 * 60 * 1000; // 30 minutes

async function apiFetch(path, retries = 2) {
  const url = `${BASE_URL}${path}`;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          'Accept': 'application/json, text/plain, */*',
          'Origin': 'https://freshbet.com',
          'Referer': 'https://freshbet.com/',
        },
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) throw new Error(`API ${res.status} for ${url}`);
      const text = await res.text();
      try { return JSON.parse(text); }
      catch { return JSON.parse(JSON.parse(text)); }
    } catch (err) {
      if (attempt === retries) throw err;
      console.warn(`[FreshBet] Retry ${attempt + 1}/${retries} for ${path}: ${err.message}`);
    }
  }
}

// ─── Step 1: Get game IDs grouped by sport ───────────────────────
async function getTopGames() {
  const data = await apiFetch(`/api/prematch/getprematchtopgames/${LANG}`);
  const parsed = typeof data === 'string' ? JSON.parse(data) : data;
  const result = {};
  for (const sport of parsed) {
    const sportName = Object.keys(SPORT_IDS).find(k => SPORT_IDS[k] === sport.id) || sport.kn?.toLowerCase() || `sport${sport.id}`;
    result[sportName] = sport.gms || [];
  }
  return result;
}

// ─── Step 2: Get odds for a batch of game IDs ─────────────────────
async function getGameOdds(gameIds) {
  if (!gameIds || gameIds.length === 0) return [];
  const idList = gameIds.slice(0, 50).join(',');
  const data = await apiFetch(`/api/prematch/getprematchgameall/${LANG}/${COMPANY_ID}/?games=,${idList}`);
  const parsed = typeof data === 'string' ? JSON.parse(data) : data;
  const games = typeof parsed === 'object' && parsed.game
    ? (typeof parsed.game === 'string' ? JSON.parse(parsed.game) : parsed.game)
    : parsed;
  return Array.isArray(games) ? games : [];
}

// ─── Step 3: Build league + game metadata from getheader ─────────
async function getHeaderMeta() {
  const now = Date.now();
  if (headerCache && now - headerCacheTime < HEADER_TTL) return headerCache;

  try {
    const data = await apiFetch(`/api/sport/getheader/${LANG}`);
    const parsed = typeof data === 'string' ? JSON.parse(data) : data;

    // champId → { name, regionName }
    const champMap = {};
    // gameId → { champId, t1, t2 }
    const gameMap = {};

    const sports = parsed?.EN?.Sports || {};
    for (const sport of Object.values(sports)) {
      for (const region of Object.values(sport.Regions || {})) {
        const regionName = region.Name || region.KeyName || '';
        for (const champ of Object.values(region.Champs || {})) {
          const champName = champ.Name || champ.KeyName || `League ${champ.ID}`;
          champMap[champ.ID] = { name: champName, region: regionName };
          for (const game of Object.values(champ.GameSmallItems || {})) {
            if (game.ID > 0) {
              gameMap[game.ID] = { champId: champ.ID, t1: game.t1, t2: game.t2 };
            }
          }
        }
      }
    }

    headerCache = { champMap, gameMap };
    headerCacheTime = now;
    console.log(`[FreshBet] getheader: ${Object.keys(champMap).length} leagues, ${Object.keys(gameMap).length} games`);
    return headerCache;
  } catch (e) {
    console.warn('[FreshBet] Could not load getheader:', e.message);
    return { champMap: {}, gameMap: {} };
  }
}

// ─── Step 4: Build team ID → name map from getheader/teams ───────
async function getTeamMap() {
  const now = Date.now();
  if (teamCache && now - teamCacheTime < TEAM_TTL) return teamCache;

  try {
    const data = await apiFetch(`/api/sport/getheader/teams/${LANG}`);
    const teams = Array.isArray(data) ? data : JSON.parse(data);

    const map = {};
    for (const t of teams) {
      if (t.ID && t.Name) map[t.ID] = t.Name;
    }

    teamCache = map;
    teamCacheTime = now;
    console.log(`[FreshBet] getheader/teams: ${Object.keys(map).length} teams loaded`);
    return map;
  } catch (e) {
    console.warn('[FreshBet] Could not load team names:', e.message);
    return teamCache || {};
  }
}

// ─── Format raw game data into our Match format ──────────────────
function formatGame(game, meta, teamMap, sport) {
  if (!game || !game.id) return null;

  const { champMap } = meta;

  // League name from getheader champ map
  const champInfo = champMap[game.ch] || {};
  const league = champInfo.name || `League ${game.ch}`;
  const region = champInfo.region || '';

  // Team names from getheader/teams endpoint
  const homeTeam = teamMap[game.t1] || `Team ${game.t1}`;
  const awayTeam = teamMap[game.t2] || `Team ${game.t2}`;

  // Extract odds
  const ev = game.ev || {};
  const market3way = ev[MATCH_RESULT_MARKET] || ev['448'];
  const market2way = ev[MATCH_WINNER_MARKET]  || ev['60'];
  const market = market3way || market2way;
  if (!market) return null;

  const outcomes = Object.values(market).sort((a, b) => a.pos - b.pos);
  const homeOdds = outcomes[0]?.coef || null;
  const drawOdds = outcomes.length >= 3 ? outcomes[1]?.coef : null;
  const awayOdds = outcomes[outcomes.length - 1]?.coef || null;
  if (!homeOdds || !awayOdds) return null;

  const startTime = game.st ? new Date(game.st) : null;
  const isLive    = game.s === 1;

  return {
    id:           `fb-${game.id}`,
    source:       'freshbet',
    affiliateUrl: 'https://freshbet.com/sportsbook',
    sport,
    league,
    region,
    homeTeam,
    awayTeam,
    homeTeamId:   game.t1,
    awayTeamId:   game.t2,
    time:    startTime ? startTime.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '',
    date:    startTime ? startTime.toLocaleDateString('en-GB') : '',
    isLive,
    isToday: startTime ? isToday(startTime) : false,
    odds: {
      home: homeOdds,
      draw: drawOdds,
      away: awayOdds,
    },
    rawId:     game.id,
    scrapedAt: new Date().toISOString(),
  };
}

function isToday(date) {
  const today = new Date();
  return date.getDate() === today.getDate() &&
    date.getMonth() === today.getMonth() &&
    date.getFullYear() === today.getFullYear();
}

// ─── Main public functions ────────────────────────────────────────
async function scrapeSport(sport = 'football') {
  console.log(`[FreshBet] Fetching ${sport}...`);
  try {
    const [topGames, meta, teamMap] = await Promise.all([
      getTopGames(),
      getHeaderMeta(),
      getTeamMap(),
    ]);

    const gameIds = topGames[sport] || topGames['soccer'] || [];
    if (gameIds.length === 0) {
      console.warn(`[FreshBet] No game IDs for sport: ${sport}`);
      return [];
    }
    console.log(`[FreshBet] Found ${gameIds.length} ${sport} game IDs`);

    const rawGames = await getGameOdds(gameIds);
    console.log(`[FreshBet] Got odds for ${rawGames.length} games`);

    const matches = rawGames
      .map(g => formatGame(g, meta, teamMap, sport))
      .filter(Boolean);

    console.log(`[FreshBet] Formatted ${matches.length} matches (teamMap size: ${Object.keys(teamMap).length})`);
    return matches;

  } catch (err) {
    console.error(`[FreshBet] Error scraping ${sport}:`, err.message);
    return [];
  }
}

async function scrapeAll() {
  const sports = ['football', 'basketball', 'tennis'];
  const results = {};
  for (const sport of sports) {
    results[sport] = await scrapeSport(sport);
    await new Promise(r => setTimeout(r, 500));
  }
  return results;
}

module.exports = { scrapeSport, scrapeAll, getTopGames, getGameOdds, getHeaderMeta, getTeamMap };
