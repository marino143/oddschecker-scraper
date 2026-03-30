/**
 * GoldenBet scraper — disabled (requires ZenRows + Playwright).
 * FreshBet (freshbet.js) is the active data source.
 */

async function scrapeFootball() { return []; }
async function scrapeSport() { return []; }
async function discoverApiEndpoints() {
  return { error: 'GoldenBet scraper not configured. Use /odds/:sport for FreshBet data.' };
}

module.exports = { scrapeFootball, scrapeSport, discoverApiEndpoints };
