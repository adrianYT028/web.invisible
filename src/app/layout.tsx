import type { Metadata } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import { ThemeScript } from '@/components/theme/theme-script';
import { SITE_META } from '@/components/constants/site-meta';
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
  const jsonLd = [
    {
      '@context': 'https://schema.org',
      '@type': 'WebSite',
      name: 'Unviewable',
      url: siteUrl,
      potentialAction: {
        '@type': 'SearchAction',
        target: {
          '@type': 'EntryPoint',
          urlTemplate: `${siteUrl}/?q={search_term_string}`
        },
        'query-input': 'required name=search_term_string'
      }
    },
    {
      '@context': 'https://schema.org',
      '@type': 'Organization',
      name: 'Unviewable',
      url: siteUrl,
      logo: `${siteUrl}/logo.png`,
      sameAs: [
        'https://www.instagram.com/unviewable.online/'
      ]
    },
    {
      '@context': 'https://schema.org',
      '@type': 'SiteNavigationElement',
      name: ['Downloads', 'Setup Guide', 'Usage Guide', 'Feedback', 'Login'],
      url: [
        `${siteUrl}/downloads`,
        `${siteUrl}/guides/setup`,
        `${siteUrl}/guides/usage`,
        `${siteUrl}/feedback`,
        `${siteUrl}/login`
      ]
    },
    {
      '@context': 'https://schema.org',
      '@type': 'SoftwareApplication',
      name: 'Unviewable',
      applicationCategory: 'UtilitiesApplication',
      operatingSystem: 'Windows 10+',
      softwareVersion: SITE_META.softwareVersion,
      description: 'A 100% unviewable AI assistant for high-stakes interviews and meetings. Bypasses all screen-capture pipelines.',
      url: siteUrl,
      downloadUrl: 'https://github.com/adrianYT028/AIMeetingAssistant-Releases/releases/download/2.0.0/Unviewable_Setup_2.0.0.exe',
      aggregateRating: {
        '@type': 'AggregateRating',
        ratingValue: SITE_META.ratingValue,
        ratingCount: SITE_META.ratingCount
      },
      offers: {
        '@type': 'Offer',
        price: '0',
        priceCurrency: 'USD',
      },
    }
  ];

  return (
    <html lang="en" suppressHydrationWarning className={`${inter.variable} ${jetbrainsMono.variable}`}>
      <head>
        <meta name="theme-color" content="#0A0C12" />
        {/* ThemeScript MUST appear before any <link> to a stylesheet so the
            synchronous IIFE writes data-theme on <html> before stylesheets
            evaluate — eliminates FOUC and the hydration mismatch warning. */}
        <ThemeScript />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link rel="dns-prefetch" href="https://github.com" />
        <link rel="dns-prefetch" href="https://drive.google.com" />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
