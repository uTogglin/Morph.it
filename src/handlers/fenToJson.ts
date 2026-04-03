import type { FileData, FileFormat, FormatHandler } from "../FormatHandler.ts";
import CommonFormats, { Category } from "src/CommonFormats.ts";

type Square = string;
type PieceSymbol = "p" | "n" | "b" | "r" | "q" | "k";
type Color = "w" | "b";

const WHITE: Color = "w";
const BLACK: Color = "b";
const KING = "k" as const;
const QUEEN = "q" as const;

const SQUARES: string[] = [];
for (const rank of "87654321") {
  for (const file of "abcdefgh") {
    SQUARES.push(file + rank);
  }
}

type BoardSquare = {
  square: Square;
  type: PieceSymbol;
  color: Color;
} | null;

type Game = {
  board: BoardSquare[][];
  turn: Color;
  castling: {
    [key in Color]: {
      k: boolean;
      q: boolean;
    };
  };
  epSquare: Square | null;
  halfMoves: number;
  moveNumber: number;
};

function isSquare(value: string): boolean {
  return SQUARES.includes(value);
}

function isPieceSymbol(value: string): value is PieceSymbol {
  return "pnbrqk".includes(value);
}

class fenToJsonHandler implements FormatHandler {
  public name: string = "fenToJson";
  public supportedFormats: FileFormat[] = [
    {
      name: "Forsyth\u2013Edwards Notation",
      format: "fen",
      extension: "fen",
      mime: "application/vnd.chess-fen",
      from: true,
      to: true,
      internal: "fen",
      category: Category.TEXT,
      lossless: true,
    },
    CommonFormats.JSON.builder("json").allowTo().allowFrom().markLossless(),
  ];
  public ready: boolean = false;

  async init() {
    this.ready = true;
  }

  async doConvert(
    inputFiles: FileData[],
    inputFormat: FileFormat,
    outputFormat: FileFormat
  ): Promise<FileData[]> {
    const outputFiles: FileData[] = [];

    for (const inputFile of inputFiles) {
      const input = new TextDecoder().decode(inputFile.bytes).trim();
      let output: string;

      if (inputFormat.internal === "fen") {
        const [boardFen, turn, castling, epSquare, halfMoves, moveNumber] = input.split(" ");

        const board: BoardSquare[][] = [];
        let currentSquare = 0;
        for (const rowFen of boardFen.split("/")) {
          const row: BoardSquare[] = [];
          for (const char of rowFen) {
            if (char >= "0" && char <= "9") {
              row.push(...Array(Number(char)).fill(null));
              currentSquare += Number(char);
            } else {
              const type = char.toLowerCase();
              row.push({
                square: SQUARES[currentSquare],
                color: char >= "A" && char <= "Z" ? WHITE : BLACK,
                type: isPieceSymbol(type) ? type : "p",
              });
              currentSquare += 1;
            }
          }
          board.push(row);
        }

        const game: Game = {
          board,
          turn: turn === "w" ? WHITE : BLACK,
          castling: {
            [WHITE]: {
              [KING]: castling.includes("K"),
              [QUEEN]: castling.includes("Q"),
            },
            [BLACK]: {
              [KING]: castling.includes("k"),
              [QUEEN]: castling.includes("q"),
            },
          } as Game["castling"],
          epSquare: isSquare(epSquare) ? epSquare : null,
          halfMoves: Number(halfMoves),
          moveNumber: Number(moveNumber),
        };
        output = JSON.stringify(game);
      } else if (inputFormat.internal === "json") {
        const game: Game = JSON.parse(input);
        const fen: string[] = [];

        const boardFen: string[] = [];
        for (const row of game.board) {
          const rowFen: string[] = [];
          let emptyCounter = 0;
          for (const square of row) {
            if (!square) {
              emptyCounter++;
              continue;
            }
            if (emptyCounter > 0) {
              rowFen.push(String(emptyCounter));
              emptyCounter = 0;
            }
            rowFen.push(
              square.color === WHITE ? square.type.toUpperCase() : square.type.toLowerCase()
            );
          }
          if (emptyCounter > 0) {
            rowFen.push(String(emptyCounter));
          }
          boardFen.push(rowFen.join(""));
        }
        fen.push(boardFen.join("/"));

        fen.push(game.turn);
        const castling =
          (game.castling[WHITE][KING] ? "K" : "") +
          (game.castling[WHITE][QUEEN] ? "Q" : "") +
          (game.castling[BLACK][KING] ? "k" : "") +
          (game.castling[BLACK][QUEEN] ? "q" : "");
        fen.push(castling !== "" ? castling : "-");
        fen.push(game.epSquare ?? "-");
        fen.push(String(game.halfMoves));
        fen.push(String(game.moveNumber));

        output = fen.join(" ");
      } else {
        throw new Error(`fenToJsonHandler cannot convert from ${inputFormat.internal}`);
      }

      const bytes = new TextEncoder().encode(output);
      const name = inputFile.name.replace(/\.[^.]+$/, "") + `.${outputFormat.extension}`;
      outputFiles.push({ name, bytes });
    }

    return outputFiles;
  }
}

export default fenToJsonHandler;
