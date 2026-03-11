// Minimal type declarations for mp4box.js (v0.5.x)
// Only the subset used by ExportDecoder is declared here.

declare module 'mp4box' {
  export function createFile(): MP4File;

  export class DataStream {
    static BIG_ENDIAN: boolean;
    constructor(buffer: ArrayBuffer | undefined, offset: number, endian: boolean);
    buffer: ArrayBuffer;
  }

  interface MP4File {
    onReady: ((info: MP4Info) => void) | null;
    onSamples: ((id: number, user: any, samples: MP4Sample[]) => void) | null;
    onError: ((e: any) => void) | null;
    appendBuffer(buffer: ArrayBuffer): number;
    start(): void;
    flush(): void;
    setExtractionOptions(trackId: number, user: any, options: { nbSamples: number }): void;
    getTrackById(id: number): any;
  }

  interface MP4Info {
    videoTracks?: MP4VideoTrack[];
    audioTracks?: MP4AudioTrack[];
  }

  interface MP4VideoTrack {
    id: number;
    codec: string;
    timescale: number;
    video: { width: number; height: number };
  }

  interface MP4AudioTrack {
    id: number;
    codec: string;
    timescale: number;
    audio: { sample_rate: number; channel_count: number };
  }

  interface MP4Sample {
    cts: number;
    dts: number;
    duration: number;
    is_sync: boolean;
    data: ArrayBuffer;
    size: number;
    timescale: number;
  }
}
