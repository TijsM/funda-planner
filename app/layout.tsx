import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Plattegrond Studio',
  description:
    'Paste a Funda listing URL and get its real, editable floor plan — rearrange furniture, move walls, annotate and measure, live.',
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#14120F' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
