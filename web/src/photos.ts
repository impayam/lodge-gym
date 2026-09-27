// Client-side photo processing (SPEC §8): decode, apply EXIF orientation, resize, re-encode as JPEG.
// Re-encoding through a canvas drops all metadata, including location.

const FULL_MAX = 1600;
const THUMB_MAX = 400;

async function decode(file: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    await img.decode();
    return img;
  } finally {
    // The decoded image stays usable after the URL is revoked.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

function encode(img: HTMLImageElement, max: number, quality: number): Promise<{ blob: Blob; width: number; height: number }> {
  // naturalWidth/Height already reflect EXIF orientation (image-orientation: from-image is the default).
  const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
  const width = Math.max(1, Math.round(img.naturalWidth * scale));
  const height = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return Promise.reject(new Error("canvas"));
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, width, height);
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve({ blob: b, width, height }) : reject(new Error("encode"))), "image/jpeg", quality)
  );
}

export async function processPhoto(file: Blob) {
  const img = await decode(file);
  const full = await encode(img, FULL_MAX, 0.85);
  const thumb = await encode(img, THUMB_MAX, 0.8);
  return { full: full.blob, thumb: thumb.blob, width: full.width, height: full.height };
}
