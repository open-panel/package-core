import {
  actionIconGlyph,
  DEFAULT_ACTION_ICON_GLYPH,
  type ActionIconState,
} from "@open-panel/shared";

/**
 * The image drawn on a key that has an action but no custom icon — the
 * physical-device equivalent of apps/desktop's `ActionTypeIcon` fallback, so
 * a configured key never renders blank just because nobody picked artwork
 * for it. Plain SVG for the same reason as `createPageIndicatorImage`:
 * device adapters already accept arbitrary image bytes and encode them.
 *
 * The config is passed through because some actions draw themselves from it —
 * "Multimedia" shows the media key it sends, so a row of them is readable —
 * and `state` for what the config cannot say, like which way a "Hotkey Switch"
 * is currently flipped.
 */
export function createActionIconImage(
  actionType: string,
  config?: Record<string, unknown>,
  state?: ActionIconState,
): Buffer {
  const size = 256;
  const glyphSize = 160;
  const scale = glyphSize / 20;
  const offset = (size - glyphSize) / 2;
  const glyph = actionIconGlyph(actionType, config, state) ?? DEFAULT_ACTION_ICON_GLYPH;

  const svg = `
<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${size}" height="${size}" fill="#16181c"/>
  <g transform="translate(${offset} ${offset}) scale(${scale})" fill="none" color="#ffffff" stroke="#ffffff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
    ${glyph}
  </g>
</svg>`.trim();

  return Buffer.from(svg, "utf-8");
}
