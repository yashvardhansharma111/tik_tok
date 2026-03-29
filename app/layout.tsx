import type { Metadata } from "next";
import Script from "next/script";
import { Geist, Geist_Mono } from "next/font/google";
import { Sidebar } from "@/components/Sidebar";
import { ThemeProvider } from "@/components/ThemeProvider";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "TikTok Studio — Multi-account",
  description: "Upload and manage TikTok accounts",
};

const themeInit = `(function(){try{var k='tiktok-ui-theme';var t=localStorage.getItem(k);if(t==='dark')document.documentElement.classList.add('dark');else if(t==='light')document.documentElement.classList.remove('dark');else if(matchMedia('(prefers-color-scheme: dark)').matches)document.documentElement.classList.add('dark');}catch(e){}})()`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} min-h-screen antialiased`}
        suppressHydrationWarning
      >
        <Script id="theme-init" strategy="beforeInteractive">
          {themeInit}
        </Script>
        <ThemeProvider>
          <div className="flex min-h-screen" suppressHydrationWarning>
            <Sidebar />
            <main className="app-main-bg flex-1 overflow-auto">{children}</main>
          </div>
        </ThemeProvider>
      </body>
    </html>
  );
}
