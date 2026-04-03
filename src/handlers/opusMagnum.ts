import type { FileData, FileFormat, FormatHandler } from "../FormatHandler.ts";
import CommonFormats from "src/CommonFormats.ts";

interface OM_Molecule {
  primes: OM_Primes[];
  bonds: OM_Bonds[];
}

interface OM_Primes {
  element: number;
  x: number;
  y: number;
}

interface OM_Bonds {
  bond_type: number;
  source_x: number;
  source_y: number;
  destination_x: number;
  destination_y: number;
}

const elementSymbols: Record<number, string> = {
  1: "\u{1F714}", 2: "\u{1F701}", 3: "\u{1F703}", 4: "\u{1F702}",
  5: "\u{1F704}", 6: "\u263F", 7: "\u2609", 8: "\u263D",
  9: "\u2640", 10: "\u2642", 11: "\u2643", 12: "\u2644",
  13: "\u{1F70D}", 14: "\u{1F71E}", 15: "...", 16: "\u2736",
};

const elementColors: Record<number, string> = {
  1: "#A39770", 2: "#B3F2F4", 3: "#AFDC02", 4: "#FE7516",
  5: "#2B686C", 6: "#BBB5A2", 7: "#9A601F", 8: "#A6A4A0",
  9: "#814837", 10: "#50413D", 11: "#B0AD8C", 12: "#95A7A8",
  13: "#C5AD9A", 14: "#3A3829", 15: "#0A0911", 16: "#0A0911",
};

function twoComplement(input: number): number {
  if (input > 255) throw new Error("Error, coordinate over 255.");
  if (input >= 128) return -(256 - input);
  return input;
}

function renderMolecule(molecule: OM_Molecule): Uint8Array {
  const encoder = new TextEncoder();
  const radius = 50;

  if (molecule.primes.length === 0) {
    throw new Error("Error, empty molecule.");
  }

  let svg =
    "<svg xmlns='http://www.w3.org/2000/svg' width='bigx' height='bigy' viewBox='smallx smally bigx bigy'>";

  // Draw bonds
  for (const bond of molecule.bonds) {
    let sx = twoComplement(bond.source_x);
    let sy = twoComplement(bond.source_y);
    let dx = twoComplement(bond.destination_x);
    let dy = twoComplement(bond.destination_y);

    sx += 0.5 * sy;
    dx += 0.5 * dy;
    sx *= radius * 2.25;
    sy *= radius * 2.25;
    dx *= radius * 2.25;
    dy *= radius * 2.25;

    svg += "\n";
    if (bond.bond_type === 1) {
      svg += `    <line stroke='black' x1='${sx}' y1='${sy}' x2='${dx}' y2='${dy}' stroke-width='${radius * 0.2}'/>`;
    } else if (bond.bond_type === 14) {
      svg += `    <line stroke='red' x1='${sx}' y1='${sy}' x2='${dx}' y2='${dy}' stroke-width='${radius * 0.4}'/>`;
      svg += "\n";
      svg += `    <line stroke='black' x1='${sx}' y1='${sy}' x2='${dx}' y2='${dy}' stroke-width='${radius * 0.2}'/>`;
      svg += "\n";
      svg += `    <line stroke='yellow' x1='${sx}' y1='${sy}' x2='${dx}' y2='${dy}' stroke-width='${radius * 0.1}'/>`;
    } else {
      throw new Error(`Error, invalid bond (${bond.bond_type})`);
    }
  }

  // Draw atoms
  let leftmost = 99999, upmost = 99999;
  let rightmost = -99999, downmost = -99999;

  for (const prime of molecule.primes) {
    if (prime.element > 16 || prime.element < 1 || Math.floor(prime.element) !== prime.element) {
      throw new Error(`Error, invalid prime (${prime.element})`);
    }

    let cx = twoComplement(prime.x);
    let cy = twoComplement(prime.y);
    cx += 0.5 * cy;
    cx *= radius * 2.25;
    cy *= radius * 2.25;

    svg += "\n";
    svg += `    <circle cx='${cx}' cy='${cy}' fill='black' r='${radius}'/>`;
    svg += "\n";
    svg += `    <circle cx='${cx}' cy='${cy}' fill='${elementColors[prime.element]}' r='${radius * 0.9}'/>`;
    svg += "\n";
    svg += `    <text x='${cx}' y='${cy}' fill='white' text-anchor='middle' dominant-baseline='central' font-size='${radius}'>${elementSymbols[prime.element]}</text>`;

    if (cx + radius > rightmost) rightmost = cx + radius;
    if (cy + radius > downmost) downmost = cy + radius;
    if (cx - radius < leftmost) leftmost = cx - radius;
    if (cy - radius < upmost) upmost = cy - radius;
  }

  svg += "\n</svg>";

  svg = svg
    .replace(/bigx/g, String(rightmost - leftmost))
    .replace(/bigy/g, String(downmost - upmost))
    .replace(/smallx/g, String((rightmost + leftmost) / 2 - (rightmost - leftmost) / 2))
    .replace(/smally/g, String((downmost + upmost) / 2 - (downmost - upmost) / 2));

  return encoder.encode(svg);
}

function parseMolecules(bytes: Uint8Array, cursor: { pos: number }, count: number): OM_Molecule[] {
  const molecules: OM_Molecule[] = [];

  while (molecules.length < count) {
    const working: OM_Molecule = { primes: [], bonds: [] };

    const primesRl = bytes[cursor.pos];
    cursor.pos += 4;

    while (working.primes.length < primesRl) {
      working.primes.push({
        element: bytes[cursor.pos],
        x: bytes[cursor.pos + 1],
        y: bytes[cursor.pos + 2],
      });
      cursor.pos += 3;
    }

    const bondsRl = bytes[cursor.pos];
    cursor.pos += 4;

    while (working.bonds.length < bondsRl) {
      working.bonds.push({
        bond_type: bytes[cursor.pos],
        source_x: bytes[cursor.pos + 1],
        source_y: bytes[cursor.pos + 2],
        destination_x: bytes[cursor.pos + 3],
        destination_y: bytes[cursor.pos + 4],
      });
      cursor.pos += 5;
    }

    molecules.push(working);
  }

  return molecules;
}

class opusMagnumHandler implements FormatHandler {
  public name: string = "opusMagnum";
  public supportedFormats?: FileFormat[];
  public ready: boolean = false;

  async init() {
    this.supportedFormats = [
      CommonFormats.SVG.supported("svg", false, true),
      {
        name: "Opus Magnum puzzle",
        format: "puzzle",
        extension: "puzzle",
        mime: "application/x-opus-magnum-puzzle",
        from: true,
        to: false,
        internal: "puzzle",
        lossless: false,
      },
    ];

    this.ready = true;
  }

  async doConvert(
    inputFiles: FileData[],
    inputFormat: FileFormat,
    outputFormat: FileFormat
  ): Promise<FileData[]> {
    const outputFiles: FileData[] = [];

    if (inputFormat.internal !== "puzzle" || outputFormat.internal !== "svg") {
      throw new Error("Invalid input-output.");
    }

    for (const file of inputFiles) {
      const cursor = { pos: 0 };

      // Skip version
      cursor.pos += 4;
      const nameRl = file.bytes[cursor.pos];
      cursor.pos += 1;

      const decoder = new TextDecoder();
      const puzzleName = decoder.decode(file.bytes.subarray(cursor.pos, cursor.pos + nameRl));

      // Move past name + padding
      cursor.pos += nameRl + 16;
      const reagentsRl = file.bytes[cursor.pos];
      cursor.pos += 4;

      const reagents = parseMolecules(file.bytes, cursor, reagentsRl);

      const productsRl = file.bytes[cursor.pos];
      cursor.pos += 4;

      const products = parseMolecules(file.bytes, cursor, productsRl);

      for (let i = 0; i < reagents.length; i++) {
        outputFiles.push({
          bytes: renderMolecule(reagents[i]),
          name: puzzleName + "_reagent_" + i + "." + outputFormat.extension,
        });
      }
      for (let i = 0; i < products.length; i++) {
        outputFiles.push({
          bytes: renderMolecule(products[i]),
          name: puzzleName + "_product_" + i + "." + outputFormat.extension,
        });
      }
    }

    return outputFiles;
  }
}

export default opusMagnumHandler;
