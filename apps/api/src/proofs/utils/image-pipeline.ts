import { createHash } from 'crypto';
import sharp from 'sharp';

const EDITING_SOFTWARE_RE =
  /(photoshop|canva|picsart|gimp|snapseed|lightroom|figma|illustrator|pixlr)/i;

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 25_000_000;
export const MIN_RECEIPT_DIMENSION = 120;

export class TinyStickerError extends Error {
  constructor(width?: number, height?: number) {
    super(`Skipping tiny non-receipt image (${width ?? '?'}x${height ?? '?'})`);
  }
}

export interface PreparedImage {
  sha256: string;
  phash64: bigint; // Signed 64-bit int for PostgreSQL BIGINT + bit_count(a # b)
  resizedJpeg: Buffer;
  forensics: {
    originalFormat?: string;
    width?: number;
    height?: number;
    hasExif: boolean;
    editingSoftwareFlag: string | null;
  };
}

export async function prepareReceiptImage(rawBuffer: Buffer): Promise<PreparedImage> {
  if (rawBuffer.length > MAX_IMAGE_BYTES) {
    throw new Error('Image exceeds 10 MB safety limit');
  }

  const sha256 = createHash('sha256').update(rawBuffer).digest('hex');

  const meta = await sharp(rawBuffer, { limitInputPixels: MAX_IMAGE_PIXELS }).metadata();
  if (
    meta.width !== undefined &&
    meta.height !== undefined &&
    Math.min(meta.width, meta.height) < MIN_RECEIPT_DIMENSION
  ) {
    throw new TinyStickerError(meta.width, meta.height);
  }

  const exifText = meta.exif ? meta.exif.toString('latin1') : '';
  const softwareMatch = exifText.match(EDITING_SOFTWARE_RE);

  // 1) Resized JPEG for cheap vision inference + compact S3/R2 archival
  const resizedJpeg = await sharp(rawBuffer, { limitInputPixels: MAX_IMAGE_PIXELS })
    .rotate() // Respect EXIF orientation before stripping metadata
    .resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 82, mozjpeg: true })
    .toBuffer();

  // 2) 64-bit difference hash (dHash): resilient to WhatsApp JPEG re-encoding & scaling
  const { data: pixels } = await sharp(resizedJpeg)
    .removeAlpha()
    .grayscale()
    .resize(9, 8, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });

  let unsignedHash = 0n;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const left = pixels[y * 9 + x];
      const right = pixels[y * 9 + x + 1];
      unsignedHash = (unsignedHash << 1n) | (left > right ? 1n : 0n);
    }
  }

  return {
    sha256,
    phash64: BigInt.asIntN(64, unsignedHash),
    resizedJpeg,
    forensics: {
      originalFormat: meta.format,
      width: meta.width,
      height: meta.height,
      hasExif: Boolean(meta.exif),
      editingSoftwareFlag: softwareMatch ? softwareMatch[1].toLowerCase() : null,
    },
  };
}

export function hammingDistance64(a: bigint, b: bigint): number {
  let xor = BigInt.asUintN(64, a ^ b);
  let count = 0;
  while (xor > 0n) {
    xor &= xor - 1n;
    count++;
  }
  return count;
}
