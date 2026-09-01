import type { Metadata, Viewport } from 'next';

import { TooltipProvider } from '@/components/ui/tooltip';

import './globals.css';

export const metadata: Metadata = {
  title: 'FPL Autopilot',
  description: 'One button. One decision. Your Fantasy Premier League gameweek, settled.',
};

export const viewport: Viewport = {
  themeColor: '#04050a',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // Dark-only by design; the class is set here rather than toggled so shadcn
    // components that key off it resolve to the right palette.
    <html lang="en" className="dark">
      <head>
        {/* Linked rather than bundled so the app still renders offline. */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <TooltipProvider delayDuration={200}>{children}</TooltipProvider>
      </body>
    </html>
  );
}
