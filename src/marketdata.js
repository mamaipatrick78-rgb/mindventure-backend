// Market data via CoinGecko's free public API. No key required, but it is rate limited —
// shared hosting IPs (like Render's) can get rate-limited even at low request volume, since
// the limit is often per-IP and shared across every free app on that IP. Two defenses below:
// (1) a much longer cache than a per-minute price actually needs for a daily-signal strategy,
// (2) falling back to the last known good value on failure instead of throwing and killing
// the whole trading cycle for every user in it.
const IDS = {
  BTC: 'bitcoin', ETH: 'ethereum', SOL: 'solana', USDT: 'tether',
  BNB: 'binancecoin', MATIC: 'matic-network', AVAX: 'avalanche-2',
};
const BASE = 'https://api.coingecko.com/api/v3';
const CACHE_MS = Number(process.env.MARKET_DATA_CACHE_MS || 900_000); // 15 min default

const cache = new Map(); // key -> { data, expires }

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
      console.error(`market data fetch failed for ${cacheKey}, serving stale cache:`, e.message);
      return hit.data;
    }
    throw e;
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

// Same as getSpotPrices but also includes 24h % change, for the public Markets page.
export async function getMarketOverview(assets) {
  const cacheKey = `overview:${assets.slice().sort().join(',')}`;
  return withStaleFallback(cacheKey, CACHE_MS, async () => {
    const ids = assets.map((a) => IDS[a]).filter(Boolean).join(',');
    const url = `${BASE}/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true`;
    const json = await fetchJson(url);
    const out = {};
    for (const asset of assets) {
      const id = IDS[asset];
      const entry = id && json[id];
      out[asset] = entry ? { price: entry.usd, change24h: entry.usd_24h_change ?? null } : null;
    }
    return out;
  });
}

// BTC stays here for signal generation / paper trading even though custody can't yet
// deposit/withdraw it (see custody/adapter.js). BNB/MATIC/AVAX are new: full real custody
// support since they're all EVM-compatible, same as ETH.
export const TRADABLE_ASSETS = ['BTC', 'ETH', 'SOL', 'BNB', 'MATIC', 'AVAX'];
export const QUOTE_ASSET = 'USDT';
