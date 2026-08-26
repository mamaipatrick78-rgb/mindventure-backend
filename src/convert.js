// The platform does not route orders to an external exchange (that would need a
// separate integration, API keys, and — for real customer funds — a lot more
// regulatory groundwork; see README). What it CAN do safely today is rebalance a
// user's own custodied balances between assets it already holds, at the current
// market price, inside one atomic DB transaction. That's what "AI trading" executes
// on in this codebase: BTC/ETH/SOL <-> USDT conversions, not live order placement.
import { pool } from './db.js';

const FEE_PCT = Number(process.env.CONVERT_FEE_PCT || 0.5); // platform fee, %

export async function convertAsset({ userId, fromAsset, toAsset, fromAmount, price, initiatedBy = 'ai' }) {
  if (fromAmount <= 0) throw new Error('fromAmount must be positive');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const bal = await client.query(
      'SELECT available FROM balances WHERE user_id=$1 AND asset=$2 FOR UPDATE',
      [userId, fromAsset]
    );
    const available = Number(bal.rows[0]?.available || 0);
    if (available < fromAmount) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'insufficient_balance' };
    }

    const gross = fromAmount * price;
    const fee = gross * (FEE_PCT / 100);
    const toAmount = gross - fee;

    await client.query(
      `INSERT INTO balances(user_id, asset, available) VALUES($1,$2,0)
       ON CONFLICT (user_id, asset) DO NOTHING`,
      [userId, toAsset]
    );
    await client.query(
      'UPDATE balances SET available = available - $1, updated_at = now() WHERE user_id=$2 AND asset=$3',
      [fromAmount, userId, fromAsset]
    );
    await client.query(
      'UPDATE balances SET available = available + $1, updated_at = now() WHERE user_id=$2 AND asset=$3',
      [toAmount, userId, toAsset]
    );

    const trade = await client.query(
      `INSERT INTO internal_trades(user_id, from_asset, to_asset, from_amount, to_amount, price, fee_pct, initiated_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [userId, fromAsset, toAsset, fromAmount, toAmount, price, FEE_PCT, initiatedBy]
    );

    await client.query(
      `INSERT INTO audit_logs(user_id, action, metadata) VALUES($1,'ai_trade_executed',$2)`,
      [userId, JSON.stringify({ fromAsset, toAsset, fromAmount, toAmount, price })]
    );

    await client.query('COMMIT');
    return { ok: true, trade: trade.rows[0] };
  } catch (e
