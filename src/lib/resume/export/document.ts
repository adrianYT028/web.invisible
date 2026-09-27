import type {
  ResumeDate,
  ResumeProfile,
  RewrittenBullet,
} from '@/lib/resume/schema';

// -----------------------------------------------------------------------------
// The tailored resume as a plain document model
// -----------------------------------------------------------------------------
//
// Built from the structured profile we extracted from the user's own resume,
// with the scan's rewrites swapped in bullet by bullet. Only rewrites stored in
// the report are used, and the report only ever stores rewrites that passed
// `verifyNoNewFacts` (src/lib/resume/ai/verify-no-new-facts.ts), so the exported
// document contains nothing the user did not already claim.
//
// One simple, single-column, ATS-safe layout: headings, lines and bullets. No
// tables, columns, icons or text boxes, because those are exactly what makes a
// resume unreadable to applicant tracking systems.
// -----------------------------------------------------------------------------

export interface DocItem {
  title: string;
  /** Company / institution / issuer line. */
  subtitle: string | null;
  dates: string | null;
  bullets: string[];
}

export interface DocSection {
  heading: string;
  items: DocItem[];
  /** For sections that are a single line of text (Skills). */
  line?: string;
}

export interface ResumeDoc {
  name: string;
  contactLine: string;
  summary: string | null;
  sections: DocSection[];
  /** How many bullets were replaced by an improved version. */
  rewritesApplied: number;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatDate(d: ResumeDate | null): string | null {
  if (!d) return null;
  if (d.year && d.month && d.month >= 1 && d.month <= 12) return `${MONTHS[d.month - 1]} ${d.year}`;
  if (d.year) return String(d.year);
  return d.raw?.trim() || null;
}

function range(start: ResumeDate | null, end: ResumeDate | null, current = false): string | null {
  const a = formatDate(start);
  const b = current ? 'Present' : formatDate(end);
  if (a && b) return `${a} – ${b}`;
  return a ?? b ?? null;
}

const join = (parts: Array<string | null | undefined>, sep: string) =>
  parts.map((p) => (p ?? '').trim()).filter(Boolean).join(sep) || null;

export function buildTailoredResume(
  profile: ResumeProfile,
  rewrites: readonly RewrittenBullet[]
): ResumeDoc {
  const replaced = new Map<string, string>();
  for (const r of rewrites) {
    if (r.addedNoNewFacts !== false && r.rewritten?.trim()) {
      replaced.set(r.sourceBulletId, r.rewritten.trim());
    }
  }
  let applied = 0;
  const bulletText = (b: { id: string; text: string }) => {
    const next = replaced.get(b.id);
    if (next) {
      applied += 1;
      return next;
    }
    return b.text.trim();
  };

  const c = profile.contact;
  const contactLine =
    join([c.email, c.phone, c.location, ...c.links.map((l) => l.url)], '  |  ') ?? '';

  const sections: DocSection[] = [];

  const experience = profile.experience.map((role) => ({
    title: role.title?.trim() || 'Role',
    subtitle: join([role.company, role.location], ', '),
    dates: range(role.startDate, role.endDate, role.isCurrent),
    bullets: role.bullets.map(bulletText).filter(Boolean),
  }));
  if (experience.length) sections.push({ heading: 'Experience', items: experience });

  const projects = profile.projects.map((p) => ({
    title: p.name?.trim() || 'Project',
    subtitle: join([p.technologies.join(', '), p.link], '  |  '),
    dates: null,
    bullets: [
      ...(p.description && p.bullets.length === 0 ? [p.description.trim()] : []),
      ...p.bullets.map(bulletText).filter(Boolean),
    ],
  }));
  if (projects.length) sections.push({ heading: 'Projects', items: projects });

  const education = profile.education.map((e) => ({
    title: join([e.degree, e.field], ', ') ?? e.institution ?? 'Education',
    subtitle: join([e.degree || e.field ? e.institution : null, e.score], '  |  '),
    dates: range(e.startDate, e.endDate),
    bullets: [],
  }));
  if (education.length) sections.push({ heading: 'Education', items: education });

  const skills = [...new Set(profile.skills.map((s) => s.name.trim()).filter(Boolean))];
  if (skills.length) sections.push({ heading: 'Skills', items: [], line: skills.join(', ') });

  const certs = profile.certifications
    .filter((x) => x.name)
    .map((x) => ({
      title: x.name!.trim(),
      subtitle: x.issuer?.trim() || null,
      dates: formatDate(x.date),
      bullets: [],
    }));
  if (certs.length) sections.push({ heading: 'Certifications', items: certs });

  return {
    name: c.name?.trim() || 'Your Name',
    contactLine,
    summary: profile.summary?.trim() || null,
    sections,
    rewritesApplied: applied,
  };
}

/** A safe download filename like "Priya_Sharma_Resume_Acme.docx". */
export function exportFilename(name: string, company: string | null, ext: string): string {
  const clean = (s: string) => s.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
  const base = [clean(name) || 'Resume', 'Resume', company ? clean(company) : ''].filter(Boolean).join('_');
  return `${base}.${ext}`;
}
