// Custody abstraction. Never put private keys in PostgreSQL or the API.
// PrivyCustody below uses Privy's server wallets (api.privy.io) — Privy secures keys in
// hardware enclaves and never exposes them to this backend; this app only ever holds an
// app-level API secret that authorizes wallet creation and signing requests.
//
// Known limitation: Privy supports EVM chains (Ethereum, BNB Smart Chain, Polygon,
// Avalanche) and Solana, NOT Bitcoin. BTC deposit/withdrawal will keep failing clearly
// (see chainTypeFor) until a Bitcoin-capable provider is added.
//
// WITHDRAWALS RUN ON TESTNETS ONLY — see CAIP2_BY_ASSET below. This is deliberate: no
// licensing, KYC, or manual-review/2FA gate exists yet, so nothing here should ever touch
// real mainnet funds. Before that changes, this file needs mainnet caip2 values, a
// KYC/withdrawal-approval gate in server.js, and a per-user daily withdrawal cap.
import { Connection, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';

const PRIVY_APP_ID = process.env.PRIVY_APP_ID;
const PRIVY_APP_SECRET = process.env.PRIVY_APP_SECRET;
const PRIVY_BASE = 'https://api.privy.io/v1';

// Testnet chain IDs, one per EVM network we support. All EVM chains share the same
// address format, so a single Privy "ethereum" wallet can receive/send on any of these —
// only the caip2 identifier changes per network.
const CAIP2_BY_ASSET = {
  ETH: 'eip155:11155111',   // Ethereum Sepolia
  USDT_ETH: 'eip155:11155111',
  BNB: 'eip155:97',         // BNB Smart Chain Testnet
  MATIC: 'eip155:80002',    // Polygon Amoy Testnet
  AVAX: 'eip155:43113',     // Avalanche Fuji Testnet
};
const SOL_CAIP2 = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1'; // Solana Devnet
const SOLANA_DEVNET_RPC = 'https://api.devnet.solana.com';

function privyAuthHeaders() {
  const basic = Buffer.from(`${PRIVY_APP_ID}:${PRIVY_APP_SECRET}`).toString('base64');
  return {
    Authorization: `Basic ${basic}`,
    'privy-app-id': PRIVY_APP_ID,
    'Content-Type': 'application/json',
  };
}

// Maps our asset to a Privy chain_type. Returns null for anything Privy can't create a
// wallet for (Bitcoin today).
function chainTypeFor(asset) {
  if (['ETH', 'USDT', 'BNB', 'MATIC', 'AVAX'].includes(asset)) return 'ethereum';
  if (asset === 'SOL') return 'solana';
  return null;
}

// Which caip2 (chain identifier) to use for a withdrawal on this asset/network.
function caip2For(asset, network) {
  if (asset === 'SOL') return SOL_CAIP2;
  if (asset === 'USDT') return /solana/i.test(network || '') ? SOL_CAIP2 : CAIP2_BY_ASSET.USDT_ETH;
  return CAIP2_BY_ASSET[asset] || null;
}

// Privy's external_id field only accepts a restricted character set — our network names
// ("Ethereum / ERC-20") contain spaces and slashes that fail its validation.
function safeExternalId(userId, asset, network) {
  const safeNetwork = String(network || '').replace(/[^a-zA-Z0-9_-]+/g, '-');
  return `${userId}-${asset}-${safeNetwork}`.slice(0, 100);
}

async function privyRpc(walletId, body) {
  const res = await fetch(`${PRIVY_BASE}/wallets/${walletId}/rpc`, {
    method: 'POST',
    headers: privyAuthHeaders(),
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) {
    console.error('Privy RPC failed:', body.method, res.status, JSON.stringify(data));
    throw new Error(data.error || `Privy ${body.method} failed (${res.status})`);
  }
  return data;
}

async function privyRpcCreateWallet(chainType, externalId) {
  const res = await fetch(`${PRIVY_BASE}/wallets`, {
    method: 'POST',
    headers: privyAuthHeaders(),
    body: JSON.stringify({ chain_type: chainType, external_id: externalId }),
  });
  const data = await res.json();
  if (!res.ok) {
    console.error('Privy createDepositAddress failed:', res.status, JSON.stringify(data));
    throw new Error(data.error || `Privy wallet creation failed (${res.status})`);
  }
  return data;
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
    const chainType = chainTypeFor(asset);
    if (!chainType) throw new Error(`UNSUPPORTED_BY_PROVIDER:${asset}`);
    const data = await privyRpcCreateWallet(chainType, safeExternalId(userId, asset, network));
    return { providerRef: data.id, address: data.address };
  }

  async createWithdrawal({ asset, network, amount, destinationAddress, fromAddress, providerRef }) {
    const chainType = chainTypeFor(asset);
    if (!chainType) throw new Error(`UNSUPPORTED_BY_PROVIDER:${asset}`);
    if (!providerRef || !fromAddress) throw new Error('NO_SOURCE_WALLET_ON_FILE');

    if (chainType === 'ethereum') {
      const caip2 = caip2For(asset, network);
      const valueWei = BigInt(Math.round(amount * 1e18));
      const data = await privyRpc(providerRef, {
        method: 'eth_sendTransaction',
        caip2,
        chain_type: 'ethereum',
        params: { transaction: { to: destinationAddress, value: '0x' + valueWei.toString(16) } },
      });
      return { providerRef: data.data.transaction_id, txHash: data.data.hash, status: 'completed' };
    }

    // Solana: we build the unsigned transfer transaction ourselves (Privy signs+sends it).
    const connection = new Connection(SOLANA_DEVNET_RPC);
    const { blockhash } = await connection.getLatestBlockhash();
    const fromKey = new PublicKey(fromAddress);
    const tx = new Transaction({ recentBlockhash: blockhash, feePayer: fromKey });
    tx.add(SystemProgram.transfer({
      fromPubkey: fromKey,
      toPubkey: new PublicKey(destinationAddress),
      lamports: Math.round(amount * 1_000_000_000),
    }));
    const serialized = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
    const data = await privyRpc(providerRef, {
      method: 'signAndSendTransaction',
      caip2: caip2For(asset, network),
      transaction: serialized,
    });
    return { providerRef: data.data.transaction_id, txHash: data.data.hash, status: 'completed' };
  }

  async getTransaction() { return null; }
}

export function custody() {
  if (process.env.CUSTODY_PROVIDER === 'privy' && PRIVY_APP_ID && PRIVY_APP_SECRET) {
    return new PrivyCustody();
  }
  return new MockCustody();
  }
