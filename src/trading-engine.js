import { q } from './db.js';
import { getPriceHistory, getSpotPrices, TRADABLE_ASSETS, QUOTE_ASSET } from './marketdata.js';
import { generateSignal } from './strategy.js';
import { convertAsset } from './convert.js';
import { explainDecision } from './ai-explain.js';

async function computeSignals() {
  const signals = {};
  for (const asset of TRADABLE_ASSETS) {
    try {
      const history = await getPriceHistory(asset, 60);
      signals[asset] = generateSignal(history.map((p) => p.price));
    } catch (e) {
      signals[asset] = { action: 'HOLD', confidence: 0, indicators: {}, reason: `market data unavailable: ${e.message}` };
    }
  }
  return signals;
}

async function portfolioValueUsd(userId, spotPrices) {
  const bal = await q('SELECT asset, available FROM balances WHERE user_id=$1', [userId]);
  let total = 0;
  for (const row of bal.rows) {
    const price = row.asset === QUOTE_ASSET ? 1 : spotPrices[row.asset];
    if (price) total += Number(row.available) * price;
  }
  return total;
}

async function ensureDailySnapshot(userId, spotPrices) {
  const today = new Date().toISOString().slice(0, 10);
  const existing = await q('SELECT start_value_usd FROM portfolio_snapshots WHERE user_id=$1 AND day=$2', [userId, today]);
  if (existing.rows[0]) return Number(existing.rows[0].start_value_usd);
  const value = await portfolioValueUsd(userId, spotPrices);
  await q(
    `INSERT INTO portfolio_snapshots(user_id, day, start_value_usd) VALUES($1,$2,$3)
     ON CONFLICT (user_id, day) DO NOTHING`,
    [userId, today, value]
  );
  return value;
}

async function logDecision({ userId, asset, signal, executed, tradeId }) {
  const row = await q(
    `INSERT INTO ai_trade_decisions(user_id, asset, signal, confidence, indicators, action, reason, executed, trade_id)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [userId, asset, signal.action, signal.confidence, JSON.stringify(signal.indicators),
      executed ? `executed_${signal.action.toLowerCase()}` : `skipped_${signal.action.toLowerCase()}`,
      signal.reason, executed, tradeId || null]
  );
  return row.rows[0];
}

async function haltUser(userId, reason) {
  await q(
    `UPDATE trading_settings SET autotrade_enabled=false, halted_reason=$2, updated_at=now() WHERE user_id=$1`,
    [userId, reason]
  );
  await q(`INSERT INTO audit_logs(user_id, action, metadata) VALUES($1,'ai_trading_halted',$2)`,
    [userId, JSON.stringify({ reason })]);
}

async function runForUser(settings, signals, spotPrices) {
  const userId = settings.user_id;

  const startValue = await ensureDailySnapshot(userId, spotPrices);
  const currentValue = await portfolioValueUsd(userId, spotPrices);
  if (startValue > 0) {
    const drawdownPct = ((startValue - currentValue) / startValue) * 100;
    if (drawdownPct >= Number(settings.daily_loss_limit_pct)) {
      await haltUser(userId, `Daily loss limit reached (${drawdownPct.toFixed(2)}% drawdown).`);
      return;
    }
  }

  const today = new Date().toISOString().slice(0, 10);
  const tradeCount = await q(
    `SELECT count(*)::int AS c FROM ai_trade_decisions WHERE user_id=$1 AND executed=true AND created_at >= $2::date`,
    [userId, today]
  );
  let remainingTrades = settings.max_daily_trades - tradeCount.rows[0].c;

  const watched = (settings.watched_assets || []).filter((a) => TRADABLE_ASSETS.includes(a));
  const balances = await q('SELECT asset, available FROM balances WHERE user_id=$1', [userId]);
  const balanceByAsset = Object.fromEntries(balances.rows.map((r) => [r.asset, Number(r.available)]));

  for (const asset of watched) {
    const signal = signals[asset];
    const price = spotPrices[asset];

    if (remainingTrades <= 0) {
      await logDecision({ userId, asset, signal: { ...signal, reason: `${signal.reason} (daily trade limit reached)` }, executed: false });
      continue;
    }
    if (!price || signal.confidence < Number(settings.min_confidence) || signal.action === 'HOLD') {
      await logDecision({ userId, asset, signal, executed: false });
      continue;
    }

    let result = null;
    if (signal.action === 'BUY') {
      const usdtAvailable = balanceByAsset[QUOTE_ASSET] || 0;
      const spendUsdt = usdtAvailable * (Number(settings.max_trade_pct) / 100);
      if (spendUsdt <= 0 || !price) { await logDecision({ userId, asset, signal, executed: false }); continue; }
      // convertAsset's "price" is expressed as (units of toAsset per unit of fromAsset).
      // fromAsset is USDT (~$1), toAsset is `asset` at `price` USD, so that ratio is 1/price.
      result = await convertAsset({ userId, fromAsset: QUOTE_ASSET, toAsset: asset, fromAmount: spendUsdt, price: 1 / price, initiatedBy: 'ai' });
    } else if (signal.action === 'SELL') {
      const assetAvailable = balanceByAsset[asset] || 0;
      const sellAmount = assetAvailable * (Number(settings.max_trade_pct) / 100);
      if (sellAmount <= 0) { await logDecision({ userId, asset, signal, executed: false }); continue; }
      result = await convertAsset({ userId, fromAsset: asset, toAsset: QUOTE_ASSET, fromAmount: sellAmount, price, initiatedBy: 'ai' });
    }

    if (result?.ok) {
      remainingTrades -= 1;
      const decision = await logDecision({ userId, asset, signal, executed: true, tradeId: result.trade.id });
      explainDecision({ asset, action: signal.action, confidence: signal.confidence, indicators: signal.indicators, reason: signal.reason })
        .then((explanation) => q('UPDATE ai_trade_decisions SET reason=$1 WHERE id=$2', [explanation, decision.id]))
        .catch(() => {});
    } else {
      await logDecision({ userId, asset, signal: { ...signal, reason: `${signal.reason} (${result?.reason || 'conversion failed'})` }, executed: false });
    }
  }
}

export async function runTradingCycle() {
  const signals = await computeSignals();
  const spotPrices = await getSpotPrices([...TRADABLE_ASSETS, QUOTE_ASSET]);
  spotPrices[QUOTE_ASSET] = 1;

  const users = await q('SELECT * FROM trading_settings WHERE autotrade_enabled = true');
  for (const settings of users.rows) {
    try {
      await runForUser(settings, signals, spotPrices);
    } catch (e) {
      console.error(`trading cycle failed for user ${settings.user_id}:`, e.message);
    }
  }
  return { usersProcessed: users.rows.length, signals };
}

let intervalHandle = null;
export function startScheduler() {
  const ms = Number(process.env.TRADING_INTERVAL_MS || 15 * 60_000);
  if (intervalHandle) clearInterval(intervalHandle);
  intervalHandle = setInterval(() => {
    runTradingCycle().catch((e) => console.error('trading cycle error:', e));
  }, ms);
  console.log(`AI trading scheduler running every ${ms}ms`);
}
