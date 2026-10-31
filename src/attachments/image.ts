import { AppError } from '../http/errors.ts';
import { imageMediaTypes, type ImageMediaType } from './store.ts';

/** Claude refuses images with a side over 8000px, so an upload that large would fail the turn later. */
export const maxImageDimension = 8000;

export interface ImageInfo {
  readonly mediaType: ImageMediaType;
  readonly width: number;
  readonly height: number;
}

const invalid = (message: string) => new AppError({ code: 'attachment/invalid-image', statusCode: 400, message });

/**
 * Reads the real format and size from the bytes, independent of the declared
 * Content-Type. Anything whose header does not decode as one of the accepted
 * formats is refused, so a document, script or SVG can never be stored as an image.
 */
export function inspectImage(data: Buffer): ImageInfo {
  if (data.length >= 24 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    if (data.toString('latin1', 12, 16) !== 'IHDR') throw invalid('The PNG file is malformed.');
    return { mediaType: 'image/png', width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  }
  if (data.length >= 10 && (data.toString('latin1', 0, 6) === 'GIF87a' || data.toString('latin1', 0, 6) === 'GIF89a')) {
    return { mediaType: 'image/gif', width: data.readUInt16LE(6), height: data.readUInt16LE(8) };
  }
  if (data.length >= 30 && data.toString('latin1', 0, 4) === 'RIFF' && data.toString('latin1', 8, 12) === 'WEBP') {
    const chunk = data.toString('latin1', 12, 16);
    if (chunk === 'VP8 ') return { mediaType: 'image/webp', width: data.readUInt16LE(26) & 0x3fff, height: data.readUInt16LE(28) & 0x3fff };
    if (chunk === 'VP8L') {
      const bits = data.readUInt32LE(21);
      return { mediaType: 'image/webp', width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (chunk === 'VP8X') return { mediaType: 'image/webp', width: data.readUIntLE(24, 3) + 1, height: data.readUIntLE(27, 3) + 1 };
    throw invalid('The WebP file is malformed.');
  }
  if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < data.length) {
      if (data[offset] !== 0xff) throw invalid('The JPEG file is malformed.');
      const marker = data[offset + 1]!;
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01 || marker === 0xff) { offset += marker === 0xff ? 1 : 2; continue; }
      const length = data.readUInt16BE(offset + 2);
      if (length < 2) throw invalid('The JPEG file is malformed.');
      const isStartOfFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isStartOfFrame) return { mediaType: 'image/jpeg', height: data.readUInt16BE(offset + 5), width: data.readUInt16BE(offset + 7) };
      if (marker === 0xda || marker === 0xd9) break;
      offset += 2 + length;
    }
    throw invalid('The JPEG file is malformed.');
  }
  throw invalid(`The file is not a ${imageMediaTypes.map((type) => type.slice(6).toUpperCase()).join(', ')} image.`);
}

/** The bytes must be what the request says they are; a mismatch is a lie, not a hint. */
export function assertImageMatches(info: ImageInfo, declared: ImageMediaType): void {
  if (info.mediaType !== declared) throw invalid(`The file is ${info.mediaType}, not ${declared}.`);
  if (info.width === 0 || info.height === 0) throw invalid('The image has no pixels.');
  if (info.width > maxImageDimension || info.height > maxImageDimension) {
    throw invalid(`Images must be at most ${maxImageDimension}px on each side.`);
  }
}

const keptPngChunks = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'gAMA', 'cHRM', 'sRGB', 'iCCP', 'sBIT', 'bKGD', 'pHYs', 'acTL', 'fcTL', 'fdAT']);

/**
 * Drops embedded metadata — EXIF (camera, GPS), XMP, comments — before storage,
 * so a user's photo carries nothing to the model or back to the browser that the
 * picture itself does not show. Pixel data is untouched; GIF and WebP carry no
 * common metadata segments worth the risk of re-muxing them here.
 */
export function stripMetadata(data: Buffer, mediaType: ImageMediaType): Buffer {
  if (mediaType === 'image/jpeg') {
    const parts: Buffer[] = [data.subarray(0, 2)];
    let offset = 2;
    while (offset + 4 <= data.length) {
      if (data[offset] !== 0xff) break;
      const marker = data[offset + 1]!;
      if (marker === 0xda) { parts.push(data.subarray(offset)); return Buffer.concat(parts); }
      const length = data.readUInt16BE(offset + 2);
      const end = offset + 2 + length;
      const isMetadata = (marker >= 0xe1 && marker <= 0xef && marker !== 0xee) || marker === 0xfe;
      if (!isMetadata) parts.push(data.subarray(offset, end));
      offset = end;
    }
    return Buffer.concat([...parts, data.subarray(offset)]);
  }
  if (mediaType === 'image/png') {
    const parts: Buffer[] = [data.subarray(0, 8)];
    let offset = 8;
    while (offset + 12 <= data.length) {
      const length = data.readUInt32BE(offset);
      const type = data.toString('latin1', offset + 4, offset + 8);
      const end = offset + 12 + length;
      if (keptPngChunks.has(type)) parts.push(data.subarray(offset, Math.min(end, data.length)));
      offset = end;
    }
    return Buffer.concat(parts);
  }
  return data;
}
