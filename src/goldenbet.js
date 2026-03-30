/**
 * GoldenBet Sports API Integration
 *
 * API base: https://analytics-sp.googleserv.tech
 * Company ID: 73 (GoldenBet)
 * No authentication required — public API endpoints
 *
 * Shares the same backend provider as FreshBet (same game IDs, same team names).
 * Team names from /api/sport/getheader/teams/en (3,799+ teams), cached 30 min.
 */

const BASE_URL = 'https://analytics-sp.googleserv.tech';
const COMPANY_ID = 73;
const LANG = 'en';

const SPORT_IDS = {
  football:     1,
  basketball:   2,
  baseball:     3,
  'ice-hockey': 4,
  tennis:       5,
};

const MATCH_RESULT_MARKET = 448;
const MATCH_WINNER_MARKET = 60;

// ─── Caches ───────────────────────────────────────────────────────
let headerCache = null;
let headerCacheTime = 0;
const HEADER_TTL = 5 * 60 * 1000;

let teamCache = null;
let teamCacheTime = 0;
const TEAM_TTL = 30 * 60 * 1000;

async function apiFetch(path) {
  const url = `${BASE_URL}${path}`;
  const res = await fetch(url, {
    headers: {
      'Accept': 'application/json, text/plain, */*',
      'Origin': 'https://goldenbet.com',
      'Referer': 'https://goldenbet.com/',
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`API ${res.status} for ${url}`);
  const text = await res.text();
  try { return JSON.parse(text); }
  catch { return JSON.parse(JSON.parse(text)); }
}

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

async function getHeaderMeta() {
  const now = Date.now();
  if (headerCache && now - headerCacheTime < HEADER_TTL) return headerCache;

  try {
    const data = await apiFetch(`/api/sport/getheader/${LANG}`);
    const parsed = typeof data === 'string' ? JSON.parse(data) : data;

    const champMap = {};
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
    console.log(`[GoldenBet] getheader: ${Object.keys(champMap).length} leagues, ${Object.keys(gameMap).length} games`);
    return headerCache;
  } catch (e) {
    console.warn('[GoldenBet] Could not load getheader:', e.message);
    return { champMap: {}, gameMap: {} };
  }
}

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
    console.log(`[GoldenBet] getheader/teams: ${Object.keys(map).length} teams loaded`);
    return map;
  } catch (e) {
    console.warn('[GoldenBet] Could not load team names:', e.message);
    return teamCache || {};
  }
}

function formatGame(game, meta, teamMap, sport) {
  if (!game || !game.id) return null;

  const { champMap } = meta;

  const champInfo = champMap[game.ch] || {};
  const league = champInfo.name || `League ${game.ch}`;
  const region = champInfo.region || '';

  const homeTeam = teamMap[game.t1] || `Team ${game.t1}`;
  const awayTeam = teamMap[game.t2] || `Team ${game.t2}`;

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
    id:           `gb-${game.id}`,
    source:       'goldenbet',
    affiliateUrl: 'https://goldenbet.com/eng/sportsbook/prematch',
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

async function scrapeSport(sport = 'football') {
  console.log(`[GoldenBet] Fetching ${sport}...`);
  try {
    const [topGames, meta, teamMap] = await Promise.all([
      getTopGames(),
      getHeaderMeta(),
      getTeamMap(),
    ]);

    const gameIds = topGames[sport] || topGames['soccer'] || [];
    if (gameIds.length === 0) {
      console.warn(`[GoldenBet] No game IDs for sport: ${sport}`);
      return [];
    }
    console.log(`[GoldenBet] Found ${gameIds.length} ${sport} game IDs`);

    const rawGames = await getGameOdds(gameIds);
    console.log(`[GoldenBet] Got odds for ${rawGames.length} games`);

    const matches = rawGames
      .map(g => formatGame(g, meta, teamMap, sport))
      .filter(Boolean);

    console.log(`[GoldenBet] Formatted ${matches.length} matches`);
    return matches;

  } catch (err) {
    console.error(`[GoldenBet] Error scraping ${sport}:`, err.message);
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
