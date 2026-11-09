/**
 * REAL type of an uploaded file, by its content
 * ============================================================================
 *
 * Upload stored the `Content-Type` the client sent and the name it
 * chose (`photo.html`, `logo.svg`). Neither says what is inside:
 * the uploader decides both. `/media/*` serves each file with the type of its
 * EXTENSION, so an HTML or an SVG with `<script>` uploaded as an "image" was
 * opened as a page on the API origin.
 *
 * Here the signature of the first bytes ("magic bytes") is checked and only
 * image, video and PDF formats that execute nothing are accepted. The extension
 * it is saved with comes from what was DETECTED, not from the original name.
 *
 * SVG is not accepted: it is XML and can carry `<script>`, `<foreignObject>` and
 * `on*` handlers. The image mirror already rasterizes them for the same reason (see
 * the notes on local image hosting). If it is ever needed, rasterize on upload.
 */

export interface DetectedType {
  mime: string;
  extension: string;
}

const starts = (b: Uint8Array, signature: number[], from = 0): boolean =>
  b.length >= from + signature.length && signature.every((x, i) => b[from + i] === x);

const ascii = (b: Uint8Array, from: number, long: number): string =>
  String.fromCharCode(...b.subarray(from, from + long));

/** Accepted formats, detected by content. `null` if it is none of them. */
export function detectRealType(content: Uint8Array): DetectedType | null {
  const b = content;
  if (starts(b, [0xff, 0xd8, 0xff])) return { mime: "image/jpeg", extension: "jpg" };
  if (starts(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { mime: "image/png", extension: "png" };
  }
  if (ascii(b, 0, 6) === "GIF87a" || ascii(b, 0, 6) === "GIF89a") {
    return { mime: "image/gif", extension: "gif" };
  }
  if (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") {
    return { mime: "image/webp", extension: "webp" };
  }
  // ISO-BMFF: `....ftyp<brand>`. AVIF is an image; the other brands, MP4 video.
  if (b.length >= 12 && ascii(b, 4, 4) === "ftyp") {
    const mark = ascii(b, 8, 4);
    if (mark === "avif" || mark === "avis") return { mime: "image/avif", extension: "avif" };
    if (/^(isom|iso[2-9]|mp41|mp42|avc1|M4V |M4A |dash|f4v )$/.test(mark)) {
      return { mime: "video/mp4", extension: "mp4" };
    }
    return null;
  }
  if (starts(b, [0x1a, 0x45, 0xdf, 0xa3])) return { mime: "video/webm", extension: "webm" };
  if (ascii(b, 0, 5) === "%PDF-") return { mime: "application/pdf", extension: "pdf" };
  return null;
}

/**
 * Name that is SAVED: no paths, no odd characters and with the extension of the
 * detected type. Normalizes unicode (NFKC) before filtering, so that a
 * full-width `．．／` does not survive as something resembling `../`.
 */
export function safeName(original: string, type: DetectedType): string {
  const base = String(original ?? "")
    .normalize("NFKC")
    .split(/[\\/]/)
    .pop()!
    .replace(/\.[^.]*$/, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^[_-]+|[_-]+$/g, "")
    .slice(0, 80);
  return `${base || "file"}.${type.extension}`;
}
