/**
 * Shared WebGPU utility helpers for worker files.
 * Consolidates duplicated GPU detection, dtype selection, and tensor readback patching.
 */

/** Detect WebGPU availability and return the device type. */
export async function detectDevice(forceDevice?: string): Promise<"webgpu" | "wasm"> {
  if (forceDevice === "wasm") return "wasm";
  const hasWebGPU = !forceDevice && "gpu" in navigator &&
    !!(await (navigator as any).gpu?.requestAdapter().catch(() => null));
  return hasWebGPU ? "webgpu" : "wasm";
}

/** Get the appropriate dtype based on device: "fp32" for WebGPU, "q8" for WASM. */
export function getDefaultDtype(device: "webgpu" | "wasm"): string {
  return device === "webgpu" ? "fp32" : "q8";
}

/**
 * Patch a model's __call__ method to force WebGPU tensor readback to CPU.
 * No-op if device is not "webgpu" or model has no __call__.
 */
export function patchWebGPUReadback(model: any, device: "webgpu" | "wasm", label: string): void {
  if (device !== "webgpu" || !model?.__call__) return;
  const origCall = model.__call__.bind(model);
  model.__call__ = async function (...args: any[]) {
    const output = await origCall(...args);
    for (const key of Object.keys(output)) {
      const tensor = output[key];
      if (tensor && typeof tensor.getData === "function") await tensor.getData();
    }
    return output;
  };
  console.log(`[${label}] Patched __call__ for WebGPU tensor readback`);
}
