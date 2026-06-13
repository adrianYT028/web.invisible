import { ImageResponse } from 'next/og';

/**
 * Dynamic Open Graph / social-share image for the site root.
 *
 * Next.js picks this file up by convention and injects the generated PNG as
 * `og:image` (and, via twitter-image.tsx, `twitter:image`). A branded share
 * card matters for both reach and GEO: link unfurls in Slack/Discord/X and
 * the preview cards some AI answer engines render now show a designed card
 * instead of a blank or cropped logo.
 *
 * Rendered with the same ink palette as the site (near-black paper, bone
 * text, a single accent rule) so the card reads as part of the brand. No
 * external font fetch — the default sans keeps the build fast and reliable.
 */
export const alt =
  'Unviewable — a 100% unviewable AI assistant for interviews and meetings';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          background: '#0A0A0B',
          padding: '72px 80px',
          fontFamily: 'sans-serif',
        }}
      >
        {/* Top row: wordmark + status pill */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            width: '100%',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              fontSize: 26,
              letterSpacing: 8,
              color: '#EDECE8',
              fontWeight: 600,
            }}
          >
            UNVIEWABLE
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              fontSize: 20,
              letterSpacing: 4,
              color: '#4DE39A',
            }}
          >
            {/* CSS circle instead of a ● glyph — avoids a dynamic font fetch
                for a character the default sans doesn't carry. */}
            <div
              style={{
                width: 14,
                height: 14,
                borderRadius: 7,
                background: '#4DE39A',
              }}
            />
            STEALTH ON
          </div>
        </div>

        {/* Headline */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <div
            style={{
              fontSize: 84,
              lineHeight: 1.05,
              color: '#EDECE8',
              fontWeight: 700,
              letterSpacing: -2,
            }}
          >
            The intelligence
          </div>
          <div
            style={{
              fontSize: 84,
              lineHeight: 1.05,
              color: '#EDECE8',
              fontWeight: 700,
              letterSpacing: -2,
            }}
          >
            they can&apos;t see.
          </div>
        </div>

        {/* Bottom row: positioning line */}
        <div
          style={{
            display: 'flex',
            fontSize: 28,
            color: '#A3A29B',
            lineHeight: 1.4,
            maxWidth: 900,
          }}
        >
          A 100% unviewable AI assistant for high-stakes interviews and
          meetings. Bypasses every screen-capture pipeline.
        </div>
      </div>
    ),
    { ...size },
  );
}
