// Custody abstraction. Never put private keys in PostgreSQL or the API.
// PrivyCustody below uses Privy's server wallets (api.privy.io) — Privy secures keys in
// hardware enclaves and never exposes them to this backend; this app only ever holds an
// app-level API secret that authorizes wallet creation and signing requests.
//
// Known limitation: Privy supports Ethereum and Solana, NOT Bitcoin. BTC deposit/withdrawal
// will keep failing clearly (see chainTypeFor) until a Bitcoin-capable provider is added.
const PRIVY_APP_ID = process.env.PRIVY_APP_ID;
const PRIVY_APP_SECRET = process.env.PRIVY_APP_SECRET;
const PRIVY_BASE = 'https://api.privy.io/v1';

function privyAuthHeaders() {
  const basic = Buffer.from(`${PRIVY_APP_ID}:${PRIVY_APP_SECRET}`).toString('base64');
  return {
    Authorization: `Basic ${basic}`,
    'privy-app-id': PRIVY_APP_ID,
    'Content-Type': 'application/json',
  };
}

// Maps our (asset, network) pair to a Privy chain_type. Returns null for anything Privy
// can't create a wallet for (Bitcoin today).
function chainTypeFor(asset, network) {
  if (asset === 'ETH') return 'ethereum';
  if (asset === 'SOL') return 'solana';
  if (asset === 'USDT') return /solana/i.test(network || '') ? 'solana' : 'ethereum';
  return null;
}

// Privy's external_id field only accepts a restricted character set — our network names
// ("Ethereum / ERC-20") contain spaces and slashes that fail its validation, so strip
// anything but letters, numbers, dashes and underscores.
function safeExternalId(userId, asset, network) {
  const safeNetwork = String(network || '').replace(/[^a-zA-Z0-9_-]+/g, '-');
  return `${userId}-${asset}-${safeNetwork}`.slice(0, 100);
}

export class CustodyAdapter {
  async createDepositAddress() { throw new Error('CUSTODY_PROVIDER_NOT_CONFIGURED'); }
  async createWithdrawal() { throw new Error('CUSTODY_PROVIDER_NOT_CONFIGURED'); }
  async getTransaction() { throw new Error('CUSTODY_PROVIDER_NOT_CONFIGURED'); }
}

export class MockCustody extends CustodyAdapter {
  async createDepositAddress({ asset, network, userId }) {
    return { providerRef: `demo-${userId}-${asset}-${network}`, address: `DEMO_${asset}_${network}_ADDRESS` };
  }
  async createWithdrawal() { return { providerRef: 'demo-withdrawal', status: 'pending' }; }
  async getTransaction() { return null; }
}

export class PrivyCustody extends CustodyAdapter {
  async createDepositAddress({ asset, network, userId }) {
    const chainType = chainTypeFor(asset, network);
    if (!chainType) {
      // Deliberately fails loudly instead of returning a fake address for an asset
      // this provider can't actually service.
      throw new Error(`UNSUPPORTED_BY_PROVIDER:${asset}`);
    }
    const res = await fetch(`${PRIVY_BASE}/wallets`, {
      method: 'POST',
      headers: privyAuthHeaders(),
      body: JSON.stringify({ chain_type: chainType, external_id: safeExternalId(userId, asset, network) }),
    });
    const data = await res.json();
    if (!res.ok) {
      console.error('Privy createDepositAddress failed:', res.status, JSON.stringify(data));
      throw new Error(data.error || `Privy wallet creation failed (${res.status})`);
    }
    return { providerRef: data.id, address: data.address };
  }

  async createWithdrawal() {
    // Sending funds out needs Privy's per-chain sendTransaction endpoints plus real
    // amount/fee/nonce handling — deliberately not wired yet. Withdrawals stay 'pending'
    // in the transactions table (see server.js) until this is built and tested on testnets.
    return { providerRef: 'privy-withdrawal-not-yet-wired', status: 'pending' };
  }

  async getTransaction() { return null; }
}

export function custody() {
  if (process.env.CUSTODY_PROVIDER === 'privy' && PRIVY_APP_ID && PRIVY_APP_SECRET) {
    return new PrivyCustody();
  }
  return new MockCustody();
}
