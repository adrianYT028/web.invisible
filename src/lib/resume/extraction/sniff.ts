// TYPE-ONLY import. `index.ts` dynamically imports this module, so importing a
// runtime value back from it would close a cycle; a type import is erased at
// compile time and cannot. The supported list is re-derived below from the type,
// so it still cannot drift from the contract.
import type { SupportedMimeType } from './index';

/**
 * Identify a document from its BYTES rather than its declared type.
 *
 * ---------------------------------------------------------------------------
 * WHY
 *
 * The upload route chose a parser from `file.type`, which is whatever the
 * browser guessed — usually from the filename extension. That is wrong often
 * enough to matter:
 *
 *   - A PDF saved as `resume.docx` was handed to mammoth, which failed with
 *     "not a readable DOCX" for a file that is a perfectly good PDF.
 *   - Some browsers and mail clients send `application/octet-stream` for both,
 *     which was rejected as an unsupported type before anything looked at it.
 *   - A `.txt` renamed `.pdf` reached pdfjs and produced an unmappable error.
 *
 * In every case the bytes were unambiguous and nothing consulted them. Sniffing
 * turns three confusing failures into three successful uploads.
 *
 * ---------------------------------------------------------------------------
 * THIS IS NOT A SECURITY CONTROL
 *
 * A magic number is two to four bytes and trivially forged. It decides which
 * PARSER to use, nothing else. Each adapter still validates the full structure
 * and each still reports `corrupt_document` on a mismatch, the size cap is
 * enforced before this runs, and pdfjs is configured for untrusted input
 * regardless. Sniffing improves the chance of reading a legitimate file; it does
 * not add trust.
 */

/** `%PDF-` — required at the start of every PDF by the spec. */
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d] as const;

/**
 * `PK\x03\x04` — a ZIP local file header. A DOCX is a ZIP container, so this is
 * as specific as the first bytes can be: every DOCX matches, and so does every
 * other ZIP. Treating it as DOCX is the correct guess in an upload flow that
 * accepts exactly one ZIP-based format, and mammoth rejects a ZIP that has no
 * word/document.xml anyway.
 */
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04] as const;

const DOCX_MIME =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document' as const;

/**
 * Signatures we can NAME but cannot READ.
 *
 * Identifying these is what separates a useful refusal from a confusing one. A
 * legacy `.doc` is an OLE2 compound file; handed to the text adapter it comes
 * back as "this does not look like text", which tells the user nothing they can
 * act on. Named, it becomes "convert it to PDF or DOCX" — the one instruction
 * that actually fixes their upload.
 *
 * Images are here for the same reason and are not hypothetical: people
 * screenshot a resume and upload the PNG. There is no OCR in this pipeline, so
 * the honest answer is that an image has no text to read, not that their text
 * file is corrupt.
 */
const OLE2_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] as const;
/** `{\rtf` */
const RTF_MAGIC = [0x7b, 0x5c, 0x72, 0x74, 0x66] as const;
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47] as const;
const JPEG_MAGIC = [0xff, 0xd8, 0xff] as const;
const GIF_MAGIC = [0x47, 0x49, 0x46, 0x38] as const;

const UNREADABLE_SIGNATURES: readonly {
  magic: readonly number[];
  mime: string;
}[] = [
  // OLE2 also covers legacy .xls and .ppt. In a resume upload flow .doc is the
  // overwhelming case, and naming it .doc gives the right advice for all three.
  { magic: OLE2_MAGIC, mime: 'application/msword' },
  { magic: RTF_MAGIC, mime: 'application/rtf' },
  { magic: PNG_MAGIC, mime: 'image/png' },
  { magic: JPEG_MAGIC, mime: 'image/jpeg' },
  { magic: GIF_MAGIC, mime: 'image/gif' },
];

/**
 * Declarations that carry no information.
 *
 * These are what a browser or mail client sends when it has no idea, so falling
 * back to text for them is a guess against nothing. A SPECIFIC declaration is
 * different: `application/msword` is the client telling us what the file is, and
 * overriding that with a guess replaces a correct refusal with a wrong one.
 */
const UNINFORMATIVE_DECLARATIONS: readonly string[] = [
  '',
  'application/octet-stream',
  'binary/octet-stream',
  'application/binary',
  'application/download',
  'application/force-download',
  'application/unknown',
];

/**
 * The supported set, declared locally to avoid importing a runtime value from
 * `index.ts` and closing an import cycle.
 *
 * `satisfies readonly SupportedMimeType[]` is what keeps it honest: if the
 * contract in index.ts gains or renames a type, this fails to compile rather than
 * silently disagreeing.
 */
const SUPPORTED = [
  'application/pdf',
  DOCX_MIME,
  'text/plain',
] as const satisfies readonly SupportedMimeType[];

function isSupported(mime: string): mime is SupportedMimeType {
  return (SUPPORTED as readonly string[]).includes(mime);
}

function startsWith(bytes: Uint8Array, magic: readonly number[]): boolean {
  if (bytes.byteLength < magic.length) return false;
  for (let i = 0; i < magic.length; i++) {
    if (bytes[i] !== magic[i]) return false;
  }
  return true;
}

/**
 * The type the bytes actually are, or null when they carry no signature we know.
 *
 * Null is the normal answer for plain text, which has no magic number — so a null
 * result must never be treated as "unsupported", only as "no better information
 * than what was declared".
 */
export function sniffMimeType(bytes: Uint8Array): SupportedMimeType | null {
  if (startsWith(bytes, PDF_MAGIC)) return 'application/pdf';
  if (startsWith(bytes, ZIP_MAGIC)) return DOCX_MIME;
  return null;
}

/**
 * The name of a format we recognise but cannot read, or null.
 *
 * Separate from `sniffMimeType` because the two answers mean opposite things to
 * the caller: one selects a parser, the other selects a refusal. Collapsing them
 * into one nullable string would make it possible to pass an unreadable type to
 * `switch (mime)` and fall through silently.
 */
export function sniffUnreadableType(bytes: Uint8Array): string | null {
  for (const { magic, mime } of UNREADABLE_SIGNATURES) {
    if (startsWith(bytes, magic)) return mime;
  }
  return null;
}

/**
 * Decide which parser to use, given what the client declared and what the bytes
 * say.
 *
 * Precedence, in order:
 *
 *   1. A readable signature. The bytes are the file; a declaration that
 *      contradicts them is just wrong.
 *   2. An unreadable signature. Returned BY NAME so the caller refuses with the
 *      real format ("we do not read .doc") instead of a downstream parser
 *      failure. This also catches a .doc renamed .pdf, which used to reach pdfjs.
 *   3. A supported declaration. No signature to contradict it, so honour it.
 *   4. `text/plain`, but only when the declaration is uninformative. Text is the
 *      one accepted format with no magic number, so it is the only thing a
 *      signature-free file from a clueless client can be.
 *   5. Otherwise the declaration is returned unchanged and the caller refuses it.
 *      A specific unsupported type is INFORMATION, and guessing text over it
 *      turns an accurate "we do not support this format" into a misleading "this
 *      is not readable text".
 *
 * The return type is a plain `string`, not `SupportedMimeType`, precisely because
 * cases 2 and 5 exist. The caller must narrow with `isSupportedMimeType` before
 * choosing a parser — the type system enforces the refusal rather than trusting
 * this function to have made it.
 *
 * Also returns whether the result disagreed with the declaration, so the caller
 * can record the correction. A silent fix that nobody can see is a fix that gets
 * re-broken.
 */
export function resolveMimeType(
  bytes: Uint8Array,
  declared: string
): { mime: string; corrected: boolean } {
  const sniffed = sniffMimeType(bytes);
  if (sniffed) {
    return { mime: sniffed, corrected: sniffed !== declared };
  }

  const unreadable = sniffUnreadableType(bytes);
  if (unreadable) {
    return { mime: unreadable, corrected: unreadable !== declared };
  }

  if (isSupported(declared)) {
    return { mime: declared, corrected: false };
  }

  if (UNINFORMATIVE_DECLARATIONS.includes(declared.toLowerCase().trim())) {
    return { mime: 'text/plain', corrected: true };
  }

  return { mime: declared, corrected: false };
}
