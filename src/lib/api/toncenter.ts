/**
 * TonCenter v3 API client
 * https://toncenter.com/api/v3/
 */

const BASE = "https://toncenter.com";
const ZERO_ADDR = "0:0000000000000000000000000000000000000000000000000000000000000000";

function getApiKey(): string | null {
  return process.env.TON_CENTER_API_KEY ?? null;
}

function buildHeaders(): Record<string, string> {
  const key = getApiKey();
  const h: Record<string, string> = { Accept: "application/json" };
  if (key) h["X-API-Key"] = key;
  return h;
}

async function tcGet<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${BASE}${path}`, {
      headers: buildHeaders(),
      next: { revalidate: 0 },
    });
    if (!res.ok) return null;
    return res.json() as Promise<T>;
  } catch {
    return null;
  }
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TokenInfo {
  name:        string;
  symbol:      string;
  description: string | null;
  image:       string | null;
  decimals:    number | null;
  type:        string;
  valid:       boolean;
  extra:       Record<string, unknown>;
}

export interface JettonMasterRaw {
  address:                  string;
  admin_address:            string | null;
  mintable:                 boolean;
  total_supply:             string;
  jetton_wallet_code_hash:  string;
  last_transaction_lt:      string;
  jetton_content:           Record<string, unknown>;
}

export interface JettonMaster extends JettonMasterRaw {
  /** Decoded token info from metadata */
  tokenInfo: TokenInfo | null;
  /** User-friendly (base64url) address */
  userFriendly: string;
  /** Is admin renounced (admin is zero address or null) */
  adminRenounced: boolean;
}

export interface JettonWallet {
  address:   string;
  owner:     string;
  balance:   string;
  jetton:    string;
  /** User-friendly address from address_book */
  ownerFriendly: string;
}

export interface TonAccount {
  address:             string;
  balance:             string;   // nanotons
  status:              string;
  last_transaction_lt: string | null;
}

export interface TonTransaction {
  account:    string;
  hash:       string;
  lt:         string;
  now:        number;   // unix seconds
  total_fees: string;
  in_msg:     TonMessage | null;
  out_msgs:   TonMessage[];
}

export interface TonMessage {
  source:      string | null;
  destination: string | null;
  value:       string | null;
  opcode:      string | null;
  message_content?: { decoded?: { type?: string; comment?: string } } | null;
}

export interface JettonTransfer {
  transaction_hash:    string;
  transaction_now:     number;
  source:              string | null;
  destination:         string | null;
  source_wallet:       string;
  destination_wallet:  string;
  jetton_master:       string;
  amount:              string;
  /** symbol from metadata */
  symbol:   string | null;
  decimals: number;
}

// ── Jetton Master ─────────────────────────────────────────────────────────────

interface JettonMastersResponse {
  jetton_masters: JettonMasterRaw[];
  metadata: Record<string, { token_info: TokenInfo[] }>;
  address_book: Record<string, { user_friendly: string }>;
}

export async function getJettonMaster(address: string): Promise<JettonMaster | null> {
  const data = await tcGet<JettonMastersResponse>(
    `/api/v3/jetton/masters?address=${encodeURIComponent(address)}&limit=1`
  );
  if (!data || data.jetton_masters.length === 0) return null;

  const raw      = data.jetton_masters[0];
  const metaKey  = Object.keys(data.metadata)[0] ?? raw.address;
  const tokenInfo = data.metadata[metaKey]?.token_info?.[0] ?? null;
  const book      = data.address_book[raw.address];

  return {
    ...raw,
    tokenInfo,
    userFriendly: book?.user_friendly ?? address,
    adminRenounced:
      !raw.admin_address ||
      raw.admin_address === ZERO_ADDR ||
      raw.mintable === false,
  };
}

// ── Jetton Wallets (holders / portfolio) ──────────────────────────────────────

interface JettonWalletsResponse {
  jetton_wallets: Array<{
    address:   string;
    owner:     string;
    balance:   string;
    jetton:    string;
    last_transaction_lt: string;
  }>;
  metadata:     Record<string, { token_info: TokenInfo[] }>;
  address_book: Record<string, { user_friendly: string }>;
}

export async function getJettonHolders(
  jettonAddress: string,
  limit = 20
): Promise<JettonWallet[]> {
  const data = await tcGet<JettonWalletsResponse>(
    `/api/v3/jetton/wallets?jetton_address=${encodeURIComponent(jettonAddress)}&exclude_zero_balance=true&limit=${limit}&sort_order=desc`
  );
  if (!data?.jetton_wallets?.length) return [];

  const book = data.address_book ?? {};
  return data.jetton_wallets.map((w) => ({
    address:       w.address,
    owner:         w.owner,
    balance:       w.balance,
    jetton:        w.jetton,
    ownerFriendly: book[w.owner]?.user_friendly ?? book[w.address]?.user_friendly ?? w.owner,
  }));
}

export async function getWalletJettons(
  ownerAddress: string,
  limit = 50
): Promise<Array<JettonWallet & { symbol: string | null; name: string | null; decimals: number }>> {
  const data = await tcGet<JettonWalletsResponse>(
    `/api/v3/jetton/wallets?owner_address=${encodeURIComponent(ownerAddress)}&exclude_zero_balance=true&limit=${limit}`
  );
  if (!data) return [];

  return data.jetton_wallets.map((w) => {
    const metaKey   = Object.keys(data.metadata).find((k) =>
      k.toLowerCase() === w.jetton.toLowerCase()
    ) ?? w.jetton;
    const tokenInfo = data.metadata[metaKey]?.token_info?.[0] ?? null;
    return {
      address:       w.address,
      owner:         w.owner,
      balance:       w.balance,
      jetton:        w.jetton,
      ownerFriendly: data.address_book[w.owner]?.user_friendly ?? w.owner,
      symbol:        tokenInfo?.symbol ?? null,
      name:          tokenInfo?.name ?? null,
      decimals:      tokenInfo?.decimals ?? 9,
    };
  });
}

// ── Account ───────────────────────────────────────────────────────────────────

export async function getAccount(address: string): Promise<TonAccount | null> {
  return tcGet<TonAccount>(`/api/v3/account?address=${encodeURIComponent(address)}`);
}

// ── Transactions ──────────────────────────────────────────────────────────────

interface TransactionsResponse {
  transactions:  TonTransaction[];
  address_book:  Record<string, { user_friendly: string }>;
}

export async function getTransactions(
  account: string,
  limit = 20,
  sort: "asc" | "desc" = "desc"
): Promise<TonTransaction[]> {
  const data = await tcGet<TransactionsResponse>(
    `/api/v3/transactions?account=${encodeURIComponent(account)}&limit=${limit}&sort=${sort}`
  );
  return data?.transactions ?? [];
}

// ── Jetton Transfers ──────────────────────────────────────────────────────────

interface JettonTransfersResponse {
  jetton_transfers: Array<{
    transaction_hash:   string;
    transaction_now:    number;
    source:             string | null;
    destination:        string | null;
    source_wallet:      string;
    destination_wallet: string;
    jetton_master:      string;
    amount:             string;
  }>;
  metadata:     Record<string, { token_info: TokenInfo[] }>;
  address_book: Record<string, { user_friendly: string }>;
}

/** Jetton master address for USDT on TON (Tether) */
export const USDT_JETTON_MASTER = "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs";

export async function getJettonTransfers(
  ownerAddress: string,
  limit = 20
): Promise<JettonTransfer[]> {
  const data = await tcGet<JettonTransfersResponse>(
    `/api/v3/jetton/transfers?owner_address=${encodeURIComponent(ownerAddress)}&limit=${limit}&sort_order=desc`
  );
  if (!data) return [];

  return data.jetton_transfers.map((t) => {
    const metaKey   = Object.keys(data.metadata).find((k) =>
      k.toLowerCase() === t.jetton_master.toLowerCase()
    ) ?? t.jetton_master;
    const tokenInfo = data.metadata[metaKey]?.token_info?.[0] ?? null;
    return {
      ...t,
      symbol:   tokenInfo?.symbol ?? null,
      decimals: tokenInfo?.decimals ?? 9,
    };
  });
}

/** Fetch jetton transfers for a specific wallet filtered by jetton master */
export async function getJettonTransfersByToken(
  ownerAddress: string,
  jettonMaster: string,
  limit = 50
): Promise<JettonTransfer[]> {
  const data = await tcGet<JettonTransfersResponse>(
    `/api/v3/jetton/transfers?owner_address=${encodeURIComponent(ownerAddress)}&jetton_master=${encodeURIComponent(jettonMaster)}&limit=${limit}&sort_order=desc`
  );
  if (!data) return [];

  return data.jetton_transfers.map((t) => {
    const metaKey   = Object.keys(data.metadata).find((k) =>
      k.toLowerCase() === t.jetton_master.toLowerCase()
    ) ?? t.jetton_master;
    const tokenInfo = data.metadata[metaKey]?.token_info?.[0] ?? null;
    return {
      ...t,
      symbol:   tokenInfo?.symbol ?? null,
      decimals: tokenInfo?.decimals ?? 9,
    };
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Convert raw balance string to human-readable token amount */
export function fromNano(raw: string, decimals = 9): number {
  try {
    const n = BigInt(raw);
    const d = BigInt(10 ** decimals);
    const whole = Number(n / d);
    const frac  = Number(n % d) / 10 ** decimals;
    return whole + frac;
  } catch {
    return parseFloat(raw) / 10 ** decimals;
  }
}

/** Convert raw nanoton string to TON */
export function nanotonToTon(raw: string): number {
  return fromNano(raw, 9);
}
