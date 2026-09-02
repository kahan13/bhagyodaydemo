import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';
import RegisterSW from '@/components/pwa/RegisterSW';

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Bhagyoday Belts — Inventory',
  description: 'Stock, movements and reporting for Bhagyoday Belt Company, Ahmedabad.',
  manifest: '/manifest.webmanifest',
  appleWebApp: { capable: true, statusBarStyle: 'default', title: 'Belt Stock' },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  themeColor: '#5b5bd6',
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <body>
        {children}
        <RegisterSW />
      </body>
    </html>
  );
}
