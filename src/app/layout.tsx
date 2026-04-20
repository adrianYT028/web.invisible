import type { Metadata } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import './globals.css';

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.unviewable.online';

const inter = Inter({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-inter',
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-mono',
});

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: 'Unviewable — The Intelligence They Can\'t See',
    template: '%s | Unviewable',
  },
  description:
    'A 100% unviewable AI assistant for high-stakes interviews and meetings. Bypasses all screen-capture pipelines using Windows Display Affinity API.',
  keywords: [
    'unviewable',
    'AI overlay',
    'screen capture bypass',
    'meeting assistant',
    'interview helper',
    'stealth AI',
    'Windows overlay',
    'AI assistant',
    'undetectable AI',
  ],
  authors: [{ name: 'Unviewable' }],
  creator: 'Unviewable',
  publisher: 'Unviewable',
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      'max-video-preview': -1,
      'max-image-preview': 'large',
      'max-snippet': -1,
    },
  },
  alternates: {
    canonical: '/',
  },
  icons: {
    icon: '/logo.png',
    apple: '/logo.png',
  },
  openGraph: {
    type: 'website',
    siteName: 'Unviewable',
    title: 'Unviewable — The Intelligence They Can\'t See',
    description:
      'A 100% unviewable AI assistant for high-stakes interviews and meetings. Bypasses all screen-capture pipelines.',
    url: '/',
    locale: 'en_US',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Unviewable — The Intelligence They Can\'t See',
    description:
      'A 100% unviewable AI assistant for high-stakes interviews and meetings. Bypasses all screen-capture pipelines.',
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'Unviewable',
    applicationCategory: 'UtilitiesApplication',
    operatingSystem: 'Windows 10+',
    description:
      'A 100% unviewable AI assistant for high-stakes interviews and meetings. Bypasses all screen-capture pipelines.',
    url: siteUrl,
    offers: {
      '@type': 'Offer',
      price: '0',
      priceCurrency: 'USD',
    },
  };

  return (
    <html lang="en" className={`${inter.variable} ${jetbrainsMono.variable}`}>
      <head>
        <meta name="theme-color" content="#0A0C12" />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
