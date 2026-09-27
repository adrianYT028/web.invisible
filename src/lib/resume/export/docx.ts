import JSZip from 'jszip';

import type { ResumeDoc } from './document';

// -----------------------------------------------------------------------------
// ResumeDoc -> .docx (Office Open XML), built by hand with jszip
// -----------------------------------------------------------------------------
//
// A .docx is a zip of a few XML files. Writing the handful we need directly
// avoids a large document-generation dependency. The output uses only plain
// paragraphs, runs and Word's built-in list bullet, which every ATS parser and
// every word processor (Word, Google Docs, LibreOffice) reads.
// -----------------------------------------------------------------------------

function xml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    // Control characters are illegal in XML 1.0 and make Word refuse the file.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

interface RunOpts {
  bold?: boolean;
  italic?: boolean;
  /** Half-points: 22 = 11pt. */
  size?: number;
  color?: string;
}

function run(text: string, o: RunOpts = {}): string {
  const props = [
    o.bold ? '<w:b/>' : '',
    o.italic ? '<w:i/>' : '',
    o.color ? `<w:color w:val="${o.color}"/>` : '',
    o.size ? `<w:sz w:val="${o.size}"/><w:szCs w:val="${o.size}"/>` : '',
  ].join('');
  return `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ''}<w:t xml:space="preserve">${xml(text)}</w:t></w:r>`;
}

function para(runs: string, opts: { after?: number; before?: number; align?: 'center'; bullet?: boolean; border?: boolean; tabRight?: boolean } = {}): string {
  const pPr = [
    opts.bullet ? '<w:pStyle w:val="ListBullet"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>' : '',
    opts.tabRight ? '<w:tabs><w:tab w:val="right" w:pos="10080"/></w:tabs>' : '',
    opts.border ? '<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="999999"/></w:pBdr>' : '',
    `<w:spacing w:before="${opts.before ?? 0}" w:after="${opts.after ?? 60}"/>`,
    opts.align ? `<w:jc w:val="${opts.align}"/>` : '',
  ].join('');
  return `<w:p><w:pPr>${pPr}</w:pPr>${runs}</w:p>`;
}

const TAB = '<w:r><w:tab/></w:r>';

function body(doc: ResumeDoc): string {
  const out: string[] = [];
  out.push(para(run(doc.name, { bold: true, size: 36 }), { align: 'center', after: 40 }));
  if (doc.contactLine) out.push(para(run(doc.contactLine, { size: 19, color: '444444' }), { align: 'center', after: 160 }));

  if (doc.summary) {
    out.push(para(run('SUMMARY', { bold: true, size: 22 }), { border: true, before: 120, after: 80 }));
    out.push(para(run(doc.summary, { size: 21 }), { after: 120 }));
  }

  for (const section of doc.sections) {
    out.push(para(run(section.heading.toUpperCase(), { bold: true, size: 22 }), { border: true, before: 160, after: 80 }));
    if (section.line) out.push(para(run(section.line, { size: 21 }), { after: 80 }));
    for (const item of section.items) {
      out.push(
        para(run(item.title, { bold: true, size: 21 }) + (item.dates ? TAB + run(item.dates, { size: 20, color: '444444' }) : ''), {
          tabRight: true,
          before: 60,
          after: item.subtitle ? 0 : 40,
        })
      );
      if (item.subtitle) out.push(para(run(item.subtitle, { italic: true, size: 20, color: '444444' }), { after: 40 }));
      for (const b of item.bullets) out.push(para(run(b, { size: 21 }), { bullet: true, after: 30 }));
    }
  }
  return out.join('');
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
</Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

const DOC_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>
</Relationships>`;

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="21"/><w:szCs w:val="21"/><w:lang w:val="en-IN"/></w:rPr></w:rPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="ListBullet"><w:name w:val="List Bullet"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="360" w:hanging="220"/></w:pPr></w:style>
</w:styles>`;

const NUMBERING = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="360" w:hanging="220"/></w:pPr></w:lvl></w:abstractNum>
<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
</w:numbering>`;

export async function buildDocx(doc: ResumeDoc): Promise<Buffer> {
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body(doc)}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="850" w:right="850" w:bottom="850" w:left="850" w:header="0" w:footer="0" w:gutter="0"/></w:sectPr></w:body></w:document>`;

  const zip = new JSZip();
  zip.file('[Content_Types].xml', CONTENT_TYPES);
  zip.file('_rels/.rels', ROOT_RELS);
  zip.file('word/_rels/document.xml.rels', DOC_RELS);
  zip.file('word/document.xml', document);
  zip.file('word/styles.xml', STYLES);
  zip.file('word/numbering.xml', NUMBERING);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
