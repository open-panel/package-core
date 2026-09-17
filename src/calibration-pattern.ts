/**
 * A generated (not user-supplied) reference icon shown on every button while
 * a device is in calibration mode (see ProfileRuntime#enterCalibrationMode).
 * A border frame right at the edge makes bezel clipping obvious, the
 * concentric rings + crosshair make off-center content obvious, and the
 * position number doubles as a sanity check that positions aren't scrambled.
 *
 * This is plain SVG text, not a rendered raster — device adapters already
 * accept arbitrary image bytes and resize/encode them (e.g. fifine-d6's
 * `encodeButtonImage` uses `sharp`, which reads SVG directly), so no image
 * library is needed here and no FIFINE-specific knowledge leaks into core
 * (specs.md #9).
 */
export function createCalibrationPatternImage(position: number): Buffer {
  const size = 256;
  const c = size / 2;
  const svg = `
<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${size}" height="${size}" fill="#111318"/>
  <rect x="4" y="4" width="${size - 8}" height="${size - 8}" fill="none" stroke="#e74c3c" stroke-width="8"/>
  <circle cx="${c}" cy="${c}" r="${c * 0.7}" fill="none" stroke="#f1c40f" stroke-width="5"/>
  <circle cx="${c}" cy="${c}" r="${c * 0.4}" fill="none" stroke="#2ecc71" stroke-width="5"/>
  <line x1="${c}" y1="12" x2="${c}" y2="${size - 12}" stroke="#3498db" stroke-width="3"/>
  <line x1="12" y1="${c}" x2="${size - 12}" y2="${c}" stroke="#3498db" stroke-width="3"/>
  <text x="${c}" y="${c + 20}" font-size="64" font-family="sans-serif" font-weight="700" fill="#ffffff" text-anchor="middle">${position + 1}</text>
</svg>`.trim();
  return Buffer.from(svg, "utf-8");
}
