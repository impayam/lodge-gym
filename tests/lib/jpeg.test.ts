import { describe, expect, it } from "vitest";
import { hasExif, isJpeg, stripJpegMetadata } from "../../worker/lib/jpeg";
import { fakeJpeg } from "../fixtures/jpeg";

describe("jpeg metadata stripping", () => {
  it("removes EXIF (with GPS), XMP and comments; keeps JFIF and image data", () => {
    const src = fakeJpeg({ exif: true, xmp: true, comment: true });
    expect(hasExif(src)).toBe(true);
    const out = stripJpegMetadata(src);
    expect(isJpeg(out)).toBe(true);
    expect(hasExif(out)).toBe(false);
    const text = new TextDecoder("latin1").decode(out);
    expect(text).not.toContain("Exif");
    expect(text).not.toContain("GPS");
    expect(text).not.toContain("http://ns.adobe.com/xap");
    expect(text).not.toContain("secret comment");
    expect(text).toContain("JFIF");
    expect(Array.from(out.slice(-2))).toEqual([0xff, 0xd9]);
    expect(out.length).toBeLessThan(src.length);
  });
  it("leaves clean files and non-JPEG input unchanged", () => {
    const clean = fakeJpeg({});
    expect(stripJpegMetadata(clean)).toEqual(clean);
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    expect(isJpeg(png)).toBe(false);
    expect(stripJpegMetadata(png)).toBe(png);
  });
});
