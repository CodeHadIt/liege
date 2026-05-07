/**
 * TonAPI v2 client — used for endpoints that TonCenter doesn't support well
 * (e.g. holders sorted by balance).
 * https://tonapi.io/api-explorer
 *
 * No API key required for basic queries (rate-limited to ~1 req/s).
 */

const BASE = "https://tonapi.io";

async function tonGet<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${BASE}${path}`, {
      headers: { Accept: "application/json" },
      next: { revalidate: 0 },
    });
    if (!res.ok) return null;
    return res.json() as Promise<T>;
  } catch {
    return null;
  }
}

// ── Address conversion ────────────────────────────────────────────────────────

/** CRC16/XMODEM used in the TON address encoding spec */
function crc16(data: Uint8Array): number {
  let crc = 0;
  for (const byte of data) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) : crc << 1;
      crc &= 0xffff;
    }
  }
  return crc;
}

/**
 * Convert a raw TON address ("0:hexstring") to the user-friendly base64url format.
 *  bounceable = true  → EQ... address
 *  bounceable = false → UQ... address (default — safer for display)
 */
export function rawToFriendly(raw: string, bounceable = false): string {
  const parts = raw.split(":");
  if (parts.length !== 2) return raw;

  const workchain = parseInt(parts[0], 10);
  const hexAddr   = parts[1].padStart(64, "0");
  let   addrBytes: Uint8Array;
  try {
    const buf = Buffer.from(hexAddr, "hex");
    addrBytes = new Uint8Array(buf);
  } catch {
    return raw;
  }

  // Tag byte: 0x11 = bounceable mainnet, 0x51 = non-bounceable mainnet
  const tag    = bounceable ? 0x11 : 0x51;
  const wcByte = workchain === -1 ? 0xff : workchain & 0xff;

  // Build 34-byte payload (tag + workchain + 32 addr bytes)
  const payload = new Uint8Array(34);
  payload[0] = tag;
  payload[1] = wcByte;
  payload.set(addrBytes, 2);

  // Append 2-byte CRC
  const crc  = crc16(payload);
  const full = new Uint8Array(36);
  full.set(payload);
  full[34] = (crc >> 8) & 0xff;
  full[35] = crc & 0xff;

  return Buffer.from(full)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface TonApiHolder {
  address: string;   // jetton-wallet raw address, "0:hex"
  owner: {
    address:   string;  // owner raw address, "0:hex"
    is_wallet: boolean;
  };
  balance: string;   // raw balance string
}

interface TonApiHoldersResponse {
  addresses: TonApiHolder[];
}

// ── Holders ───────────────────────────────────────────────────────────────────

/**
 * Fetch top holders for a jetton sorted by balance descending (TonAPI natively
 * sorts by balance, unlike TonCenter which sorts by last_transaction_lt).
 *
 * @param jettonAddress  jetton master address (user-friendly or raw)
 * @param limit          number of holders to return (max 1000)
 */
export async function getTonApiHolders(
  jettonAddress: string,
  limit = 50
): Promise<Array<{ ownerRaw: string; ownerFriendly: string; balance: string }>> {
  const data = await tonGet<TonApiHoldersResponse>(
    `/v2/jettons/${encodeURIComponent(jettonAddress)}/holders?limit=${Math.min(limit, 1000)}`
  );

  if (!data?.addresses?.length) return [];

  return data.addresses.map((h) => ({
    ownerRaw:      h.owner.address,
    // Contracts use bounceable (EQ...) addresses; wallets use non-bounceable (UQ...)
    ownerFriendly: rawToFriendly(h.owner.address, !h.owner.is_wallet),
    balance:       String(h.balance),
  }));
}
