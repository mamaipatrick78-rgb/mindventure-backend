// Market data via CoinGecko's free public API. No key required, but it is rate limited,
// so results are cached in memory. Swap this module out for a paid feed if you outgrow it —
// nothing else in the trading engine depends on CoinGecko specifically.
const IDS = { BTC: 'bitcoin', ETH: 'ethereum', SOL: 'solana', USDT: 'tether' };
const BASE = 'https://api.coingecko.com/api/v3';
const CACHE_MS = Number(process.env.MARKET_DATA_CACHE_MS || 60_000);

const cache = new Map(); // asset -> { data, expires }

async function fetchJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`market data request failed: ${res.status}`);
  return res.json();
}

// Returns ~last N days of daily closing prices in USD, oldest first.
export async function getPriceHistory(asset, days = 30) {
  const cacheKey = `${asset}:${days}`;
  const hit = cache.get(cacheKey);
  if (hit && hit.expires > Date.now()) return hit.data;

  const id = IDS[asset];
  if (!id) throw new Error(`Unsupported asset: ${asset}`);
  const url = `${BASE}/coins/${id}/market_chart?vs_currency=usd&days=${days}&interval=daily`;
  const json = await fetchJson(url);
  const prices = (json.prices || []).map(([ts, price]) => ({ ts, price }));
  cache.set(cacheKey, { data: prices, expires: Date.now() + CACHE_MS });
  return prices;
}

// Returns { BTC: 68000.12, ETH: 3400.5, ... } current USD spot prices.
export async function getSpotPrices(assets) {
  const cacheKey = `spot:${assets.slice().sort().join(',')}`;
  const hit = cache.get(cacheKey);
  if (hit && hit.expires > Date.now()) return hit.data;

  const ids = assets.map((a) => IDS[a]).filter(Boolean).join(',');
  const url = `${BASE}/simple/price?ids=${ids}&vs_currencies=usd`;
  const json = await fetchJson(url);
  const out = {};
  for (const asset of assets) {
    const id = IDS[asset];
    out[asset] = id && json[id] ? json[id].usd : null;
  }
  cache.set(cacheKey, { data: out, expires: Date.now() + CACHE_MS });
  return out;
}

export const TRADABLE_ASSETS = ['BTC', 'ETH', 'SOL'];
export const QUOTE_ASSET = 'USDT';
