import CommonFormats from "src/CommonFormats.ts";
import type { FileData, FileFormat, FormatHandler } from "../FormatHandler.ts";
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";

class sqlite3Handler implements FormatHandler {

  public name: string = "sqlite3";
  public supportedFormats?: FileFormat[];
  public ready: boolean = false;

  async init () {
    this.supportedFormats = [
      {
        name: "SQLite3",
        format: "sqlite3",
        extension: "db",
        mime: "application/vnd.sqlite3",
        from: true,
        to: false,
        internal: "sqlite3",
        category: "database"
      },
      {
        name: "Magic: The Gathering Arena Database",
        format: "mtga",
        extension: "mtga",
        mime: "application/vnd.sqlite3",
        from: true,
        to: false,
        internal: "sqlite3",
        category: "database"
      },
      // Lossy because extracts only tables  
      CommonFormats.CSV.builder("csv").allowTo()
    ];
    this.ready = true;
  }

  getTables(db: any) {
    const stmt = db.prepare("SELECT name FROM sqlite_master WHERE type='table';");
    let row: any[] = [];
    try {
      while (stmt.step()) {
        row.push(stmt.get(0));
      }
    } finally {
        stmt.finalize();
    }
    return row;
  }

  async doConvert (
    inputFiles: FileData[],
    inputFormat: FileFormat,
    outputFormat: FileFormat
  ): Promise<FileData[]> {
    const outputFiles: FileData[] = [];
    const sqlite3 = await sqlite3InitModule();

    if (inputFormat.internal == "sqlite3" && outputFormat.internal == "csv") {
        for (const file of inputFiles) {
            const p = sqlite3.wasm.allocFromTypedArray(file.bytes);

            const db = new sqlite3.oo1.DB();
            if (!db.pointer) {
                throw new Error("Database pointer is undefined")
            }
            const flags = sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE;
            const rc = sqlite3.capi.sqlite3_deserialize(
                db.pointer,
                "main",
                p,
                file.bytes.byteLength,
                file.bytes.byteLength,
                flags
            );
            db.checkRc(rc);

            
            for (const table of this.getTables(db)) {
                const quotedTable = `"${String(table).replace(/"/g, '""')}"`;
                const stmt = db.prepare(`SELECT * FROM ${quotedTable}`);
                function csvEscape(val: unknown): string {
                  const s = val == null ? "" : String(val);
                  if (s.includes(",") || s.includes("\"") || s.includes("\n"))
                    return `"${s.replace(/"/g, '""')}"`;
                  return s;
                }
                let csvStr = stmt.getColumnNames().map(csvEscape).join(",") + "\n";
                try {
                  while (stmt.step()) {
                    const row = Array.from({length: stmt.columnCount }, (_, j) => stmt.get(j))
                    csvStr += row.map(csvEscape).join(",") + "\n"
                  }
                } finally {
                    stmt.finalize();
                }

                const encoder = new TextEncoder()
                outputFiles.push({
                    name: table + ".csv",
                    bytes: new Uint8Array(encoder.encode(csvStr))
                })
            }
         }
    }



    return outputFiles;
  }

}

export default sqlite3Handler;
