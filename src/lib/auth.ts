import { PrivyClient } from "@privy-io/server-auth";
import { supabase } from "./supabase";

const privyAppId = process.env.NEXT_PUBLIC_PRIVY_APP_ID;
const privyAppSecret = process.env.PRIVY_APP_SECRET;

let privyClient: PrivyClient | null = null;

function getPrivyClient(): PrivyClient | null {
  if (!privyAppId || !privyAppSecret) return null;
  if (!privyClient) {
    privyClient = new PrivyClient(privyAppId, privyAppSecret);
  }
  return privyClient;
}

export interface AuthUser {
  id: string;
  wallet_address: string;
  chain: string;
  privy_did: string;
  created_at: string;
}

export async function getAuthUser(
  request: Request
): Promise<AuthUser | null> {
  try {
    const client = getPrivyClient();
    if (!client) return null;

    const authHeader = request.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) return null;

    const token = authHeader.slice(7);
    const verifiedClaims = await client.verifyAuthToken(token);
    const privyDid = verifiedClaims.userId;

    const { data, error } = await supabase
      .from("users")
      .select("*")
      .eq("privy_did", privyDid)
      .single();

    if (error || !data) return null;

    return data as AuthUser;
  } catch {
    return null;
  }
}
