declare module "onnxruntime-web" {
  export const env: any;
  export class Tensor {
    constructor(type: string, data: any, dims: number[]);
    data: any;
    type: string;
    dims: number[];
  }
  export class InferenceSession {
    static create(modelData: ArrayBufferLike | string, options?: any): Promise<InferenceSession>;
    run(feeds: Record<string, Tensor>): Promise<Record<string, Tensor>>;
    release(): void;
    inputNames: string[];
    outputNames: string[];
  }
}
