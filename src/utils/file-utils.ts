/** Extract base name from a filename (everything before the last dot) */
export function getBaseName(filename: string): string {
  const dotIndex = filename.lastIndexOf(".");
  return dotIndex > 0 ? filename.substring(0, dotIndex) : filename;
}

/** Extract lowercase file extension (without the dot) */
export function getExt(filename: string): string {
  return (filename.split(".").pop() ?? "").toLowerCase();
}
