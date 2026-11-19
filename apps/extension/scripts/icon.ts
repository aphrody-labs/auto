// Programmatic PNG brand icon generator for the browser extension (no checked-in binary images).
import { deflateSync } from "node:zlib";

function png(width: number, height: number, rgba: Uint8Array): Uint8Array {
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    out.set(new TextEncoder().encode(type), 4);
    out.set(data, 8);
    view.setUint32(8 + data.length, Bun.hash.crc32(out.subarray(4, 8 + data.length)));
    return out;
  };
  const ihdr = new Uint8Array(13);
  new DataView(ihdr.buffer).setUint32(0, width);
  new DataView(ihdr.buffer).setUint32(4, height);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const raw = new Uint8Array(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (1 + width * 4) + 1);
  }
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", new Uint8Array()),
  ];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

const PRIMARY: [number, number, number] = [0x05, 0x6b, 0x5b];
const ON_PRIMARY: [number, number, number] = [0xff, 0xff, 0xff];

export function renderIcon(size: number): Uint8Array {
  const samples = 4;
  const radius = 0.22;
  const sampleAt = (x: number, y: number): [number, number, number] | null => {
    const cx = Math.min(Math.max(x, radius), 1 - radius);
    const cy = Math.min(Math.max(y, radius), 1 - radius);
    if ((x - cx) ** 2 + (y - cy) ** 2 > radius * radius) return null;
    const [left, right, top, bottom, fold] = [0.3, 0.7, 0.2, 0.8, 0.14];
    if (
      x >= left &&
      x <= right &&
      y >= top &&
      y <= bottom &&
      !(x > right - fold && y < top + fold && x - (right - fold) > y - top)
    ) {
      const onLine = [0.42, 0.53, 0.64].some(
        (ly, index) => y >= ly && y <= ly + 0.045 && x >= left + 0.07 && x <= right - (index === 2 ? 0.16 : 0.07),
      );
      return onLine ? PRIMARY : ON_PRIMARY;
    }
    return PRIMARY;
  };
  const pixels = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let [sr, sg, sb, sa] = [0, 0, 0, 0];
      for (let j = 0; j < samples; j++) {
        for (let i = 0; i < samples; i++) {
          const c = sampleAt((x + (i + 0.5) / samples) / size, (y + (j + 0.5) / samples) / size);
          if (!c) continue;
          sr += c[0];
          sg += c[1];
          sb += c[2];
          sa++;
        }
      }
      if (sa) {
        pixels.set(
          [Math.round(sr / sa), Math.round(sg / sa), Math.round(sb / sa), Math.round((255 * sa) / (samples * samples))],
          (y * size + x) * 4,
        );
      }
    }
  }
  return png(size, size, pixels);
}
