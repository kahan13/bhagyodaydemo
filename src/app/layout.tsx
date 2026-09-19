import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Bhagyoday Belts - Inventory Management',
  description: 'Enterprise inventory control and order tracking system',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="antialiased bg-slate-50 text-slate-900">
        {children}
      </body>
    </html>
  );
}
