import { computeIndicators } from './indicators.js';

// A transparent, auditable scoring model — NOT a guarantee of profit. Each indicator
// votes -1/0/+1 and confidence is derived from how much the votes agree. This is meant
// as a reasonable starting point, not a validated trading strategy.
//
// TREND FILTER (added after backtesting against a real year of BTC/ETH/SOL history):
// blocks BUY signals while price sits below its own 50-day average, and blocks SELL
// signals while price sits above it. In testing this consistently improved returns,
// cut max drawdown, and reduced trade count (less fee drag) on all three assets —
// it stops the engine from "buying the dip" mid-downtrend or "selling the rip" mid-uptrend.
// It does not turn the strategy profitable on its own; see README/backtest notes.
export function generateSignal(closingPrices) {
  const ind = computeIndicators(closingPrices);
  const votes = [];
  const notes = [];

  if (ind.rsi14 != null) {
    if (ind.rsi14 < 30) { votes.push(1); notes.push(`RSI ${ind.rsi14.toFixed(1)} indicates oversold`); }
    else if (ind.rsi14 > 70) { votes.push(-1); notes.push(`RSI ${ind.rsi14.toFixed(1)} indicates overbought`); }
    else { votes.push(0); notes.push(`RSI ${ind.rsi14.toFixed(1)} is neutral`); }
  }

  if (ind.sma20 != null && ind.sma50 != null) {
    if (ind.sma20 > ind.sma50) { votes.push(1); notes.push('short-term average above long-term average (uptrend)'); }
    else if (ind.sma20 < ind.sma50) { votes.push(-1); notes.push('short-term average below long-term average (downtrend)'); }
    else votes.push(0);
  }

  if (ind.momentum7 != null) {
    if (ind.momentum7 > 3) { votes.push(1); notes.push(`+${ind.momentum7.toFixed(1)}% over 7 days`); }
    else if (ind.momentum7 < -3) { votes.push(-1); notes.push(`${ind.momentum7.toFixed(1)}% over 7 days`); }
    else votes.push(0);
  }

  if (votes.length === 0) {
    return { action: 'HOLD', confidence: 0, indicators: ind, reason: 'Not enough price history yet.' };
  }

  const score = votes.reduce((a, b) => a + b, 0) / votes.length; // -1..1
  const confidence = Math.min(0.95, Math.abs(score) * 0.6 + 0.4 * (votes.filter(v => v !== 0).length / votes.length));
  let action = 'HOLD';
  if (score > 0.25) action = 'BUY';
  else if (score < -0.25) action = 'SELL';

  // Apply the trend filter (see comment above). A blocked signal becomes HOLD with
  // confidence 0 — clearly logged as "held back" rather than silently relabeled.
  if (ind.sma50 != null && ind.price != null) {
    if (action === 'BUY' && ind.price < ind.sma50) {
      return { action: 'HOLD', confidence: 0, indicators: ind, reason: `BUY signal held back — price is below its 50-day average (downtrend). ${notes.join('; ')}` };
    }
    if (action === 'SELL' && ind.price > ind.sma50) {
      return { action: 'HOLD', confidence: 0, indicators: ind, reason: `SELL signal held back — price is above its 50-day average (uptrend). ${notes.join('; ')}` };
    }
  }

  return {
    action,
    confidence: Number(confidence.toFixed(3)),
    indicators: ind,
    reason: notes.join('; ') || 'Mixed/neutral signals.',
  };
}
