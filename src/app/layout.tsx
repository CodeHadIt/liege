import type { Metadata } from "next";
import { Outfit, JetBrains_Mono } from "next/font/google";
import { PrivyProvider } from "@/providers/privy-provider";
import { ThemeProvider } from "@/providers/theme-provider";
import { QueryProvider } from "@/providers/query-provider";
import { ChainProvider } from "@/providers/chain-provider";
import { WalletDialogProvider } from "@/providers/wallet-dialog-provider";
import { WalletDialog } from "@/components/shared/wallet-dialog";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ToastProvider } from "@/providers/toast-provider";
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
  icons: {
    icon: [
      { url: "/favicon.ico" },
      { url: "/favicon-96x96.png", sizes: "96x96", type: "image/png" },
      { url: "/favicon.svg", type: "image/svg+xml" },
    ],
    apple: "/apple-touch-icon.png",
  },
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
        <ThemeProvider>
          <QueryProvider>
            <PrivyProvider>
              <ChainProvider>
                <WalletDialogProvider>
                  <TooltipProvider>
                    <ToastProvider>
                      {children}
                      <WalletDialog />
                    </ToastProvider>
                  </TooltipProvider>
                </WalletDialogProvider>
              </ChainProvider>
            </PrivyProvider>
          </QueryProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
