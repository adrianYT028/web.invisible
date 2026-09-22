import { describe, expect, it } from 'vitest';

import { htmlToText } from './docx';
import { findSections } from '../parse-quality';

// -----------------------------------------------------------------------------
// DOCX adapter tests
//
// Only `htmlToText` is covered here, because it is the part that can be tested
// without a binary fixture. A .docx is a zip of OOXML, so exercising mammoth
// itself needs a real file — see the coverage note at the bottom.
//
// This function is more load-bearing than it looks: the parse-quality gate finds
// section headings by examining whole short lines, so if HTML block boundaries
// did not become newlines, every DOCX upload would look structureless and be
// penalised for a defect it does not have.
// -----------------------------------------------------------------------------

describe('htmlToText', () => {
  it('turns paragraph boundaries into newlines', () => {
    expect(htmlToText('<p>EXPERIENCE</p><p>Backend Intern</p>')).toBe(
      'EXPERIENCE\nBackend Intern'
    );
  });

  it('turns headings into their own lines', () => {
    expect(htmlToText('<h1>Aarav Sharma</h1><h2>EDUCATION</h2>')).toBe(
      'Aarav Sharma\nEDUCATION'
    );
  });

  it('keeps list items on separate lines', () => {
    expect(htmlToText('<ul><li>First bullet</li><li>Second bullet</li></ul>')).toBe(
      'First bullet\nSecond bullet'
    );
  });

  it('honours explicit line breaks', () => {
    expect(htmlToText('<p>Line one<br />Line two</p>')).toBe('Line one\nLine two');
  });

  it('keeps a table row on one line with tab-separated cells', () => {
    // A row flattened across several lines would read as three unrelated
    // fragments and could attach a grade to the wrong subject.
    expect(
      htmlToText('<table><tr><td>Maths</td><td>A</td><td>2023</td></tr></table>')
    ).toBe('Maths\tA\t2023');
  });

  it('decodes the entities mammoth emits', () => {
    expect(htmlToText('<p>R&amp;D &lt;team&gt; &quot;lead&quot; &#39;24</p>')).toBe(
      'R&D <team> "lead" \'24'
    );
  });

  it('converts non-breaking spaces to ordinary ones', () => {
    // Left as U+00A0, these break the phone and email detectors, which match on
    // ordinary whitespace.
    expect(htmlToText('<p>+91&nbsp;98765&nbsp;43210</p>')).toBe(
      '+91 98765 43210'
    );
  });

  it('collapses runs of blank lines without merging content lines', () => {
    expect(htmlToText('<p>One</p><p></p><p></p><p>Two</p>')).toBe('One\n\nTwo');
  });

  it('strips inline markup without eating the words around it', () => {
    expect(
      htmlToText('<p>Built with <strong>Python</strong> and <em>Redis</em></p>')
    ).toBe('Built with Python and Redis');
  });

  it('produces text the section detector can actually read', () => {
    // The end-to-end point of this function.
    const html =
      '<h2>EXPERIENCE</h2><p>Backend Intern</p><h2>EDUCATION</h2>' +
      '<p>Amity University</p><h2>SKILLS</h2><p>Python</p>';

    expect([...findSections(htmlToText(html))].sort()).toEqual([
      'education',
      'experience',
      'skills',
    ]);
  });
});

// -----------------------------------------------------------------------------
// COVERAGE NOTE
//
// mammoth's own parsing is not exercised here: a .docx is a zip archive of
// OOXML parts, so a real binary fixture (or a zip writer) would be needed, and
// neither is in the dependency tree. What that leaves untested is the
// `convertToHtml` call and `translateDocxError`.
//
// The risk is contained. `extractDocx` is a thin wrapper — the structural
// signals it reports (tables, images) are simple regexes over mammoth's HTML,
// and everything downstream operates on the flattened text this file does cover.
// If DOCX handling turns out to need real fixtures, add a checked-in .docx
// rather than reaching for a zip dependency.
// -----------------------------------------------------------------------------
