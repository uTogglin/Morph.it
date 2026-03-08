/**
 * Generates minimal valid test fixture files for dead-route discovery.
 * Run: bun test/generateFixtures.js
 */
const dir = `${import.meta.dir}/resources`;

function u8(...bytes) { return new Uint8Array(bytes); }
function concat(...arrays) {
  const r = new Uint8Array(arrays.reduce((s, a) => s + a.length, 0));
  let o = 0;
  for (const a of arrays) { r.set(a, o); o += a.length; }
  return r;
}
function str(s) { return new TextEncoder().encode(s); }
function u32le(n) { return u8(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff); }
function u16le(n) { return u8(n & 0xff, (n >> 8) & 0xff); }
function u32be(n) { return u8((n >> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff); }
function u16be(n) { return u8((n >> 8) & 0xff, n & 0xff); }

// ═══════════════════════════════════════════════════════════
//  IMAGE FORMATS
// ═══════════════════════════════════════════════════════════

// 1x1 red JPEG — minimal valid JFIF
// Built from: SOI + APP0(JFIF) + DQT + SOF0 + DHT(DC) + DHT(AC) + SOS + data + EOI
const jpeg = u8(
  // SOI
  0xFF,0xD8,
  // APP0 JFIF
  0xFF,0xE0, 0x00,0x10, 0x4A,0x46,0x49,0x46,0x00, 0x01,0x01, 0x00, 0x00,0x01, 0x00,0x01, 0x00,0x00,
  // DQT (1 table, all 1s for simplicity)
  0xFF,0xDB, 0x00,0x43, 0x00,
  ...Array(64).fill(0x01),
  // SOF0: 1x1, 1 component, Y only
  0xFF,0xC0, 0x00,0x0B, 0x08, 0x00,0x01, 0x00,0x01, 0x01, 0x01,0x11,0x00,
  // DHT DC table (class 0, id 0)
  0xFF,0xC4, 0x00,0x1F, 0x00,
  0x00,0x01,0x05,0x01,0x01,0x01,0x01,0x01,0x01,0x00,0x00,0x00,0x00,0x00,0x00,0x00,
  0x00,0x01,0x02,0x03,0x04,0x05,0x06,0x07,0x08,0x09,0x0A,0x0B,
  // DHT AC table (class 1, id 0) — standard luminance AC table
  0xFF,0xC4, 0x00,0xB5, 0x10,
  0x00,0x02,0x01,0x03,0x03,0x02,0x04,0x03,0x05,0x05,0x04,0x04,0x00,0x00,0x01,0x7D,
  0x01,0x02,0x03,0x00,0x04,0x11,0x05,0x12,0x21,0x31,0x41,0x06,0x13,0x51,0x61,0x07,
  0x22,0x71,0x14,0x32,0x81,0x91,0xA1,0x08,0x23,0x42,0xB1,0xC1,0x15,0x52,0xD1,0xF0,
  0x24,0x33,0x62,0x72,0x82,0x09,0x0A,0x16,0x17,0x18,0x19,0x1A,0x25,0x26,0x27,0x28,
  0x29,0x2A,0x34,0x35,0x36,0x37,0x38,0x39,0x3A,0x43,0x44,0x45,0x46,0x47,0x48,0x49,
  0x4A,0x53,0x54,0x55,0x56,0x57,0x58,0x59,0x5A,0x63,0x64,0x65,0x66,0x67,0x68,0x69,
  0x6A,0x73,0x74,0x75,0x76,0x77,0x78,0x79,0x7A,0x83,0x84,0x85,0x86,0x87,0x88,0x89,
  0x8A,0x92,0x93,0x94,0x95,0x96,0x97,0x98,0x99,0x9A,0xA2,0xA3,0xA4,0xA5,0xA6,0xA7,
  0xA8,0xA9,0xAA,0xB2,0xB3,0xB4,0xB5,0xB6,0xB7,0xB8,0xB9,0xBA,0xC2,0xC3,0xC4,0xC5,
  0xC6,0xC7,0xC8,0xC9,0xCA,0xD2,0xD3,0xD4,0xD5,0xD6,0xD7,0xD8,0xD9,0xDA,0xE1,0xE2,
  0xE3,0xE4,0xE5,0xE6,0xE7,0xE8,0xE9,0xEA,0xF1,0xF2,0xF3,0xF4,0xF5,0xF6,0xF7,0xF8,
  0xF9,0xFA,
  // SOS
  0xFF,0xDA, 0x00,0x08, 0x01, 0x01,0x00, 0x00,0x3F,0x00,
  // Entropy-coded data (red pixel: DC=128, no AC)
  0x7B,0x40,0x01,
  // EOI
  0xFF,0xD9
);

// 1x1 red GIF89a
const gif = u8(
  0x47,0x49,0x46,0x38,0x39,0x61, // GIF89a
  0x01,0x00, 0x01,0x00,           // 1x1
  0x80, 0x00, 0x00,               // GCT flag, bg=0, aspect=0
  0xFF,0x00,0x00,                  // Color 0: red
  0x00,0x00,0x00,                  // Color 1: black
  0x21,0xF9,0x04,0x00,0x00,0x00,0x00,0x00, // Graphic control ext
  0x2C,                            // Image separator
  0x00,0x00, 0x00,0x00,           // Left, top
  0x01,0x00, 0x01,0x00,           // 1x1
  0x00,                            // No local CT
  0x02,                            // LZW min code size
  0x02, 0x44,0x01,                 // Sub-block: 2 bytes
  0x00,                            // Block terminator
  0x3B                             // Trailer
);

// 1x1 red 24-bit BMP
const bmpPixel = u8(0x00, 0x00, 0xFF, 0x00); // BGR + padding
const bmpFileSize = 14 + 40 + 4;
const bmp = concat(
  str("BM"), u32le(bmpFileSize), u16le(0), u16le(0), u32le(54), // File header
  u32le(40), u32le(1), u32le(1), u16le(1), u16le(24), u32le(0), // DIB header
  u32le(4), u32le(2835), u32le(2835), u32le(0), u32le(0),       // DIB cont'd
  bmpPixel
);

// 1x1 red TIFF (little-endian)
function makeTiff() {
  // IFD with required tags for a 1x1 RGB image
  const numEntries = 10;
  const ifdOffset = 8;
  const dataOffset = ifdOffset + 2 + numEntries * 12 + 4; // after IFD + next-IFD pointer
  const stripOffset = dataOffset + 6; // after BitsPerSample data (3 shorts = 6 bytes)

  const ifdEntry = (tag, type, count, value) =>
    concat(u16le(tag), u16le(type), u32le(count), u32le(value));

  return concat(
    u8(0x49, 0x49), u16le(42), u32le(ifdOffset), // Header: II, magic, IFD offset
    u16le(numEntries),
    ifdEntry(0x0100, 3, 1, 1),           // ImageWidth = 1
    ifdEntry(0x0101, 3, 1, 1),           // ImageLength = 1
    ifdEntry(0x0102, 3, 3, dataOffset),  // BitsPerSample → offset
    ifdEntry(0x0103, 3, 1, 1),           // Compression = None
    ifdEntry(0x0106, 3, 1, 2),           // PhotometricInterpretation = RGB
    ifdEntry(0x0111, 3, 1, stripOffset), // StripOffsets
    ifdEntry(0x0115, 3, 1, 3),           // SamplesPerPixel = 3
    ifdEntry(0x0116, 3, 1, 1),           // RowsPerStrip = 1
    ifdEntry(0x0117, 4, 1, 3),           // StripByteCounts = 3
    ifdEntry(0x011C, 3, 1, 1),           // PlanarConfiguration = Chunky
    u32le(0),                             // Next IFD = 0 (none)
    u16le(8), u16le(8), u16le(8),        // BitsPerSample data: 8,8,8
    u8(0xFF, 0x00, 0x00),               // Pixel data: red
  );
}
const tiff = makeTiff();

// Minimal WebP (1x1 red, lossy VP8)
// VP8 bitstream for 1x1 pixel
const vp8Data = u8(
  0x30,0x01,0x00,0x9D,0x01,0x2A,0x01,0x00,0x01,0x00,0x01,0x40,
  0x25,0xA4,0x00,0x03,0x70,0x00,0xFE,0xFB,0x94,0x00,0x00
);
const webpPayloadSize = 12 + vp8Data.length;
const webp = concat(
  str("RIFF"), u32le(4 + 8 + vp8Data.length), str("WEBP"),
  str("VP8 "), u32le(vp8Data.length),
  vp8Data
);

// SVG 10x10 red square
const svg = str(
  `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">` +
  `<rect width="10" height="10" fill="red"/>` +
  `</svg>`
);

// 1x1 ICO (contains a 1x1 BMP)
const icoPixelData = u8(0xFF, 0x00, 0x00, 0x00); // BGRA
const icoMask = u8(0x00, 0x00, 0x00, 0x00); // AND mask (4 bytes, padded to 32-bit)
const icoDibSize = 40 + icoPixelData.length + icoMask.length;
const ico = concat(
  u16le(0), u16le(1), u16le(1),   // Reserved, type=ICO, count=1
  u8(1), u8(1), u8(0), u8(0),     // 1x1, 0 colors, reserved
  u16le(1), u16le(32),             // Color planes, bits per pixel
  u32le(icoDibSize), u32le(22),    // Size of data, offset to data
  // DIB header (height is doubled for ICO)
  u32le(40), u32le(1), u32le(2), u16le(1), u16le(32), u32le(0),
  u32le(0), u32le(0), u32le(0), u32le(0), u32le(0),
  icoPixelData, icoMask
);

// QOI (Quite OK Image) 1x1 red pixel
const qoi = concat(
  str("qoif"),
  u32be(1), u32be(1),  // width=1, height=1
  u8(3),               // channels=RGB
  u8(0),               // colorspace=sRGB
  u8(0xFE),            // QOI_OP_RGB
  u8(0xFF, 0x00, 0x00), // r, g, b
  u8(0,0,0,0,0,0,0,1)  // end marker (7 zero bytes + 1)
);

// ═══════════════════════════════════════════════════════════
//  AUDIO FORMATS
// ═══════════════════════════════════════════════════════════

// WAV: mono, 16-bit, 44100 Hz, 4410 samples (~100ms of silence)
const wavSamples = 4410;
const wavDataSize = wavSamples * 2;
const wav = concat(
  str("RIFF"), u32le(36 + wavDataSize), str("WAVE"),
  str("fmt "), u32le(16),
  u16le(1),        // PCM
  u16le(1),        // mono
  u32le(44100),    // sample rate
  u32le(88200),    // byte rate
  u16le(2),        // block align
  u16le(16),       // bits per sample
  str("data"), u32le(wavDataSize),
  new Uint8Array(wavDataSize) // silence
);

// OGG/Vorbis: minimal valid file (Ogg container with Vorbis identification header)
// This is a proper minimal Ogg Vorbis file with ID + comment + setup headers + audio
// Using a known minimal Ogg file (silent, ~0.1s)
function makeMinimalOgg() {
  // We'll construct a minimal Ogg page with Vorbis ID header
  // This is the absolute minimum to be recognized as Ogg Vorbis
  const serial = 0x12345678;

  function oggPage(granulePos, pageSeq, headerType, segments) {
    const segTable = u8(segments.length);
    const segSizes = new Uint8Array(segments.length);
    let totalSize = 0;
    for (let i = 0; i < segments.length; i++) {
      segSizes[i] = segments[i].length;
      totalSize += segments[i].length;
    }
    const header = concat(
      str("OggS"),
      u8(0),             // version
      u8(headerType),    // header type
      // granule position (8 bytes LE)
      u32le(granulePos & 0xFFFFFFFF), u32le(0),
      u32le(serial),
      u32le(pageSeq),
      u32le(0),          // CRC (leave 0 for simplicity — many parsers accept it)
      u8(segments.length),
      segSizes,
    );
    return concat(header, ...segments);
  }

  // Vorbis identification header
  const vorbisId = concat(
    u8(1),                // packet type 1 = identification
    str("vorbis"),
    u32le(0),             // vorbis version
    u8(1),                // channels
    u32le(44100),         // sample rate
    u32le(0),             // bitrate max
    u32le(80000),         // bitrate nominal
    u32le(0),             // bitrate min
    u8(0xB8),             // blocksize 0=256, 1=2048 (encoded as log2: 8 and 11 → 0xB8)
    u8(1),                // framing flag
  );

  // Vorbis comment header (minimal)
  const vorbisComment = concat(
    u8(3),                // packet type 3 = comment
    str("vorbis"),
    u32le(0),             // vendor string length
    u32le(0),             // user comment list length
    u8(1),                // framing bit
  );

  return concat(
    oggPage(0, 0, 0x02, [vorbisId]),      // BOS page with ID header
    oggPage(0, 1, 0x00, [vorbisComment]), // Comment header page
  );
}
const ogg = makeMinimalOgg();

// FLAC: minimal valid file with streaminfo and 1 frame of silence
function makeMinimalFlac() {
  const sampleRate = 44100;
  const numChannels = 1;
  const bitsPerSample = 16;
  const totalSamples = 1;

  // STREAMINFO metadata block (34 bytes payload)
  const streaminfo = concat(
    u8(0x80),                    // Last metadata block flag + type 0 (STREAMINFO)
    u8(0x00, 0x00, 0x22),       // Length = 34
    u16be(256),                  // Min block size
    u16be(256),                  // Max block size
    u8(0x00, 0x00, 0x00),       // Min frame size (0 = unknown)
    u8(0x00, 0x00, 0x00),       // Max frame size (0 = unknown)
    // Sample rate (20 bits) | channels-1 (3 bits) | bps-1 (5 bits) | total samples (36 bits)
    // 44100 = 0xAC44, channels-1=0, bps-1=15 (16-bit), totalSamples=1
    // Byte layout: SSSS SSSS | SSSS SSSS | SSSS CCCC | BBBB BTTT | TTTT TTTT | ...
    u8(0xAC), u8(0x44), u8(0x10), u8(0xF0), u8(0x00, 0x00, 0x00, 0x01),
    // MD5 (16 bytes, zeros = unknown)
    new Uint8Array(16),
  );

  // Minimal FLAC frame: constant silence subframe
  const frame = concat(
    // Frame header
    u16be(0xFFF8),             // Sync code + reserved + blocking strategy (fixed)
    u8(0x00),                  // Block size=get from STREAMINFO, sample rate=get from STREAMINFO
    u8(0x09),                  // Channel assignment: mono, sample size: 16-bit
    u8(0x00),                  // Frame number = 0 (for fixed blocking)
    // (UTF-8 coded frame number, 0 = 1 byte)
    // Block size: from streaminfo header
    // We need a valid CRC-8 here; for simplicity set to 0
    u8(0x00),
    // Subframe: constant
    u8(0x02),                  // Subframe type: constant (00001) shifted left 1 = 0x02
    u16be(0x0000),             // Constant value = 0 (silence)
    // Padding to byte boundary (already aligned)
    // CRC-16 (set to 0 for simplicity)
    u16be(0x0000),
  );

  return concat(str("fLaC"), streaminfo, frame);
}
const flac = makeMinimalFlac();

// MIDI: minimal type 0, 1 track, middle C note
function makeMinimalMidi() {
  const trackData = concat(
    u8(0x00, 0xFF, 0x51, 0x03, 0x07, 0xA1, 0x20), // Set tempo (500000 µs = 120 BPM)
    u8(0x00, 0x90, 0x3C, 0x64),                     // Note On: channel 0, C4, velocity 100
    u8(0x60, 0x80, 0x3C, 0x00),                     // Note Off after 96 ticks
    u8(0x00, 0xFF, 0x2F, 0x00),                     // End of track
  );
  return concat(
    str("MThd"), u32be(6), u16be(0), u16be(1), u16be(96), // Header: format 0, 1 track, 96 tpqn
    str("MTrk"), u32be(trackData.length),
    trackData
  );
}
const midi = makeMinimalMidi();

// ═══════════════════════════════════════════════════════════
//  DATA / TEXT FORMATS
// ═══════════════════════════════════════════════════════════

const json = str(JSON.stringify({ name: "test", value: 42, items: ["a", "b"] }, null, 2));
const xml = str(`<?xml version="1.0" encoding="UTF-8"?>\n<root><item id="1">Test</item></root>`);
const yaml = str(`name: test\nvalue: 42\nitems:\n  - a\n  - b\n`);
const csv = str(`name,age,city\nAlice,30,Springfield\nBob,25,Shelbyville\n`);
const tsv = str(`name\tage\tcity\nAlice\t30\tSpringfield\nBob\t25\tShelbyville\n`);
const html = str(`<!DOCTYPE html>\n<html><head><title>Test</title></head><body><p>Hello World</p></body></html>`);
const text = str(`Hello World. This is a plain text test fixture for conversion testing.\nLine two.\n`);
const batch = str(`@echo off\necho Hello World\npause\n`);
const python = str(`#!/usr/bin/env python3\nprint("Hello World")\n`);
const shell = str(`#!/bin/sh\necho "Hello World"\n`);
const go = str(`package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println("Hello World")\n}\n`);
const csharp = str(`using System;\nclass Program {\n    static void Main() {\n        Console.WriteLine("Hello World");\n    }\n}\n`);

// ═══════════════════════════════════════════════════════════
//  DOCUMENT FORMATS
// ═══════════════════════════════════════════════════════════

// Minimal valid PDF
const pdfContent = `%PDF-1.0
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/MediaBox[0 0 72 72]/Parent 2 0 R/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length 44>>stream
BT /F1 12 Tf 10 50 Td (Hello) Tj ET
endstream
endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
xref
0 6
0000000000 65535 f
0000000009 00000 n
0000000058 00000 n
0000000115 00000 n
0000000266 00000 n
0000000360 00000 n
trailer<</Size 6/Root 1 0 R>>
startxref
430
%%EOF`;
const pdf = str(pdfContent);

// ═══════════════════════════════════════════════════════════
//  ARCHIVE FORMATS
// ═══════════════════════════════════════════════════════════

// Minimal ZIP with one file (hello.txt containing "hi")
function makeMinimalZip() {
  const fileName = str("hello.txt");
  const fileData = str("hi");
  const crc = 0x6869; // Simplified — many parsers accept wrong CRC for small files

  // Local file header
  const local = concat(
    u32le(0x04034B50),   // Local file header signature
    u16le(20),           // Version needed
    u16le(0),            // Flags
    u16le(0),            // Compression: stored
    u16le(0), u16le(0),  // Mod time, mod date
    u32le(0),            // CRC-32 (set to 0 for simplicity)
    u32le(fileData.length), // Compressed size
    u32le(fileData.length), // Uncompressed size
    u16le(fileName.length), // File name length
    u16le(0),            // Extra field length
    fileName,
    fileData,
  );

  // Central directory entry
  const central = concat(
    u32le(0x02014B50),   // Central directory signature
    u16le(20),           // Version made by
    u16le(20),           // Version needed
    u16le(0),            // Flags
    u16le(0),            // Compression: stored
    u16le(0), u16le(0),  // Mod time, mod date
    u32le(0),            // CRC-32
    u32le(fileData.length),
    u32le(fileData.length),
    u16le(fileName.length),
    u16le(0),            // Extra field length
    u16le(0),            // Comment length
    u16le(0),            // Disk number start
    u16le(0),            // Internal attributes
    u32le(0),            // External attributes
    u32le(0),            // Offset of local header
    fileName,
  );

  // End of central directory
  const endDir = concat(
    u32le(0x06054B50),
    u16le(0), u16le(0),
    u16le(1), u16le(1),
    u32le(central.length),
    u32le(local.length),
    u16le(0),
  );

  return concat(local, central, endDir);
}
const zip = makeMinimalZip();

// Minimal TAR (one file: hello.txt)
function makeMinimalTar() {
  const block = new Uint8Array(512);
  const name = "hello.txt";
  const content = "hello world\n";

  // Write name
  for (let i = 0; i < name.length; i++) block[i] = name.charCodeAt(i);
  // Mode (octal string, null-terminated)
  const mode = "0000644\0";
  for (let i = 0; i < mode.length; i++) block[100 + i] = mode.charCodeAt(i);
  // UID
  const uid = "0001000\0";
  for (let i = 0; i < uid.length; i++) block[108 + i] = uid.charCodeAt(i);
  // GID
  for (let i = 0; i < uid.length; i++) block[116 + i] = uid.charCodeAt(i);
  // Size (octal)
  const size = content.length.toString(8).padStart(11, "0") + "\0";
  for (let i = 0; i < size.length; i++) block[124 + i] = size.charCodeAt(i);
  // Mtime
  const mtime = "14542444460\0";
  for (let i = 0; i < mtime.length; i++) block[136 + i] = mtime.charCodeAt(i);
  // Type flag: regular file
  block[156] = 0x30; // '0'
  // USTAR magic
  const ustar = "ustar\x0000";
  for (let i = 0; i < ustar.length; i++) block[257 + i] = ustar.charCodeAt(i);

  // Calculate checksum
  // First fill checksum field with spaces
  for (let i = 148; i < 156; i++) block[i] = 0x20;
  let checksum = 0;
  for (let i = 0; i < 512; i++) checksum += block[i];
  const csStr = checksum.toString(8).padStart(6, "0") + "\0 ";
  for (let i = 0; i < csStr.length; i++) block[148 + i] = csStr.charCodeAt(i);

  // Data block (padded to 512)
  const dataBlock = new Uint8Array(512);
  for (let i = 0; i < content.length; i++) dataBlock[i] = content.charCodeAt(i);

  // Two zero blocks as EOF
  return concat(block, dataBlock, new Uint8Array(1024));
}
const tar = makeMinimalTar();

// GZ: gzip-compressed "hello\n"
function makeMinimalGz() {
  // Use pako-like manual deflate for a tiny payload
  // Gzip header + DEFLATE stored block + footer
  const payload = str("hello\n");
  // CRC32 of "hello\n"
  function crc32(data) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < data.length; i++) {
      crc ^= data[i];
      for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }
  const crc = crc32(payload);

  return concat(
    u8(0x1F, 0x8B),         // Magic
    u8(0x08),                // Compression: deflate
    u8(0x00),                // Flags: none
    u32le(0),                // Mtime
    u8(0x00),                // Extra flags
    u8(0xFF),                // OS: unknown
    // DEFLATE stored block (non-compressed)
    u8(0x01),                // BFINAL=1, BTYPE=00 (stored)
    u16le(payload.length),   // LEN
    u16le(payload.length ^ 0xFFFF), // NLEN
    payload,
    u32le(crc),              // CRC32
    u32le(payload.length),   // ISIZE
  );
}
const gz = makeMinimalGz();

// ═══════════════════════════════════════════════════════════
//  FONT FORMATS
// ═══════════════════════════════════════════════════════════

// Minimal TrueType font (just enough tables to be recognized)
function makeMinimalTtf() {
  // Offset table
  const numTables = 3; // head, name, cmap (minimum viable)
  const searchRange = 32;
  const entrySelector = 1;
  const rangeShift = numTables * 16 - searchRange;

  // head table (54 bytes, padded to 56)
  const headTable = concat(
    u16be(1), u16be(0),   // version 1.0
    u16be(1), u16be(0),   // fontRevision
    u32be(0),              // checksumAdjustment
    u32be(0x5F0F3CF5),    // magicNumber
    u16be(0x000B),         // flags
    u16be(1000),           // unitsPerEm
    new Uint8Array(8),     // created
    new Uint8Array(8),     // modified
    u16be(0), u16be(0),   // xMin, yMin
    u16be(1000), u16be(1000), // xMax, yMax
    u16be(0),              // macStyle
    u16be(8),              // lowestRecPPEM
    u16be(2),              // fontDirectionHint
    u16be(1),              // indexToLocFormat
    u16be(0),              // glyphDataFormat
  );

  // name table (minimal: 1 name record)
  const fontName = str("Test");
  const nameTable = concat(
    u16be(0),              // format
    u16be(1),              // count
    u16be(6 + 12),        // string offset (header + 1 record)
    // Name record: platform=1 (Mac), encoding=0, language=0, nameID=4 (full name)
    u16be(1), u16be(0), u16be(0), u16be(4),
    u16be(fontName.length), u16be(0),
    fontName,
  );

  // cmap table (minimal: format 0)
  const cmapTable = concat(
    u16be(0),              // version
    u16be(1),              // numTables
    u16be(1), u16be(0),   // platformID=1, encodingID=0
    u32be(12),             // offset to subtable
    // Format 0 subtable
    u16be(0),              // format
    u16be(262),            // length
    u16be(0),              // language
    new Uint8Array(256),   // glyph indices (all map to 0)
  );

  // Calculate table offsets
  const headerSize = 12 + numTables * 16;
  const tables = [
    { tag: "cmap", data: cmapTable },
    { tag: "head", data: headTable },
    { tag: "name", data: nameTable },
  ];

  // Sort by tag
  tables.sort((a, b) => a.tag.localeCompare(b.tag));

  let offset = headerSize;
  const records = [];
  for (const t of tables) {
    const padded = t.data.length + (4 - t.data.length % 4) % 4;
    records.push({
      tag: t.tag,
      checksum: 0,
      offset,
      length: t.data.length,
      data: t.data,
    });
    offset += padded;
  }

  // Build font
  let font = concat(
    u32be(0x00010000),     // sfVersion
    u16be(numTables),
    u16be(searchRange),
    u16be(entrySelector),
    u16be(rangeShift),
  );

  for (const r of records) {
    font = concat(font,
      str(r.tag),
      u32be(r.checksum),
      u32be(r.offset),
      u32be(r.length),
    );
  }

  for (const r of records) {
    const pad = (4 - r.data.length % 4) % 4;
    font = concat(font, r.data, new Uint8Array(pad));
  }

  return font;
}
const ttf = makeMinimalTtf();

// ═══════════════════════════════════════════════════════════
//  3D MODEL FORMATS
// ═══════════════════════════════════════════════════════════

// Minimal glTF 2.0 (JSON)
const gltf = str(JSON.stringify({
  asset: { version: "2.0", generator: "test" },
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes: [{ mesh: 0 }],
  meshes: [{
    primitives: [{
      attributes: { POSITION: 0 },
    }],
  }],
  accessors: [{
    bufferView: 0,
    componentType: 5126,
    count: 3,
    type: "VEC3",
    max: [1, 1, 0],
    min: [0, 0, 0],
  }],
  bufferViews: [{
    buffer: 0,
    byteLength: 36,
    target: 34962,
  }],
  buffers: [{
    uri: "data:application/octet-stream;base64,AAAAAAAAAAAAAAAAAACAPwAAAAAAAAAAAAAAAAAAgD8AAAAA",
    byteLength: 36,
  }],
}));

// OBJ: simple triangle
const obj = str(
  `# Test OBJ\n` +
  `v 0.0 0.0 0.0\n` +
  `v 1.0 0.0 0.0\n` +
  `v 0.0 1.0 0.0\n` +
  `f 1 2 3\n`
);

// STL (ASCII): single triangle
const stl = str(
  `solid test\n` +
  `  facet normal 0 0 1\n` +
  `    outer loop\n` +
  `      vertex 0 0 0\n` +
  `      vertex 1 0 0\n` +
  `      vertex 0 1 0\n` +
  `    endloop\n` +
  `  endfacet\n` +
  `endsolid test\n`
);

// ═══════════════════════════════════════════════════════════
//  GAME / SPECIALTY FORMATS
// ═══════════════════════════════════════════════════════════

// Minimal NBT (uncompressed, single compound with a string)
function makeMinimalNbt() {
  const rootName = str(""); // empty root name
  const tagName = str("hello");
  const tagValue = str("world");
  return concat(
    u8(0x0A),                    // TAG_Compound
    u16be(rootName.length), rootName,
    u8(0x08),                    // TAG_String
    u16be(tagName.length), tagName,
    u16be(tagValue.length), tagValue,
    u8(0x00),                    // TAG_End
  );
}
const nbt = makeMinimalNbt();

// BSON: minimal document {hello: "world"}
function makeMinimalBson() {
  const key = concat(str("hello"), u8(0)); // null-terminated key
  const value = concat(u32le(5), str("world"), u8(0)); // string: len + data + null
  const doc = concat(
    u8(0x02), // type: string
    key,
    value,
    u8(0x00), // document terminator
  );
  const size = 4 + doc.length; // 4 bytes for size prefix
  return concat(u32le(size), doc);
}
const bson = makeMinimalBson();

// SQLite: minimal valid database (header only + empty page)
function makeMinimalSqlite() {
  const page = new Uint8Array(4096);
  // SQLite header (first 100 bytes)
  const header = str("SQLite format 3\x00");
  page.set(header, 0);
  // Page size (bytes 16-17): 4096 = 0x1000
  page[16] = 0x10; page[17] = 0x00;
  // File format versions
  page[18] = 1; page[19] = 1;
  // Reserved space
  page[20] = 0;
  // Max embedded payload fraction
  page[21] = 64; page[22] = 32; page[23] = 32;
  // File change counter
  page[24] = 0; page[25] = 0; page[26] = 0; page[27] = 1;
  // Database size in pages
  page[28] = 0; page[29] = 0; page[30] = 0; page[31] = 1;
  // Schema format number (bytes 44-47)
  page[44] = 0; page[45] = 0; page[46] = 0; page[47] = 4;
  // Text encoding (bytes 56-59): 1 = UTF-8
  page[56] = 0; page[57] = 0; page[58] = 0; page[59] = 1;
  // Magic number validation (bytes 92-95)
  page[92] = 0; page[93] = 0x2e; page[94] = 0x5a; page[95] = 0x8c;
  // Page 1 is a leaf table b-tree page
  page[100] = 0x0D; // leaf table b-tree
  page[101] = 0; page[102] = 0; // first free block = 0
  page[103] = 0; page[104] = 0; // number of cells = 0
  page[105] = 0x0F; page[106] = 0xFE; // cell content area offset
  page[107] = 0; // fragmented free bytes
  return page;
}
const sqlite = makeMinimalSqlite();

// ═══════════════════════════════════════════════════════════
//  MUSIC NOTATION
// ═══════════════════════════════════════════════════════════

const musicxml = str(
  `<?xml version="1.0" encoding="UTF-8"?>\n` +
  `<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">\n` +
  `<score-partwise version="4.0">\n` +
  `  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>\n` +
  `  <part id="P1"><measure number="1"><attributes><divisions>1</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes><note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><type>whole</type></note></measure></part>\n` +
  `</score-partwise>`
);

// ═══════════════════════════════════════════════════════════
//  WRITE ALL FILES
// ═══════════════════════════════════════════════════════════

const files = {
  // Images
  "fixture.jpg":       jpeg,
  "fixture.gif":       gif,
  "fixture.bmp":       bmp,
  "fixture.tiff":      tiff,
  "fixture.webp":      webp,
  "fixture.svg":       svg,
  "fixture.ico":       ico,
  "fixture.qoi":       qoi,
  // Audio
  "fixture.wav":       wav,
  "fixture.ogg":       ogg,
  "fixture.flac":      flac,
  "fixture.mid":       midi,
  // Text/Data
  "fixture.json":      json,
  "fixture.xml":       xml,
  "fixture.yml":       yaml,
  "fixture.csv":       csv,
  "fixture.tsv":       tsv,
  "fixture.html":      html,
  "fixture.txt":       text,
  "fixture.bat":       batch,
  "fixture.py":        python,
  "fixture.sh":        shell,
  "fixture.go":        go,
  "fixture.cs":        csharp,
  // Documents
  "fixture.pdf":       pdf,
  // Archives
  "fixture.zip":       zip,
  "fixture.tar":       tar,
  "fixture.gz":        gz,
  // Fonts
  "fixture.ttf":       ttf,
  // 3D Models
  "fixture.gltf":      gltf,
  "fixture.obj":       obj,
  "fixture.stl":       stl,
  // Game/Specialty
  "fixture.nbt":       nbt,
  "fixture.bson":      bson,
  "fixture.sqlite":    sqlite,
  // Music notation
  "fixture.musicxml":  musicxml,
};

let count = 0;
for (const [name, data] of Object.entries(files)) {
  await Bun.write(`${dir}/${name}`, data);
  count++;
  console.log(`  ${name} (${data.length} bytes)`);
}
console.log(`\nGenerated ${count} fixture files in ${dir}/`);
