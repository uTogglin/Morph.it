/** Convert canvas content to Uint8Array via Blob */
export function canvasToBytes(canvas: HTMLCanvasElement, mimeType: string): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) return reject(new Error("Canvas output failed"));
      blob.arrayBuffer().then(buf => resolve(new Uint8Array(buf)));
    }, mimeType);
  });
}
