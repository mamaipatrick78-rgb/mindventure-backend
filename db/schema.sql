CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE IF NOT EXISTS users(
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), email TEXT UNIQUE NOT NULL,
 password_hash TEXT NOT NULL, full_name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
 kyc_status TEXT NOT NULL DEFAULT 'not_started', two_factor_enabled BOOLEAN NOT NULL DEFAULT FALSE,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS balances(
 user_id UUID REFERENCES users(id) ON DELETE CASCADE, asset TEXT NOT NULL CHECK(asset IN('BTC','ETH','USDT','SOL')),
 available NUMERIC(38,18) NOT NULL DEFAULT 0, locked NUMERIC(38,18) NOT NULL DEFAULT 0,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(user_id,asset)
);
CREATE TABLE IF NOT EXISTS wallets(
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID REFERENCES users(id) ON DELETE CASCADE,
 asset TEXT NOT NULL, network TEXT NOT NULL, address TEXT, provider_ref TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(user_id,asset,network)
);
CREATE TABLE IF NOT EXISTS transactions(
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID REFERENCES users(id),
 type TEXT NOT NULL CHECK(type IN('deposit','withdrawal')), asset TEXT NOT NULL,
 network TEXT NOT NULL, amount NUMERIC(38,18) NOT NULL CHECK(amount>0), fee NUMERIC(38,18) DEFAULT 0,
 destination_address TEXT, tx_hash TEXT UNIQUE, status TEXT NOT NULL DEFAULT 'pending',
 confirmations INT NOT NULL DEFAULT 0, provider_ref TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS audit_logs(
 id BIGSERIAL PRIMARY KEY,user_id UUID,action TEXT NOT NULL,metadata JSONB,ip_address INET,created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- === AI Trading Engine ===
CREATE TABLE IF NOT EXISTS trading_settings(
 user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 autotrade_enabled BOOLEAN NOT NULL DEFAULT FALSE,
 mode TEXT NOT NULL DEFAULT 'paper' CHECK(mode IN ('paper','live')),
 watched_assets TEXT[] NOT NULL DEFAULT ARRAY['BTC','ETH','SOL'],
 -- Hard server-side ceilings below (CHECK constraints) cannot be raised by user input,
 -- regardless of what the API accepts. This is a deliberate risk control, not a default
 -- suggestion: even a compromised or malicious client-side request cannot exceed these.
 max_trade_pct NUMERIC(5,2) NOT NULL DEFAULT 5.0 CHECK(max_trade_pct > 0 AND max_trade_pct <= 25),
 max_daily_trades INT NOT NULL DEFAULT 6 CHECK(max_daily_trades > 0 AND max_daily_trades <= 50),
 daily_loss_limit_pct NUMERIC(5,2) NOT NULL DEFAULT 5.0 CHECK(daily_loss_limit_pct > 0 AND daily_loss_limit_pct <= 25),
 min_confidence NUMERIC(3,2) NOT NULL DEFAULT 0.60 CHECK(min_confidence >= 0.50 AND min_confidence <= 0.95),
 halted_reason TEXT,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ai_trade_decisions(
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id UUID REFERENCES users(id) ON DELETE CASCADE,
 asset TEXT NOT NULL,
 signal TEXT NOT NULL CHECK(signal IN ('BUY','SELL','HOLD')),
 confidence NUMERIC(4,3) NOT NULL,
 indicators JSONB NOT NULL,
 action TEXT NOT NULL,
 reason TEXT,
 executed BOOLEAN NOT NULL DEFAULT FALSE,
 trade_id UUID,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ai_decisions_user_time ON ai_trade_decisions(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS internal_trades(
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id UUID REFERENCES users(id) ON DELETE CASCADE,
 from_asset TEXT NOT NULL,
 to_asset TEXT NOT NULL,
 from_amount NUMERIC(38,18) NOT NULL CHECK(from_amount > 0),
 to_amount NUMERIC(38,18) NOT NULL CHECK(to_amount > 0),
 price NUMERIC(38,18) NOT NULL,
 fee_pct NUMERIC(5,3) NOT NULL DEFAULT 0.50,
 initiated_by TEXT NOT NULL DEFAULT 'ai' CHECK(initiated_by IN ('ai','user')),
 status TEXT NOT NULL DEFAULT 'completed',
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_internal_trades_user_time ON internal_trades(user_id, created_at DESC);

-- One row per user per UTC day: portfolio USD value the first time the engine sees
-- them that day. Used purely as the baseline for the daily-loss circuit breaker.
CREATE
