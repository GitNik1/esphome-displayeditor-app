// The RGB565 colour space, as an RGB565 display actually shows it.
//
// 5 bits red, 6 green, 5 blue. Converting back to 8 bits replicates the most
// significant bits (r8 = (r5 << 3) | (r5 >> 2)) so 0b11111 maps exactly onto
// 255 - only then does the editor preview match the device.
//
// Ported from glowline/rgb565.py.

export function rgb888to565(r, g, b) {
  r = Math.max(0, Math.min(255, Math.round(r)));
  g = Math.max(0, Math.min(255, Math.round(g)));
  b = Math.max(0, Math.min(255, Math.round(b)));
  return ((r & 0xf8) << 8) | ((g & 0xfc) << 3) | (b >> 3);
}

export function rgb565to888(value) {
  value &= 0xffff;
  const r5 = (value >> 11) & 0x1f;
  const g6 = (value >> 5) & 0x3f;
  const b5 = value & 0x1f;
  return [
    (r5 << 3) | (r5 >> 2),
    (g6 << 2) | (g6 >> 4),
    (b5 << 3) | (b5 >> 2),
  ];
}

export function quantize565(value) {
  return Number(value) & 0xffff;
}

/** Snap an 8-bit colour to the nearest triple RGB565 can represent. */
export function snap888(r, g, b) {
  return rgb565to888(rgb888to565(r, g, b));
}

export function cssFrom565(value, alpha = 1) {
  const [r, g, b] = rgb565to888(value);
  return alpha >= 1 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${alpha})`;
}

/** Display string, e.g. `0x07FF   #00FFFF   (0,255,255)`. */
export function format565(value) {
  const [r, g, b] = rgb565to888(value);
  const hex = (n) => n.toString(16).toUpperCase().padStart(2, "0");
  return `0x${(value & 0xffff).toString(16).toUpperCase().padStart(4, "0")}   `
    + `#${hex(r)}${hex(g)}${hex(b)}   (${r},${g},${b})`;
}

/** HSV (each 0..1) to 8-bit RGB. */
export function hsvToRgb(h, s, v) {
  if (s <= 0) {
    const c = Math.round(v * 255);
    return [c, c, c];
  }
  h = (((h % 1) + 1) % 1) * 6;
  const i = Math.floor(h);
  const f = h - i;
  const p = v * (1 - s);
  const q = v * (1 - s * f);
  const t = v * (1 - s * (1 - f));
  const table = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]];
  return table[i % 6].map((c) => Math.round(c * 255));
}

/**
 * Quantise every pixel of an ImageData to RGB565 in place.
 *
 * The device stores two bytes per pixel, so an export that skips this step
 * shows banding on the display that the editor never warned about.
 */
export function quantizeImageData(image) {
  const data = image.data;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    const [r, g, b] = snap888(data[i], data[i + 1], data[i + 2]);
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
  }
  return image;
}
