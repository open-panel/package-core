/**
 * The image drawn on a `page.indicator` key.
 *
 * It has to be an image, not a label: hardware like the FIFINE D6 reports
 * `supportsButtonLabels: false` because each key is a small screen, so text
 * only exists inside the artwork. Plain SVG, for the same reason as
 * `createCalibrationPatternImage` — adapters already accept arbitrary image
 * bytes and encode them (fifine-d6 uses sharp, which reads SVG), so core needs
 * no image library and no device-specific knowledge.
 */
export function createPageIndicatorImage(pageNumber: number, pageCount: number): Buffer {
  const size = 256;
  const centre = size / 2;

  const svg = `
<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${size}" height="${size}" fill="#16181c"/>
  <text x="${centre}" y="128" font-family="sans-serif" font-size="104" font-weight="700"
        fill="#ffffff" text-anchor="middle">${pageNumber}</text>
  <line x1="${centre - 46}" y1="160" x2="${centre + 46}" y2="160" stroke="#5b6270" stroke-width="6"/>
  <text x="${centre}" y="202" font-family="sans-serif" font-size="44" font-weight="600"
        fill="#a0a7b2" text-anchor="middle">${pageCount}</text>
</svg>`.trim();

  return Buffer.from(svg, "utf-8");
}
