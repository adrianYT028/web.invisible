'use client';

/** Opens the browser print dialog, where "Save as PDF" produces the PDF. */
export function PrintButton() {
  return (
    <button type="button" className="cta cta-primary" onClick={() => window.print()}>
      Save as PDF
    </button>
  );
}
