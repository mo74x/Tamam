import sharp from 'sharp';
import { parseCairoTimestampToUtc } from '../../common/cairo-time.js';
import { hammingDistance64, prepareReceiptImage } from './image-pipeline.js';

describe('Receipt Image Pipeline', () => {
  async function makeGradientPng(width: number, height: number, invert = false): Promise<Buffer> {
    const buf = Buffer.alloc(width * height * 3);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const val = Math.floor(((x + y) / (width + height)) * 255);
        const c = invert ? 255 - val : val;
        const idx = (y * width + x) * 3;
        buf[idx] = c;
        buf[idx + 1] = c;
        buf[idx + 2] = c;
      }
    }
    return sharp(buf, { raw: { width, height, channels: 3 } }).png().toBuffer();
  }

  it('produces near-identical 64-bit dHash after WhatsApp-style JPEG re-compression', async () => {
    const original = await makeGradientPng(800, 1400);
    const recompressed = await sharp(original).resize(600).jpeg({ quality: 55 }).toBuffer();

    const a = await prepareReceiptImage(original);
    const b = await prepareReceiptImage(recompressed);

    expect(a.sha256).not.toBe(b.sha256); // Bytes changed
    expect(hammingDistance64(a.phash64, b.phash64)).toBeLessThanOrEqual(4); // Visually same
    expect(a.phash64 >= -(2n ** 63n) && a.phash64 <= 2n ** 63n - 1n).toBe(true);
  });

  it('parses Arabic Cairo receipt timestamps to UTC', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-26T12:00:00Z'));
    try {
      const utc = parseCairoTimestampToUtc('٢٦/١١/٢٠٢٦ ٠٢:١٥ م');
      expect(utc).not.toBeNull();
      // November in Egypt is EET (UTC+2) -> 14:15 Cairo = 12:15 UTC
      expect(utc?.toISOString()).toBe('2026-11-26T12:15:00.000Z');
    } finally {
      vi.useRealTimers();
    }
  });
});