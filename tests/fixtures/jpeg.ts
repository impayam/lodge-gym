// Builds JPEG byte streams with metadata segments for tests (structure only; the scan data is dummy).

const seg = (marker: number, payload: Uint8Array) => {
  const len = payload.length + 2;
  return new Uint8Array([0xff, marker, len >> 8, len & 255, ...payload]);
};
const ascii = (s: string) => new Uint8Array([...s].map((c) => c.charCodeAt(0)));

export function fakeJpeg(opts: { exif?: boolean; xmp?: boolean; comment?: boolean }): Uint8Array {
  const parts: Uint8Array[] = [new Uint8Array([0xff, 0xd8])];
  parts.push(seg(0xe0, new Uint8Array([...ascii("JFIF"), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0])));
  if (opts.exif) parts.push(seg(0xe1, new Uint8Array([...ascii("Exif"), 0, 0, ...ascii("MM\0*GPSLatitude 39.7392 N GPSLongitude 104.9903 W")])));
  if (opts.xmp) parts.push(seg(0xe1, ascii("http://ns.adobe.com/xap/1.0/\0<x:xmpmeta/>")));
  if (opts.comment) parts.push(seg(0xfe, ascii("secret comment")));
  parts.push(seg(0xdb, new Uint8Array(65)));
  parts.push(new Uint8Array([0xff, 0xda, 0, 8, 1, 1, 0, 0, 0x3f, 0, 0x12, 0x34, 0x56, 0xff, 0x00, 0x78, 0xff, 0xd9]));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
