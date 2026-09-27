// Minimal JPEG handling for progress photos: validation and metadata stripping (defence in depth; the client
// already re-encodes through a canvas, which drops EXIF including location).

export function isJpeg(b: Uint8Array): boolean {
  return b.length > 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
}

/**
 * Removes APP1–APP15 (EXIF, XMP, ICC, maker notes…) and COM segments. APP0 (JFIF) and all image data are kept.
 * Returns the input unchanged when it cannot be parsed safely.
 */
export function stripJpegMetadata(b: Uint8Array): Uint8Array {
  if (!isJpeg(b)) return b;
  const out: Uint8Array[] = [b.subarray(0, 2)];
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return b;
    const marker = b[i + 1];
    if (marker === 0xff) {
      i++;
      continue;
    }
    if (marker === 0xda) {
      // Start of scan: the rest is entropy-coded data up to EOI.
      out.push(b.subarray(i));
      break;
    }
    if (marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      out.push(b.subarray(i, i + 2));
      i += 2;
      continue;
    }
    const len = (b[i + 2] << 8) | b[i + 3];
    if (len < 2 || i + 2 + len > b.length) return b;
    const drop = (marker >= 0xe1 && marker <= 0xef) || marker === 0xfe;
    if (!drop) out.push(b.subarray(i, i + 2 + len));
    i += 2 + len;
  }
  const size = out.reduce((n, p) => n + p.length, 0);
  const res = new Uint8Array(size);
  let o = 0;
  for (const p of out) {
    res.set(p, o);
    o += p.length;
  }
  return res;
}

/** True when the JPEG still carries an EXIF APP1 segment. */
export function hasExif(b: Uint8Array): boolean {
  let i = 2;
  while (i + 10 <= b.length && b[i] === 0xff) {
    const marker = b[i + 1];
    if (marker === 0xda) return false;
    const len = (b[i + 2] << 8) | b[i + 3];
    if (marker === 0xe1 && String.fromCharCode(...b.subarray(i + 4, i + 8)) === "Exif") return true;
    i += 2 + len;
  }
  return false;
}
