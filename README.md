<div align="center">

<!-- Purple gradient banner -->
<img src="https://capsule-render.vercel.app/api?type=waving&color=0:4c1d95,50:7c3aed,100:a78bfa&height=200&section=header&text=Convert.it&fontSize=72&fontColor=ffffff&fontAlignY=35&desc=A%20truly%20universal%20file%20converter%20and%20toolkit&descSize=18&descColor=e9d5ff&descAlignY=55&animation=fadeIn" width="100%" />

<br>

[![Live Site](https://img.shields.io/badge/Live_Site-convert.utoggl.in-7c3aed?style=for-the-badge&logo=googlechrome&logoColor=white)](https://convert.utoggl.in/)
[![License](https://img.shields.io/badge/License-GPL_2.0-a78bfa?style=for-the-badge)](LICENSE)
[![GitHub Stars](https://img.shields.io/github/stars/uTogglin/convert?style=for-the-badge&color=6d28d9&logo=github)](https://github.com/uTogglin/convert)

<br>

**Everything runs locally in your browser.** No uploads, no servers, no accounts.<br>
Powered by WebAssembly and on-device AI.

<br>

<img src="docs/screenshots/homepage.png" alt="Convert.it Homepage" width="90%" style="border-radius: 12px;" />

</div>

<br>

---

<br>

## What is Convert.it?

Most online converters are limited, insecure, and boring. They only handle conversions within the same media type and force you to upload your files to some random server.

**Convert.it is different** — it processes everything locally using WebAssembly and on-device AI, supports cross-medium conversions, and packs a full suite of creative tools without ever touching a server.

Need to turn an AVI into a PDF? Extract text from a scanned document? Generate speech from text? Edit a PDF? Go for it.

<br>

---

<br>

## Tools

<table>
<tr>
<td width="50%" valign="top">

### Convert
> **200+ file formats** across every media type

Change files between images, video, audio, documents, archives, fonts, 3D models, game assets, and more. Auto-detects input format with batch conversion and category queueing. Simple mode for everyday use, Advanced mode for power users.

</td>
<td width="50%" valign="top">

### Compress
> **Video compression** with precision control

Re-encode videos with quality control and target file size constraints. Supports H.264, H.265, VP9 codecs with presets for Discord, Twitter/X, or custom targets. Output as MP4 or WebM.

</td>
</tr>
<tr>
<td width="50%" valign="top">

### Image Tools
> **AI-powered** image manipulation

Background removal via on-device RMBG-1.4 (WebGPU/WASM) or remove.bg API with correction mode for text and fine details. AI image generation and editing via OpenRouter API. Plus rescaling with aspect ratio lock and metadata stripping.

</td>
<td width="50%" valign="top">

### Video Editor
> **Full-featured** in-browser editing

Trim, crop, merge, and manage audio with a 5-band parametric EQ. Extract, burn, or AI-generate subtitles with Whisper in 15 languages. Hardware-accelerated WebCodecs where available.

</td>
</tr>
<tr>
<td width="50%" valign="top">

### Text & Speech
> **Neural TTS** and **Whisper STT**

28 neural voices (Kokoro 82M) across American and British accents with speed control and fullscreen read-aloud mode. Speech-to-text with 4 Whisper model sizes and word-level timestamps.

</td>
<td width="50%" valign="top">

### Summarize
> **AI-powered** document summarization

Summarize PDFs, DOCX, text, or web pages with DistilBART/BART models. Smart chunking handles long documents automatically. Adjustable target length from 50–500 words.

</td>
</tr>
<tr>
<td width="50%" valign="top">

### OCR
> **Tesseract.js** text extraction

Extract text from images and scanned PDFs in 14 languages. Multi-page PDF support with live preview. Includes fullscreen read-aloud mode with Kokoro TTS integration.

</td>
<td width="50%" valign="top">

### PDF Editor
> **Annotate, sign, and edit** in-browser

6 tools: select, text (20 fonts with auto-style matching), draw, highlight, erase, and image insertion. Per-page undo/redo, zoom, and live thumbnail sidebar.

</td>
</tr>
</table>

<br>

<div align="center">
<img src="docs/screenshots/converter.png" alt="Universal File Converter" width="90%" style="border-radius: 12px;" />
<br>
<sub><b>Universal converter</b> — 200+ formats with searchable format picker and category filters</sub>
</div>

<br>

---

<br>

## Supported Formats

| Category | Examples |
|:---|:---|
| **Image** | PNG, JPEG, WebP, GIF, SVG, TIFF, BMP, ICO, HEIF, AVIF, JP2, JXL, QOI, VTF, Aseprite, and 50+ more |
| **Video** | MP4, AVI, MKV, WebM, MOV, FLV, and 100+ FFmpeg formats |
| **Audio** | MP3, WAV, OGG, FLAC, AAC, MIDI, MOD, XM, S3M, IT, QOA, and more |
| **Document** | PDF, DOCX, XLSX, PPTX, HTML, Markdown, EPUB, RTF, LaTeX, ODT, and 50+ via Pandoc |
| **Data** | JSON, XML, YAML, CSV, SQL, SQLite, NBT (Minecraft) |
| **Archive** | ZIP, 7Z, TAR, TAR.GZ, GZ, LZH |
| **3D Model** | GLB and other formats via Three.js |
| **Font** | TTF, OTF, WOFF, WOFF2 |
| **Game** | Doom WAD, Beat Saber replays (BSOR), Scratch 3.0 (SB3), Portal 2 (SPPD), Half-Life 2 (VTF) |
| **Other** | Base64, hex, URL encoding, Python turtle graphics, PE executables |

<br>

---

<br>

## Built-in Image Editor

<div align="center">
<img src="docs/screenshots/editor.png" alt="Mini Paint Image Editor" width="90%" style="border-radius: 12px;" />
<br>
<sub><b>Full image editor</b> — layers, brushes, effects, selections, text, shapes, and AI generation</sub>
</div>

<br>

---

<br>

## Privacy & Security

<table>
<tr>
<td>

**100% client-side** — all processing runs in your browser using WebAssembly. Your files never leave your device unless you explicitly opt into remove.bg API, OpenRouter API (AI image generation), or CORS proxy. Privacy mode strips EXIF/GPS metadata, randomizes filenames, and hides referrer headers. No accounts, no tracking, no uploads.

</td>
</tr>
</table>

<br>

---

<br>

## Personalization

- Dark and light themes
- 8 preset accent colors + 3 custom color slots with full color picker
- Configurable defaults for every tool
- Auto-download toggle or collect files in the output tray

<br>

---

<br>

## Tech Stack

<div align="center">

[![TypeScript](https://img.shields.io/badge/TypeScript-7c3aed?style=flat-square&logo=typescript&logoColor=white)](#)
[![Vite](https://img.shields.io/badge/Vite-7c3aed?style=flat-square&logo=vite&logoColor=white)](#)
[![FFmpeg](https://img.shields.io/badge/FFmpeg_WASM-6d28d9?style=flat-square&logo=ffmpeg&logoColor=white)](#)
[![WebAssembly](https://img.shields.io/badge/WebAssembly-6d28d9?style=flat-square&logo=webassembly&logoColor=white)](#)

</div>

| Component | Technology |
|:---|:---|
| **Build** | TypeScript + Vite |
| **Video/Audio** | FFmpeg WASM |
| **Images** | ImageMagick WASM |
| **Documents** | Pandoc |
| **OCR** | Tesseract.js |
| **Text-to-Speech** | Kokoro TTS (82M params) |
| **Speech-to-Text** | Whisper via Transformers.js |
| **Summarization** | DistilBART / BART via Transformers.js |
| **Background Removal** | RMBG-1.4 via Transformers.js |
| **PDF** | pdfjs-dist + Fabric.js + pdf-lib |
| **3D Models** | Three.js |
| **Archives** | 7z-WASM, JSZip, pako |
| **Music Trackers** | libopenmpt |

<br>

---

<br>

## Usage

1. Go to **[convert.utoggl.in](https://convert.utoggl.in/)**
2. Pick a tool from the home screen or drop files anywhere
3. Configure your options and hit the action button
4. Download your result — or keep working

<br>

---

<br>

<div align="center">

**GPL-2.0** &nbsp;|&nbsp; Fork of [**Convert**](https://github.com/p2r3/convert) by [p2r3](https://github.com/p2r3) &nbsp;|&nbsp; Image editor powered by [**miniPaint**](https://github.com/nicktrigger/miniPaint) by [nicktrigger](https://github.com/nicktrigger)

<br>

<img src="https://capsule-render.vercel.app/api?type=waving&color=0:4c1d95,50:7c3aed,100:a78bfa&height=120&section=footer" width="100%" />

</div>
