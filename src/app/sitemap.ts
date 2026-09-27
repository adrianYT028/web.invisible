import type { MetadataRoute } from 'next';

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.unviewable.online';

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date().toISOString();

  return [
    {
      url: siteUrl,
      lastModified: now,
      changeFrequency: 'weekly',
      priority: 1.0,
    },
    // Pricing is the one public page that describes all four services, so it is
    // the second most important URL after `/`. It was missing from the sitemap
    // while the legacy desktop-only /downloads page sat at 0.9.
    {
      url: `${siteUrl}/pricing`,
      lastModified: now,
      changeFrequency: 'weekly',
      priority: 0.9,
    },
    // Legacy desktop-only page, no longer in the nav. Still public and linked
    // from older posts, so kept indexable but demoted.
    // The free, no-login checker: the page people find from search.
    {
      url: `${siteUrl}/ats-checker`,
      lastModified: now,
      changeFrequency: 'weekly',
      priority: 0.9,
    },
    {
      url: `${siteUrl}/downloads`,
      lastModified: now,
      changeFrequency: 'monthly',
      priority: 0.4,
    },
    {
      url: `${siteUrl}/guides/setup`,
      lastModified: now,
      changeFrequency: 'monthly',
      priority: 0.8,
    },
    {
      url: `${siteUrl}/guides/usage`,
      lastModified: now,
      changeFrequency: 'monthly',
      priority: 0.8,
    },
    {
      url: `${siteUrl}/feedback`,
      lastModified: now,
      changeFrequency: 'monthly',
      priority: 0.6,
    },
    // Policy pages. Low priority — they are not content we compete on — but
    // listed so they are discoverable and indexable, which helps Razorpay's
    // activation review confirm they exist on the live site.
    {
      url: `${siteUrl}/about`,
      lastModified: now,
      changeFrequency: 'yearly',
      priority: 0.4,
    },
    {
      url: `${siteUrl}/contact`,
      lastModified: now,
      changeFrequency: 'yearly',
      priority: 0.4,
    },
    {
      url: `${siteUrl}/terms`,
      lastModified: now,
      changeFrequency: 'yearly',
      priority: 0.3,
    },
    {
      url: `${siteUrl}/privacy`,
      lastModified: now,
      changeFrequency: 'yearly',
      priority: 0.3,
    },
    {
      url: `${siteUrl}/refund`,
      lastModified: now,
      changeFrequency: 'yearly',
      priority: 0.3,
    },
    // `/login`, `/account`, and `/download` are intentionally omitted —
    // utility/auth/action pages should not be advertised in the sitemap
    // (Google's own guidance), and they carry no content worth indexing.
    // `/download` is additionally `noindex`.
  ];
}
