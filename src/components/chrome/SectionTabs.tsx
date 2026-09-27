import Link from 'next/link';

import { SECTION_TABS, type SectionKey } from './nav-links';

/**
 * Tabs at the top of each section's pages (Resume, Jobs, Interview), so the
 * pages inside a section are one click apart and the header can stay at four
 * items. Server component; the current page is passed in rather than read from
 * the URL, so it ships no JavaScript.
 */
export function SectionTabs({ section, current }: { section: SectionKey; current: string }) {
  return (
    <nav className="section-tabs" aria-label={`${section} pages`}>
      {SECTION_TABS[section].map((tab) => (
        <Link
          key={tab.href}
          href={tab.href}
          className="section-tab"
          aria-current={tab.href === current ? 'page' : undefined}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
