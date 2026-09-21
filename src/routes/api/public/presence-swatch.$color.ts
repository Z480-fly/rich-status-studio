import { createFileRoute } from "@tanstack/react-router";
import { normalizeHex } from "@/lib/presence";

/**
 * Generates the flat-colour artwork for a presence.
 *
 * Discord's activity payload has no colour field, so a chosen hex colour is
 * published as the activity's large image instead — this is what makes the
 * colour actually visible on a profile.
 *
 * The PNG is written by hand (no image library): a soft diagonal gradient from
 * a lightened tint to the colour itself, so it reads as deliberate artwork
 * rather than a blank block. A given colour always renders identical bytes,
 * which is why it can be cached immutably.
 */

const SIZE = 512;
const SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** One PNG chunk: length, type, data, CRC over type+data. */
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** Raw scanlines: a filter byte plus RGB per pixel. */
function scanlines(rgb: [number, number, number]): Uint8Array {
  const light = rgb.map((v) => Math.round(v + (255 - v) * 0.45)) as [number, number, number];
  const raw = new Uint8Array((SIZE * 3 + 1) * SIZE);
  let p = 0;
  for (let y = 0; y < SIZE; y++) {
    raw[p++] = 0;
    for (let x = 0; x < SIZE; x++) {
      const t = (x + y) / (2 * (SIZE - 1));
      raw[p++] = Math.round(light[0] * (1 - t) + rgb[0] * t);
      raw[p++] = Math.round(light[1] * (1 - t) + rgb[1] * t);
      raw[p++] = Math.round(light[2] * (1 - t) + rgb[2] * t);
    }
  }
  return raw;
}

function buildPng(hex: string, deflate: (input: Uint8Array) => Uint8Array): Uint8Array {
  const rgb: [number, number, number] = [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];

  const ihdr = new Uint8Array(13);
  const header = new DataView(ihdr.buffer);
  header.setUint32(0, SIZE);
  header.setUint32(4, SIZE);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  // bytes 10-12 stay 0: deflate compression, adaptive filtering, no interlace

  const parts = [
    SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflate(scanlines(rgb))),
    chunk("IEND", new Uint8Array(0)),
  ];

  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const png = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    png.set(part, offset);
    offset += part.length;
  }
  return png;
}

export const Route = createFileRoute("/api/public/presence-swatch/$color")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const hex = normalizeHex(String(params.color).replace(/\.png$/i, ""));
        if (!hex) return new Response("Not found", { status: 404 });

        // Imported here so the module stays safe to bundle for the browser.
        const { deflateSync } = await import("node:zlib");
        const png = buildPng(hex, (input) => new Uint8Array(deflateSync(input)));
        // `png` is a freshly allocated, exactly sized view, so its buffer is the
        // whole image. Casting satisfies the DOM `BlobPart` signature, which
        // only accepts an `ArrayBuffer`-backed view.
        const body = new Blob([png.buffer as ArrayBuffer], { type: "image/png" });

        return new Response(body, {
          headers: {
            "content-type": "image/png",
            "content-length": String(png.length),
            "cache-control": "public, max-age=31536000, immutable",
          },
        });
      },
    },
  },
});
