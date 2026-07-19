import { ClerkProvider } from "@clerk/nextjs";
import type { Metadata, Viewport } from "next";
import { Instrument_Serif, Inter, JetBrains_Mono } from "next/font/google";
import { OfflineAppProvider } from "@/components/providers/OfflineAppProvider";
import { ThemeProvider } from "@/components/providers/ThemeProvider";
import { Toaster } from "@/components/ui/toaster";
import "./globals.css";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
});

const instrumentSerif = Instrument_Serif({
  variable: "--font-instrument-serif",
  subsets: ["latin"],
  weight: "400",
  style: ["normal", "italic"],
});

function metadataBase(): URL {
  try {
    return new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000");
  } catch {
    return new URL("http://localhost:3000");
  }
}

export const metadata: Metadata = {
  metadataBase: metadataBase(),
  applicationName: "Stash",
  manifest: "/manifest.webmanifest",
  title: {
    default: "Stash — Collaborative Workspace",
    template: "%s · Stash",
  },
  description:
    "An open-source collaborative workspace for documents, spreadsheets, Kanban boards, structured team views, and charts with real-time editing, history, and controlled sharing.",
  keywords: [
    "collaborative workspace",
    "document management",
    "Markdown",
    "spreadsheet",
    "Kanban",
    "team views",
    "charts",
    "real-time collaboration",
    "self-hosted",
  ],
  authors: [{ name: "Rohit Vilas Ingole", url: "https://github.com/DataRohit" }],
  creator: "Rohit Vilas Ingole",
  publisher: "Rohit Vilas Ingole",
  category: "technology",
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    title: "Stash — Collaborative Workspace",
    description:
      "Collaborate on documents, spreadsheets, Kanban boards, structured team views, and charts with version history and controlled sharing.",
    url: "/",
    siteName: "Stash",
    locale: "en_US",
  },
  twitter: {
    card: "summary",
    title: "Stash — Collaborative Workspace",
    description:
      "Collaborate on documents, spreadsheets, Kanban boards, structured team views, and charts with version history and controlled sharing.",
  },
};

export const viewport: Viewport = {
  themeColor: "#171717",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      suppressHydrationWarning
      lang="en"
      className={`${inter.variable} ${jetbrainsMono.variable} ${instrumentSerif.variable} h-full antialiased`}
    >
      <body className="page-enter flex min-h-full flex-col font-sans">
        <ClerkProvider afterSignOutUrl="/">
          <ThemeProvider
            attribute="class"
            defaultTheme="light"
            enableSystem={false}
            disableTransitionOnChange
          >
            <OfflineAppProvider />
            {children}
            <Toaster />
          </ThemeProvider>
        </ClerkProvider>
      </body>
    </html>
  );
}
