import type { Metadata } from "next";
import { Outfit, JetBrains_Mono } from "next/font/google";
import { PrivyProvider } from "@/providers/privy-provider";
import { ThemeProvider } from "@/providers/theme-provider";
import { QueryProvider } from "@/providers/query-provider";
import { ChainProvider } from "@/providers/chain-provider";
import { WalletDialogProvider } from "@/providers/wallet-dialog-provider";
import { WalletDialog } from "@/components/shared/wallet-dialog";
import { TooltipProvider } from "@/components/ui/tooltip";
import "./globals.css";

const outfit = Outfit({
  variable: "--font-outfit",
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700", "800"],
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

export const metadata: Metadata = {
  title: "Liege — Crypto Intelligence",
  description:
    "Onchain analysis, token research, and wallet tracking for Solana, Base, and BSC.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning className="dark">
      <body
        className={`${outfit.variable} ${jetbrainsMono.variable} font-sans antialiased`}
      >
        <PrivyProvider>
          <ThemeProvider>
            <QueryProvider>
              <ChainProvider>
                <WalletDialogProvider>
                  <TooltipProvider>
                    {children}
                    <WalletDialog />
                  </TooltipProvider>
                </WalletDialogProvider>
              </ChainProvider>
            </QueryProvider>
          </ThemeProvider>
        </PrivyProvider>
      </body>
    </html>
  );
}
