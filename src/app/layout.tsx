import type { Metadata } from 'next';
import { Inter, JetBrains_Mono, Instrument_Serif } from 'next/font/google';
import { Analytics } from '@vercel/analytics/next';
import { ThemeScript } from '@/components/theme/theme-script';
import { SITE_META } from '@/components/constants/site-meta';
import { DOWNLOAD_LICENSE_PRICE } from '@/lib/payments/pricing';
import './globals.css';

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.unviewable.online';

/** One description for search, social cards and JSON-LD, so they cannot drift. */
const SITE_DESCRIPTION =
  'Score your resume against any job description, fix what ATS filters reject without inventing experience, find matched openings, track applications and draft outreach. Built for students and freshers in India.';

const SHARE_TITLE = 'Unviewable — Everything you need to get hired';

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

const instrumentSerif = Instrument_Serif({
  subsets: ['latin'],
  weight: '400',
  style: ['normal', 'italic'],
  display: 'swap',
  variable: '--font-serif',
});

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  // POSITIONING (2026-09): the site sells a job-search suite — resume analyser,
  // matched openings, tracker, outreach — with the desktop overlay as one of four
  // services. This metadata previously described ONLY the overlay ("100%
  // unviewable… bypasses all screen-capture pipelines", keywords like
  // "undetectable AI"), so search results, link previews and AI answer engines
  // all described a different product from the homepage hero. Keep this block,
  // the OG image (opengraph-image.tsx) and the hero in src/app/page.tsx saying
  // the same thing.
  title: {
    default: 'Unviewable — ATS Resume Checker, Job Matches & Outreach for Freshers',
    template: '%s | Unviewable',
  },
  description: SITE_DESCRIPTION,
  keywords: [
    'unviewable',
    'ATS resume checker',
    'resume score',
    'resume analyser',
    'tailor resume to job description',
    'job application tracker',
    'fresher jobs India',
    'internships for students',
    'cold email for jobs',
    'AI interview assistant',
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
    title: SHARE_TITLE,
    description: SITE_DESCRIPTION,
    url: '/',
    locale: 'en_US',
  },
  twitter: {
    card: 'summary_large_image',
    title: SHARE_TITLE,
    description: SITE_DESCRIPTION,
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
      name: ['Free ATS Checker', 'Pricing', 'Setup Guide', 'Usage Guide', 'Feedback', 'Login'],
      url: [
        `${siteUrl}/ats-checker`,
        `${siteUrl}/pricing`,
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
      // Web app first (resume, jobs, outreach), plus the Windows desktop app.
      applicationCategory: 'BusinessApplication',
      operatingSystem: 'Web, Windows 10+',
      softwareVersion: SITE_META.softwareVersion,
      description: SITE_DESCRIPTION,
      url: siteUrl,
      // Points at the PUBLIC downloads page, never at the asset.
      //
      // This field previously held the raw GitHub Releases URL for the
      // installer. Because this JSON-LD block renders in <head> on EVERY page,
      // that URL was served to every anonymous visitor and indexed by search
      // engines — a complete bypass of the login gate and now of the paywall.
      // The binary is private (Supabase Storage) and only reachable via
      // /api/download/[platform] after an entitlement check.
      downloadUrl: `${siteUrl}/downloads`,
      // No `aggregateRating`. It used to emit a hardcoded 4.9 / 124 while the
      // reviews table held 4 rows — a fabricated rating in structured data is a
      // Google manual-action risk and a misleading claim. Re-add it only from
      // real data (src/lib/reviews/aggregate.ts) AND only on a page that also
      // shows those reviews, which Google requires for review markup.
      offers: {
        '@type': 'Offer',
        // Advertised, GST-EXCLUSIVE price. `valueAddedTaxIncluded: false`
        // states that tax is added on top, so the structured data matches the
        // ₹99 + 18% GST = ₹116.82 disclosure on /download.
        price: (DOWNLOAD_LICENSE_PRICE.baseAmountPaise / 100).toFixed(2),
        priceCurrency: DOWNLOAD_LICENSE_PRICE.currency,
        valueAddedTaxIncluded: false,
        availability: 'https://schema.org/InStock',
        url: `${siteUrl}/download`,
        // India-only launch: Razorpay international is not enabled.
        eligibleRegion: {
          '@type': 'Country',
          name: 'IN',
        },
      },
    }
  ];

  return (
    <html lang="en" suppressHydrationWarning className={`${inter.variable} ${jetbrainsMono.variable} ${instrumentSerif.variable}`}>
      <head>
        <meta name="theme-color" content="#0A0A0B" />
        {/* ThemeScript MUST appear before any <link> to a stylesheet so the
            synchronous IIFE writes data-theme on <html> before stylesheets
            evaluate — eliminates FOUC and the hydration mismatch warning. */}
        <ThemeScript />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        {/* Razorpay Checkout is loaded on demand by /download; preconnecting
            shaves the handshake off the first click. The old github.com and
            drive.google.com hints were removed along with the public installer
            URL — they advertised where the asset used to live. */}
        <link rel="dns-prefetch" href="https://checkout.razorpay.com" />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
      </head>
      <body>
        {children}
        {/* Page views only (no cookies, no personal data). Turn it on under
            Project > Analytics in the Vercel dashboard. Product funnel events
            are first-party, in the funnel_events table. */}
        <Analytics />
      </body>
    </html>
  );
}
