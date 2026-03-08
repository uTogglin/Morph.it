import CommonFormats from "src/CommonFormats.ts";
import type { FileData, FileFormat, FormatHandler } from "../FormatHandler.ts";
import { canvasToBytes } from "../utils/canvas-to-bytes.ts";
import { getBaseName } from "../utils/file-utils.ts";

import type { GLTF } from "three/addons/loaders/GLTFLoader.js";

class threejsHandler implements FormatHandler {

  public name: string = "threejs";
  public supportedFormats = [
    {
      name: "GL Transmission Format Binary",
      format: "glb",
      extension: "glb",
      mime: "model/gltf-binary",
      from: true,
      to: false,
      internal: "glb",
      category: "model"
    },
    {
      name: "GL Transmission Format",
      format: "gltf",
      extension: "gltf",
      mime: "model/gltf+json",
      from: true,
      to: false,
      internal: "glb",
      category: "model"
    },
    {
      name: "Waveform OBJ",
      format: "obj",
      extension: "obj",
      mime: "model/obj",
      from: true,
      to: false,
      internal: "obj",
      category: "model",
    },
    CommonFormats.PNG.supported("png", false, true),
    CommonFormats.JPEG.supported("jpeg", false, true),
    CommonFormats.WEBP.supported("webp", false, true)
  ];
  public ready: boolean = false;

  private THREE!: typeof import("three");
  private GLTFLoader!: typeof import("three/addons/loaders/GLTFLoader.js").GLTFLoader;
  private OBJLoader!: typeof import("three/addons/loaders/OBJLoader.js").OBJLoader;

  private scene!: import("three").Scene;
  private camera!: import("three").PerspectiveCamera;
  private renderer!: import("three").WebGLRenderer;

  async init () {
    const THREE = await import("three");
    const { GLTFLoader } = await import("three/addons/loaders/GLTFLoader.js");
    const { OBJLoader } = await import("three/addons/loaders/OBJLoader.js");

    this.THREE = THREE;
    this.GLTFLoader = GLTFLoader;
    this.OBJLoader = OBJLoader;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(90, 16 / 9, 0.1, 4096);
    this.renderer = new THREE.WebGLRenderer();
    this.renderer.setSize(960, 540);
    this.ready = true;
  }

  async doConvert (
    inputFiles: FileData[],
    inputFormat: FileFormat,
    outputFormat: FileFormat
  ): Promise<FileData[]> {
    const outputFiles: FileData[] = [];

    for (const inputFile of inputFiles) {

      const blob = new Blob([inputFile.bytes as BlobPart]);
      const url = URL.createObjectURL(blob);

      const THREE = this.THREE;
      let object: import("three").Group<import("three").Object3DEventMap>;

      switch (inputFormat.internal) {
        case "glb": {
          const gltf: GLTF = await new Promise((resolve, reject) => {
            const loader = new this.GLTFLoader();
            loader.load(url, resolve, undefined, reject);
          });
          object = gltf.scene;
          break;
        }
        case "obj":
          object = await new Promise((resolve, reject) => {
            const loader = new this.OBJLoader();
            loader.load(url, resolve, undefined, reject);
          });
          break;
        default:
          throw new Error("Invalid input format");
      }
      URL.revokeObjectURL(url);

      const bbox = new THREE.Box3().setFromObject(object);
      bbox.getCenter(this.camera.position);
      this.camera.position.z = bbox.max.z * 2;

      this.scene.background = new THREE.Color(0x424242);
      this.scene.add(object);
      this.renderer.render(this.scene, this.camera);
      this.scene.remove(object);

      const bytes = await canvasToBytes(this.renderer.domElement, outputFormat.mime);
      const name = getBaseName(inputFile.name) + "." + outputFormat.extension;
      outputFiles.push({ bytes, name });

    }

    return outputFiles;
  }

}

export default threejsHandler;