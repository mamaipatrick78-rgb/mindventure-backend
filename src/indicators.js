// Plain technical-indicator math. Pure functions, no I/O — easy to unit test and to
// swap or extend without touching the strategy or engine layers.

export function sma(values, period) {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

export function rsi(values, period = 14) {
  if (values.length < period + 1) return null;
  const recent = values.slice(-(period + 1));
  let gains = 0, losses = 0;
  for (let i = 1; i < recent.length; i++) {
    const diff = recent[i] - recent[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  if (gains === 0 && losses === 0) return 50; // no movement at all: neutral, not "overbought"
  if (losses === 0) return 100;
  const rs = (gains / period) / (losses / period);
  return 100 - 100 / (1 + rs);
}

// % change over the given lookback window, e.g. 7-day momentum.
export function momentum(values, period = 7) {
  if (values.length < period + 1) return null;
  const past = values[values.length - 1 - period];
  const now = values[values.length - 1];
  if (!past) return null;
  return ((now - past) / past) * 100;
}

export function computeIndicators(closingPrices) {
  return {
    price: closingPrices[closingPrices.length - 1] ?? null,
    sma20: sma(closingPrices, Math.min(20, closingPrices.length)),
    sma50: sma(closingPrices, Math.min(50, closingPrices.length)),
    rsi14: rsi(closingPrices, 14),
    momentum7: momentum(closingPrices, 7),
  };
}
