import { Geist, Geist_Mono } from "next/font/google"

import "./globals.css"
import { ThemeProvider } from "@/components/theme-provider"
import { Providers } from "@/components/providers"
import type { Metadata, Viewport } from "next"
import { cn } from "@/lib/utils";

export const metadata: Metadata = {
  title: "Duely — escrow-backed early payment (demo)",
  description: "Freelancer escrow with AI-checked deliverables and a 90% early payment advance. Demo mode with simulated tokens.",
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#F5F8FC",
}

const geist = Geist({subsets:['latin'],variable:'--font-sans'})

const fontMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
})

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={cn("antialiased", fontMono.variable, "font-sans", geist.variable)}
    >
      <body>
        <ThemeProvider defaultTheme="light" enableSystem={false}>
          <Providers>{children}</Providers>
        </ThemeProvider>
      </body>
    </html>
  )
}
