/**
 * Detect file format from magic bytes (file signature).
 *
 * Returns a standard MIME type string if the first bytes match a known
 * file signature, or `null` when no match is found. The caller should
 * fall back to extension-based detection in that case.
 *
 * ZIP-based container formats (DOCX, XLSX, PPTX, JAR, etc.) all share
 * the same PK\x03\x04 header, so this function returns "application/zip"
 * for those. The caller must still consult the file extension to
 * disambiguate.
 */
export function detectMimeFromBytes(bytes: Uint8Array): string | null {
  if (bytes.length < 12) return null;

  // ── ftyp-box formats (MP4, M4A, MOV, HEIC, AVIF) ───────────────────
  // The ftyp box starts at byte 4; the brand at byte 8 disambiguates.
  if (
    bytes[4] === 0x66 &&
    bytes[5] === 0x74 &&
    bytes[6] === 0x79 &&
    bytes[7] === 0x70
  ) {
    const brand = String.fromCharCode(
      bytes[8],
      bytes[9],
      bytes[10],
      bytes[11],
    );
    // HEIC / HEIF
    if (brand === "heic" || brand === "heix" || brand === "mif1")
      return "image/heic";
    // AVIF
    if (brand === "avif") return "image/avif";
    // M4A / M4B (audio in MP4 container)
    if (brand === "M4A " || brand === "M4B ") return "audio/mp4";
    // QuickTime
    if (brand === "qt  ") return "video/quicktime";
    // Generic MP4
    return "video/mp4";
  }

  // ── PNG: 89 50 4E 47 0D 0A 1A 0A ───────────────────────────────────
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  )
    return "image/png";

  // ── JPEG: FF D8 FF ──────────────────────────────────────────────────
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return "image/jpeg";

  // ── GIF: GIF87a / GIF89a ───────────────────────────────────────────
  if (
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38
  )
    return "image/gif";

  // ── RIFF container: check sub-type at bytes 8-11 ───────────────────
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46
  ) {
    // WebP: RIFF....WEBP
    if (
      bytes[8] === 0x57 &&
      bytes[9] === 0x45 &&
      bytes[10] === 0x42 &&
      bytes[11] === 0x50
    )
      return "image/webp";
    // WAV: RIFF....WAVE
    if (
      bytes[8] === 0x57 &&
      bytes[9] === 0x41 &&
      bytes[10] === 0x56 &&
      bytes[11] === 0x45
    )
      return "audio/wav";
    // AVI: RIFF....AVI
    if (
      bytes[8] === 0x41 &&
      bytes[9] === 0x56 &&
      bytes[10] === 0x49 &&
      bytes[11] === 0x20
    )
      return "video/avi";
  }

  // ── BMP: BM ─────────────────────────────────────────────────────────
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return "image/bmp";

  // ── TIFF: II (little-endian) or MM (big-endian) ────────────────────
  if (
    (bytes[0] === 0x49 &&
      bytes[1] === 0x49 &&
      bytes[2] === 0x2a &&
      bytes[3] === 0x00) ||
    (bytes[0] === 0x4d &&
      bytes[1] === 0x4d &&
      bytes[2] === 0x00 &&
      bytes[3] === 0x2a)
  )
    return "image/tiff";

  // ── PDF: %PDF ───────────────────────────────────────────────────────
  if (
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46
  )
    return "application/pdf";

  // ── ZIP (also DOCX, XLSX, PPTX, JAR, etc.): PK\x03\x04 ───────────
  if (
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    bytes[2] === 0x03 &&
    bytes[3] === 0x04
  )
    return "application/zip";

  // ── GZIP: 1F 8B ────────────────────────────────────────────────────
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) return "application/gzip";

  // ── 7-Zip: 37 7A BC AF 27 1C ──────────────────────────────────────
  if (
    bytes[0] === 0x37 &&
    bytes[1] === 0x7a &&
    bytes[2] === 0xbc &&
    bytes[3] === 0xaf
  )
    return "application/x-7z-compressed";

  // ── FLAC: fLaC ─────────────────────────────────────────────────────
  if (
    bytes[0] === 0x66 &&
    bytes[1] === 0x4c &&
    bytes[2] === 0x61 &&
    bytes[3] === 0x43
  )
    return "audio/flac";

  // ── OGG: OggS ──────────────────────────────────────────────────────
  if (
    bytes[0] === 0x4f &&
    bytes[1] === 0x67 &&
    bytes[2] === 0x67 &&
    bytes[3] === 0x53
  )
    return "audio/ogg";

  // ── MP3: ID3 tag or MPEG sync word (FF FB / FF F3 / FF F2) ────────
  if (
    (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) ||
    (bytes[0] === 0xff &&
      (bytes[1] === 0xfb || bytes[1] === 0xf3 || bytes[1] === 0xf2))
  )
    return "audio/mpeg";

  // ── WebM / MKV: EBML header 1A 45 DF A3 ───────────────────────────
  if (
    bytes[0] === 0x1a &&
    bytes[1] === 0x45 &&
    bytes[2] === 0xdf &&
    bytes[3] === 0xa3
  )
    return "video/webm";

  // ── ICO: 00 00 01 00 ───────────────────────────────────────────────
  if (
    bytes[0] === 0x00 &&
    bytes[1] === 0x00 &&
    bytes[2] === 0x01 &&
    bytes[3] === 0x00
  )
    return "image/vnd.microsoft.icon";

  // ── PE executable: MZ ──────────────────────────────────────────────
  if (bytes[0] === 0x4d && bytes[1] === 0x5a)
    return "application/vnd.microsoft.portable-executable";

  // ── SQLite: "SQLi" (start of "SQLite format 3\0") ─────────────────
  if (
    bytes[0] === 0x53 &&
    bytes[1] === 0x51 &&
    bytes[2] === 0x4c &&
    bytes[3] === 0x69
  )
    return "application/vnd.sqlite3";

  return null;
}

/** MIME types that correspond to ZIP-based container formats.
 *  When magic bytes detect "application/zip", the file may actually
 *  be one of these — the extension is needed to disambiguate. */
const ZIP_BASED_MIMES: ReadonlySet<string> = new Set([
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // .docx
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // .xlsx
  "application/vnd.openxmlformats-officedocument.presentationml.presentation", // .pptx
  "application/java-archive", // .jar
  "application/vnd.android.package-archive", // .apk
  "application/epub+zip", // .epub
  "application/x-scratch-project", // .sb3
]);

/** Extensions that are ZIP-based containers. When magic bytes say
 *  "application/zip" but the extension is one of these, we should
 *  NOT override the browser/extension-derived MIME. */
const ZIP_BASED_EXTENSIONS: ReadonlySet<string> = new Set([
  "docx",
  "xlsx",
  "pptx",
  "jar",
  "apk",
  "epub",
  "odt",
  "ods",
  "odp",
  "sb3",
  "cbz",
]);

/**
 * Cache of detected MIME types per File object. Populated by
 * {@link detectMimeForFile} and consumed by consumers that need
 * the magic-bytes-based MIME without re-reading the file.
 */
const fileDetectedMimes = new WeakMap<File, string | null>();

/**
 * Read the first bytes of a File and detect its MIME via magic bytes.
 * The result is cached in a WeakMap keyed by the File object so that
 * subsequent lookups are free.
 *
 * @returns The detected MIME string, or `null` if unrecognised.
 */
export async function detectMimeForFile(
  file: File,
): Promise<string | null> {
  // Return cached result if available
  if (fileDetectedMimes.has(file)) return fileDetectedMimes.get(file)!;

  const slice = file.slice(0, 16);
  const buf = await slice.arrayBuffer();
  const bytes = new Uint8Array(buf);
  const mime = detectMimeFromBytes(bytes);

  fileDetectedMimes.set(file, mime);
  return mime;
}

/**
 * Pre-scan an array of files and populate the magic-byte MIME cache.
 * Call this once after files are selected / dropped so that all
 * subsequent synchronous lookups via {@link getCachedDetectedMime}
 * are available.
 */
export async function prescanFiles(files: File[]): Promise<void> {
  await Promise.all(files.map((f) => detectMimeForFile(f)));
}

/**
 * Synchronous lookup of a previously-detected MIME (populated by
 * {@link prescanFiles} or {@link detectMimeForFile}).
 *
 * @returns The detected MIME string, `null` if detection found nothing,
 *          or `undefined` if the file was never scanned.
 */
export function getCachedDetectedMime(
  file: File,
): string | null | undefined {
  return fileDetectedMimes.get(file);
}

/**
 * Determine whether a magic-byte detected "application/zip" should
 * be treated as a real ZIP or deferred to extension-based detection
 * because the file is actually a ZIP-based container (DOCX, XLSX, etc.).
 */
export function isZipBasedExtension(ext: string | undefined): boolean {
  if (!ext) return false;
  return ZIP_BASED_EXTENSIONS.has(ext.toLowerCase());
}

export { ZIP_BASED_MIMES };
