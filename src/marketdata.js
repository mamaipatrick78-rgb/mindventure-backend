// Market data via CoinGecko's free public API. No key required, but it is rate limited —
// shared hosting IPs (like Render's) can get rate-limited even at low request volume, since
// the limit is often per-IP and shared across every free app on that IP. Two defenses below:
// (1) a much longer cache than a per-minute price actually needs for a daily-signal strategy,
// (2) falling back to the last known good value on failure instead of throwing and killing
// the whole trading cycle for every user in it.
const IDS = { BTC: 'bitcoin', ETH: 'ethereum', SOL: 'solana', USDT: 'tether' };
const BASE = 'https://api.coingecko.com/api/v3';
const CACHE_MS = Number(process.env.MARKET_DATA_CACHE_MS || 900_000); // 15 min default

const cache = new Map(); // key -> { data, expires, staleData }

async function fetchJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`market data request failed: ${res.status}`);
  return res.json();
}

async function withStaleFallback(cacheKey, ttlMs, fetcher) {
  const hit = cache.get(cacheKey);
  if (hit && hit.expires > Date.now()) return hit.data;
  try {
    const data = await fetcher();
    cache.set(cacheKey, { data, expires: Date.now() + ttlMs });
    return data;
  } catch (e) {
    if (hit) {
      // Rate-limited or CoinGecko briefly down: serve the last known value rather than
      // failing outright. Slightly stale beats completely broken for a daily-signal strategy.
      console.error(`market data fetch failed for ${cacheKey}, serving stale cache:`, e.message);
      return hit.data;
    }
    throw e; // no cached value at all yet — nothing to fall back to
  }
}

// Returns ~last N days of daily closing prices in USD, oldest first.
export async function getPriceHistory(asset, days = 30) {
  const cacheKey = `${asset}:${days}`;
  return withStaleFallback(cacheKey, CACHE_MS, async () => {
    const id = IDS[asset];
    if (!id) throw new Error(`Unsupported asset: ${asset}`);
    const url = `${BASE}/coins/${id}/market_chart?vs_currency=usd&days=${days}&interval=daily`;
    const json = await fetchJson(url);
    return (json.prices || []).map(([ts, price]) => ({ ts, price }));
  });
}

// Returns { BTC: 68000.12, ETH: 3400.5, ... } current USD spot prices.
export async function getSpotPrices(assets) {
  const cacheKey = `spot:${assets.slice().sort().join(',')}`;
  return withStaleFallback(cacheKey, CACHE_MS, async () => {
    const ids = assets.map((a) => IDS[a]).filter(Boolean).join(',');
    const url = `${BASE}/simple/price?ids=${ids}&vs_currencies=usd`;
    const json = await fetchJson(url);
    const out = {};
    for (const asset of assets) {
      const id = IDS[asset];
      out[asset] = id && json[id] ? json[id].usd : null;
    }
    return out;
  });
}

export const TRADABLE_ASSETS = ['BTC', 'ETH', 'SOL'];
export const QUOTE_ASSET = 'USDT';
