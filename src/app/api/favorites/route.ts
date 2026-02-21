import { NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { supabase } from "@/lib/supabase";

export async function GET(request: Request) {
  const user = await getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await supabase
    .from("favorite_wallets")
    .select("*")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });

  if (error) {
    return NextResponse.json(
      { error: "Failed to fetch favorites" },
      { status: 500 }
    );
  }

  return NextResponse.json(data);
}

export async function POST(request: Request) {
  const user = await getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const { walletAddress, chain, label } = body as {
    walletAddress: string;
    chain: string;
    label?: string;
  };

  if (!walletAddress || !chain) {
    return NextResponse.json(
      { error: "walletAddress and chain are required" },
      { status: 400 }
    );
  }

  if (!["solana", "base", "bsc"].includes(chain)) {
    return NextResponse.json({ error: "Invalid chain" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("favorite_wallets")
    .upsert(
      {
        user_id: user.id,
        wallet_address: walletAddress,
        chain,
        label: label || null,
      },
      { onConflict: "user_id,wallet_address,chain" }
    )
    .select()
    .single();

  if (error) {
    console.error("Favorite upsert error:", error);
    return NextResponse.json(
      { error: "Failed to save favorite" },
      { status: 500 }
    );
  }

  return NextResponse.json(data);
}
