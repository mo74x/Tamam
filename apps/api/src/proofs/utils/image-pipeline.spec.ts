import sharp from 'sharp';
import { parseCairoTimestampToUtc } from '../../common/cairo-time.js';
import {
  MAX_IMAGE_BYTES,
  TinyStickerError,
  hammingDistance64,
  prepareReceiptImage,
} from './image-pipeline.js';

describe('Receipt Image Pipeline', () => {
  async function makeGradientPng(width: number, height: number): Promise<Buffer> {
    const buf = Buffer.alloc(width * height * 3);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const val = Math.floor(((x + y) / (width + height)) * 255);
        const idx = (y * width + x) * 3;
        buf[idx] = val;
        buf[idx + 1] = val;
        buf[idx + 2] = val;
      }
    }
    return sharp(buf, { raw: { width, height, channels: 3 } }).png().toBuffer();
  }

  it('produces near-identical 64-bit dHash after WhatsApp-style JPEG re-compression', async () => {
    const original = await makeGradientPng(800, 1400);
    const recompressed = await sharp(original).resize(600).jpeg({ quality: 55 }).toBuffer();

    const a = await prepareReceiptImage(original);
    const b = await prepareReceiptImage(recompressed);

    expect(a.sha256).not.toBe(b.sha256);
    expect(hammingDistance64(a.phash64, b.phash64)).toBeLessThanOrEqual(4);
    expect(a.phash64 >= -(2n ** 63n) && a.phash64 <= 2n ** 63n - 1n).toBe(true);
  });

  it('skips tiny <120px non-receipt stickers and rejects >25 MP pixel bombs and >10 MB buffers', async () => {
    const sticker = await makeGradientPng(64, 64);
    await expect(prepareReceiptImage(sticker)).rejects.toThrow(TinyStickerError);

    // 5500 x 5500 = 30.25 MP (> 25 MP limit) compressed cleanly as flat PNG
    const hugePixels = await sharp({
      create: { width: 5500, height: 5500, channels: 3, background: { r: 255, g: 255, b: 255 } },
    })
      .png({ compressionLevel: 9 })
      .toBuffer();
    await expect(prepareReceiptImage(hugePixels)).rejects.toThrow(/pixel limit/i);

    const oversized = Buffer.alloc(MAX_IMAGE_BYTES + 1);
    await expect(prepareReceiptImage(oversized)).rejects.toThrow(/10 MB/);
  });

  it('parses Arabic Cairo receipt timestamps to UTC', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-26T12:00:00Z'));
    try {
      const utc = parseCairoTimestampToUtc('٢٦/١١/٢٠٢٦ ٠٢:١٥ م');
      expect(utc).not.toBeNull();
      expect(utc?.toISOString()).toBe('2026-11-26T12:15:00.000Z');
    } finally {
      vi.useRealTimers();
    }
  });
});
