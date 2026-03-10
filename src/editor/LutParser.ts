// ── LutParser ─────────────────────────────────────────────────────────────────
// Parses Adobe/DaVinci .cube 3D LUT files into a Float32Array that can be
// passed directly to the EffectChain's LUT shader (LutParams.lutData).
//
// .cube spec (simplified):
//   - Lines starting with # are comments
//   - TITLE "name"          (optional)
//   - LUT_3D_SIZE N         (required; N = 2–65, typically 17, 33, or 65)
//   - DOMAIN_MIN r g b      (optional; default 0 0 0)
//   - DOMAIN_MAX r g b      (optional; default 1 1 1)
//   - N³ lines of "r g b"   (float values, one triplet per line)
//
// The output lutData is arranged in (B, G, R) index order:
//   index = r + g*N + b*N²   (i.e. r changes fastest, b slowest)
// which matches how the GLSL sampler3D lookup works in EffectChain.
//
// Throws a descriptive Error on malformed input.

export interface ParsedLut {
  lutData:    Float32Array;   // size³ × 3 floats (R, G, B interleaved)
  size:       number;         // N (LUT dimension)
  domainMin:  [number, number, number];
  domainMax:  [number, number, number];
  title:      string;
}

export function parseCubeLut(text: string): ParsedLut {
  const lines = text.split(/\r?\n/);

  let size     = 0;
  let title    = '';
  let domainMin: [number, number, number] = [0, 0, 0];
  let domainMax: [number, number, number] = [1, 1, 1];

  // Collect data lines separately (lines that are purely three floats)
  const dataLines: string[] = [];
  let headerDone = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const upper = line.toUpperCase();

    if (!headerDone) {
      if (upper.startsWith('TITLE')) {
        title = line.slice(5).trim().replace(/^["']|["']$/g, '');
        continue;
      }
      if (upper.startsWith('LUT_3D_SIZE')) {
        const parts = line.split(/\s+/);
        size = parseInt(parts[1], 10);
        if (isNaN(size) || size < 2 || size > 65) {
          throw new Error(`LutParser: invalid LUT_3D_SIZE "${parts[1]}"`);
        }
        continue;
      }
      if (upper.startsWith('DOMAIN_MIN')) {
        const parts = line.split(/\s+/).slice(1).map(Number);
        if (parts.length < 3 || parts.some(isNaN)) throw new Error('LutParser: malformed DOMAIN_MIN');
        domainMin = [parts[0], parts[1], parts[2]];
        continue;
      }
      if (upper.startsWith('DOMAIN_MAX')) {
        const parts = line.split(/\s+/).slice(1).map(Number);
        if (parts.length < 3 || parts.some(isNaN)) throw new Error('LutParser: malformed DOMAIN_MAX');
        domainMax = [parts[0], parts[1], parts[2]];
        continue;
      }
      // If the line looks like three floats, we've entered the data section
      if (/^-?[\d.eE+\-]/.test(line)) {
        headerDone = true;
        // fall through to data handling below
      } else {
        // Unknown keyword — skip gracefully
        continue;
      }
    }

    // Data line
    dataLines.push(line);
  }

  if (size === 0) {
    throw new Error('LutParser: LUT_3D_SIZE not found in .cube file');
  }

  const expected = size * size * size;
  if (dataLines.length < expected) {
    throw new Error(
      `LutParser: expected ${expected} data triplets for a ${size}³ LUT but found ${dataLines.length}`
    );
  }

  const lutData = new Float32Array(expected * 3);
  let writeIdx  = 0;

  // Hoist domain deltas — they are constant across all N³ iterations.
  const dr = domainMax[0] - domainMin[0];
  const dg = domainMax[1] - domainMin[1];
  const db = domainMax[2] - domainMin[2];

  for (let i = 0; i < expected; i++) {
    const parts = dataLines[i].split(/\s+/);
    if (parts.length < 3) {
      throw new Error(`LutParser: malformed data line ${i + 1}: "${dataLines[i]}"`);
    }
    const r = parseFloat(parts[0]);
    const g = parseFloat(parts[1]);
    const b = parseFloat(parts[2]);
    if (isNaN(r) || isNaN(g) || isNaN(b)) {
      throw new Error(`LutParser: non-numeric value on data line ${i + 1}`);
    }
    // Normalize to [0,1] if domain is non-standard
    lutData[writeIdx++] = dr !== 0 ? (r - domainMin[0]) / dr : r;
    lutData[writeIdx++] = dg !== 0 ? (g - domainMin[1]) / dg : g;
    lutData[writeIdx++] = db !== 0 ? (b - domainMin[2]) / db : b;
  }

  return { lutData, size, domainMin, domainMax, title };
}

/**
 * Read a .cube File object and parse it.
 * Returns a Promise so it can be awaited in an event handler.
 */
export async function loadCubeLutFile(file: File): Promise<ParsedLut> {
  const text = await file.text();
  return parseCubeLut(text);
}
