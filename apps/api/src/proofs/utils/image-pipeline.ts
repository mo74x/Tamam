import { createHash } from 'crypto';
import sharp from 'sharp';

const EDITING_SOFTWARE_RE = /(photoshop|canva|picsart|gimp|snapseed|lightroom|figma|illustrator|pixlr)/i;

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
  const sha256 = createHash('sha256').update(rawBuffer).digest('hex');

  const meta = await sharp(rawBuffer).metadata();
  const exifText = meta.exif ? meta.exif.toString('latin1') : '';
  const softwareMatch = exifText.match(EDITING_SOFTWARE_RE);

  // 1) Resized JPEG for cheap vision inference + compact S3/R2 archival
  const resizedJpeg = await sharp(rawBuffer)
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