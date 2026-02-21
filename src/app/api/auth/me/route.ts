import { NextResponse } from "next/server";
import { PrivyClient } from "@privy-io/server-auth";
import { supabase } from "@/lib/supabase";

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

export async function POST(request: Request) {
  try {
    const client = getPrivyClient();
    if (!client) {
      return NextResponse.json(
        { error: "Auth not configured" },
        { status: 503 }
      );
    }

    const authHeader = request.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json({ error: "Missing token" }, { status: 401 });
    }

    const token = authHeader.slice(7);
    const verifiedClaims = await client.verifyAuthToken(token);
    const privyDid = verifiedClaims.userId;

    const body = await request.json();
    const { walletAddress, chain } = body as {
      walletAddress: string;
      chain: string;
    };

    if (!walletAddress || !chain) {
      return NextResponse.json(
        { error: "walletAddress and chain are required" },
        { status: 400 }
      );
    }

    if (!["solana", "base", "bsc"].includes(chain)) {
      return NextResponse.json(
        { error: "Invalid chain" },
        { status: 400 }
      );
    }

    // Upsert user by wallet_address + chain
    const { data, error } = await supabase
      .from("users")
      .upsert(
        {
          wallet_address: walletAddress,
          chain,
          privy_did: privyDid,
        },
        { onConflict: "wallet_address,chain" }
      )
      .select()
      .single();

    if (error) {
      console.error("Supabase upsert error:", error);
      return NextResponse.json(
        { error: "Failed to sync user" },
        { status: 500 }
      );
    }

    return NextResponse.json(data);
  } catch (err) {
    console.error("Auth me error:", err);
    return NextResponse.json(
      { error: "Authentication failed" },
      { status: 401 }
    );
  }
}
