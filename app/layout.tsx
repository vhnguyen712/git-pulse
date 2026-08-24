import type { Metadata } from "next";
import { Geist, Inter, JetBrains_Mono } from "next/font/google";
import { AppShell } from "@/components/app-shell";
import "./globals.css";

// Headings — per design spec ("Geist for headings and Inter for standard UI elements").
const geist = Geist({
  variable: "--font-geist",
  subsets: ["latin"],
});

// UI / body text.
const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

// All developer-originated content: SHAs, file paths, code, terminal output.
const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "GitPulse AI",
  description:
    "Self-hosted dashboard that turns your GitHub commit history into progress summaries, next-step plans, and issue-ready ideas.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      // GitPulse AI is dark-only for MVP; the `dark` class activates the
      // `@custom-variant dark` styles some shadcn primitives use directly.
      className={`dark ${geist.variable} ${inter.variable} ${jetbrainsMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
