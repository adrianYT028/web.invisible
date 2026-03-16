import type { Metadata } from 'next';
import './globals.css';

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000';

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: 'Invisible AI — The Intelligence They Can\'t See',
  description:
    'A 100% invisible AI assistant for high-stakes interviews and meetings. Bypasses all screen-capture pipelines.',
  icons: {
    icon: '/favicon.svg',
    apple: '/favicon.svg',
  },
  openGraph: {
    type: 'website',
    title: 'Invisible AI — The Intelligence They Can\'t See',
    description:
      'A 100% invisible AI assistant for high-stakes interviews and meetings. Bypasses all screen-capture pipelines.',
    url: '/',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Invisible AI — The Intelligence They Can\'t See',
    description:
      'A 100% invisible AI assistant for high-stakes interviews and meetings. Bypasses all screen-capture pipelines.',
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
