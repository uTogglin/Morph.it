// ── Editor Page bootstrap ──────────────────────────────────────────────────────
// Call initEditorPage() from main.ts when navigating to the editor page.

import {
  createProject,
  createTrack,
  createClip,
  recomputeDuration,
  cloneProject,
  clipTimelineDuration,
  PlaybackEngine,
  ColorGradingPanel,
  GraphEditorPanel,
  Exporter,
  createTextTrack,
  createTextClip,
  textClipActiveAt,
  TextInspectorPanel,
  TextEditOverlay,
  type Project,
  type Clip,
  type Track,
  type EngineState,
  type TextClip,
} from './editor/index.ts';

// ── Toast notification ────────────────────────────────────────────────────────

export function showToast(message: string, durationMs = 5000): void {
  const toast = document.createElement('div');
  toast.className = 'editor-toast';
  toast.textContent = message;

  const closeBtn = document.createElement('button');
  closeBtn.textContent = '×';
  closeBtn.setAttribute('aria-label', 'Dismiss');
  closeBtn.addEventListener('click', () => toast.remove());
  toast.appendChild(closeBtn);

  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), durationMs);
}
import { AudioTrackPanel } from './editor/AudioTrackPanel.ts';
import { WaveformCache }   from './editor/WaveformCache.ts';
import { ThumbnailCache }  from './editor/ThumbnailCache.ts';

import type { TimelineRenderer }   from './editor/TimelineRenderer.ts';
import type { TimelineController } from './editor/TimelineController.ts';

// ── Module state ──────────────────────────────────────────────────────────────

let initialized     = false;
let project         : Project           | null = null;
let engine          : PlaybackEngine    | null = null;
let tlRenderer      : TimelineRenderer  | null = null;
let tlController    : TimelineController| null = null;
let gradingPanel    : ColorGradingPanel | null = null;
let graphEditor     : GraphEditorPanel  | null = null;
let audioPanel      : AudioTrackPanel   | null = null;
let waveformCache   : WaveformCache     | null = null;
let thumbnailCache  : ThumbnailCache    | null = null;
let timelineZoom        = 100;
let selectedClipId      : string | null = null;
let selectedTextClipId  : string | null = null;
let exportAbort         : AbortController | null = null;
let textInspectorPanel  : TextInspectorPanel | null = null;
let textEditOverlay     : TextEditOverlay    | null = null;

// ── History (undo/redo) ───────────────────────────────────────────────────────

const HISTORY_MAX = 50;
const historyStack: Project[] = [];
let   historyIndex = -1;

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatTime(s: number): string {
  const m  = Math.floor(s / 60);
  const ss = Math.floor(s % 60);
  const d  = Math.floor((s % 1) * 10);
  return `${String(m).padStart(2,'0')}:${String(ss).padStart(2,'0')}.${d}`;
}

function el<T extends HTMLElement>(id: string): T {
  const n = document.getElementById(id);
  if (!n) throw new Error(`[editor-page] missing #${id}`);
  return n as T;
}

/**
 * Probe the real duration of a media file without keeping a decoder alive.
 * Falls back to 60 s on error or non-finite duration.
 */
function probeMediaDuration(file: File): Promise<number> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const v   = document.createElement('video');
    v.preload = 'metadata';
    v.onloadedmetadata = () => {
      URL.revokeObjectURL(url);
      resolve(isFinite(v.duration) && v.duration > 0 ? v.duration : 60);
    };
    v.onerror = () => { URL.revokeObjectURL(url); resolve(60); };
    v.src = url;
  });
}

/** Returns true when an input/select/textarea is focused (suppress shortcuts). */
function isInputFocused(): boolean {
  const tag = document.activeElement?.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

// ── Init ──────────────────────────────────────────────────────────────────────

export function initEditorPage(): void {
  if (initialized) return;
  initialized = true;

  project = createProject('Untitled Project');

  // ── DOM ─────────────────────────────────────────────────────────────────────
  const previewCanvas  = el<HTMLCanvasElement>('editor-preview-canvas');
  const timelineCanvas = el<HTMLCanvasElement>('editor-timeline-canvas');
  const rulerCanvas    = el<HTMLCanvasElement>('editor-timeline-ruler');
  const trackLabels    = el<HTMLDivElement>('editor-track-labels');
  const fileInput      = el<HTMLInputElement>('editor-file-input');
  const currentTimeEl  = el<HTMLSpanElement>('editor-current-time');
  const durationEl     = el<HTMLSpanElement>('editor-duration');
  const dropHint       = el<HTMLDivElement>('editor-drop-hint');
  const emptyTimeline  = el<HTMLDivElement>('editor-empty-timeline');
  const inspectorBody  = el<HTMLDivElement>('editor-inspector-body');
  const exportProgress = el<HTMLDivElement>('editor-export-progress');
  const exportBar      = el<HTMLDivElement>('editor-export-bar');
  const exportPct      = el<HTMLSpanElement>('editor-export-pct');
  const exportCancelBtn  = el<HTMLButtonElement>('editor-export-cancel-btn');
  const keybindsBtn      = el<HTMLButtonElement>('editor-keybinds-btn');
  const keybindsModal    = el<HTMLDivElement>('editor-keybinds-modal');
  const keybindsClose    = el<HTMLButtonElement>('editor-keybinds-close');
  const appFsBtn         = el<HTMLButtonElement>('editor-app-fs-btn');
  const videoFsBtn       = el<HTMLButtonElement>('editor-video-fs-btn');
  const previewCanvasArea = previewCanvas.closest('.editor-preview-canvas-area') as HTMLElement;

  const playBtn        = el<HTMLButtonElement>('editor-play-btn');
  const pauseBtn       = el<HTMLButtonElement>('editor-pause-btn');
  const newBtn         = el<HTMLButtonElement>('editor-new-btn');
  const openBtn        = el<HTMLButtonElement>('editor-open-btn');
  const saveBtn        = el<HTMLButtonElement>('editor-save-btn');
  const exportBtn      = el<HTMLButtonElement>('editor-export-btn');
  const zoomInBtn      = el<HTMLButtonElement>('editor-zoom-in-btn');
  const zoomOutBtn     = el<HTMLButtonElement>('editor-zoom-out-btn');
  const dropHintOpen   = el<HTMLButtonElement>('editor-drop-hint-open');

  // ── Caches ────────────────────────────────────────────────────────────────
  waveformCache  = new WaveformCache();
  thumbnailCache = new ThumbnailCache();

  // ── PlaybackEngine ────────────────────────────────────────────────────────
  engine = new PlaybackEngine(project, previewCanvas, {
    onTimeUpdate(time: number) {
      currentTimeEl.textContent = formatTime(time);
      // Update diamond fill states in color grading panel
      gradingPanel?.updatePlayheadTime(time);
      // Refresh graph editor playhead line
      graphEditor?.refresh();
      // Auto-scroll timeline to keep playhead visible during playback
      if (tlController && tlRenderer) {
        const s = tlController.state;
        const viewW = timelineCanvas.clientWidth - 160; // subtract TRACK_HEADER_WIDTH
        if (viewW > 0) {
          const playheadPx = (time - s.scrollX) * s.zoom;
          if (playheadPx < 0 || playheadPx > viewW * 0.8) {
            s.scrollX = Math.max(0, time - (viewW * 0.2) / s.zoom);
            tlRenderer.syncState(s);
          }
        }
      }
      tlRenderer?.render(time);
    },
    onEnded()                          { syncPlayPauseButtons('paused'); },
    onStateChange(s: EngineState)      { syncPlayPauseButtons(s); },
    onWarning: showToast,
  });

  // ── History helpers ───────────────────────────────────────────────────────

  function snapshot(): void {
    if (!project) return;
    historyStack.splice(historyIndex + 1);
    historyStack.push(cloneProject(project));
    if (historyStack.length > HISTORY_MAX) historyStack.shift();
    historyIndex = historyStack.length - 1;
  }

  function applyProject(p: Project): void {
    project = p;
    engine?.updateProject(project);
    if (tlController) tlController.setProject(project);
    if (tlRenderer) {
      tlRenderer.setProject(project);
      tlRenderer.render(engine?.time ?? 0);
    }
    refreshDuration();
    refreshTrackLabels();
    checkEmptyState();
    updateInspector(selectedClipId);
  }

  function undo(): void {
    if (historyIndex <= 0) return;
    historyIndex--;
    applyProject(cloneProject(historyStack[historyIndex]));
  }

  function redo(): void {
    if (historyIndex >= historyStack.length - 1) return;
    historyIndex++;
    applyProject(cloneProject(historyStack[historyIndex]));
  }

  // ── Panel "dirty" guard ───────────────────────────────────────────────────
  let panelDirty = false;

  // ── Inspector panels ─────────────────────────────────────────────────────

  gradingPanel = new ColorGradingPanel(inspectorBody, (clip: Clip) => {
    if (!project || !engine) return;
    if (!panelDirty) { snapshot(); panelDirty = true; }
    // Speed changes alter timeline layout — always recompute duration
    project.duration   = recomputeDuration(project);
    project.modifiedAt = Date.now();
    engine.updateProject(project);
    if (tlController) tlController.setProject(project);
    if (tlRenderer) tlRenderer.setProject(project);
    tlRenderer?.render(engine.time);
    refreshDuration();
  }, showToast, (clip: Clip, property: string) => {
    // onKeyframeSelect: open the graph editor for this property
    graphEditor?.show(clip, property);
  });

  audioPanel = new AudioTrackPanel(inspectorBody, engine.audioMixer, (trackId: string) => {
    if (!project || !engine) return;
    if (!panelDirty) { snapshot(); panelDirty = true; }
    project.modifiedAt = Date.now();
    engine.updateProject(project);
    void trackId;
  });

  gradingPanel.render(null);

  // ── Graph Editor Panel ────────────────────────────────────────────────────
  // Append below the timeline wrap inside the workspace.
  const graphEditorContainer =
    (timelineCanvas.closest('.editor-timeline-wrap')?.parentElement as HTMLElement | null)
    ?? (timelineCanvas.closest('.editor-workspace') as HTMLElement | null)
    ?? document.body;

  // graphEditor needs timelineState — provide a live reference via a proxy object
  // that delegates to tlController.state once it's available.
  const liveTimelineState = new Proxy({} as import('./editor/TimelineController.ts').TimelineState, {
    get(_target, prop: string) {
      if (tlController) {
        return (tlController.state as unknown as Record<string, unknown>)[prop];
      }
      // Fallback defaults before tlController loads
      const defaults: Record<string, unknown> = {
        zoom: 100, scrollX: 0, scrollY: 0, playheadTime: 0, selectedClipIds: new Set(),
      };
      return defaults[prop];
    },
  });

  graphEditor = new GraphEditorPanel(
    graphEditorContainer,
    liveTimelineState as import('./editor/TimelineController.ts').TimelineState,
    () => {
      // onChange: push undo snapshot and re-render preview
      if (!project || !engine) return;
      snapshot();
      project.modifiedAt = Date.now();
      engine.updateProject(project);
      void engine.seekTo(engine.time); // force re-render at current time
    },
  );

  // ── Text Inspector Panel ──────────────────────────────────────────────────
  const textInspectorContainer = document.createElement('div');
  inspectorBody.appendChild(textInspectorContainer);
  textInspectorPanel = new TextInspectorPanel(
    textInspectorContainer,
    (clip: TextClip) => {
      if (!project || !engine) return;
      if (!panelDirty) { snapshot(); panelDirty = true; }
      project.modifiedAt = Date.now();
      engine.updateProject(project);
      void engine.seekTo(engine.time);
      tlRenderer?.render(engine.time);
    },
    project?.width ?? 1920,
  );

  // ── Text Edit Overlay ─────────────────────────────────────────────────────
  textEditOverlay = new TextEditOverlay(previewCanvas);

  // ── Text clip helpers ─────────────────────────────────────────────────────

  function getSelectedTextClip(): TextClip | null {
    if (!project || !selectedTextClipId) return null;
    for (const track of project.tracks) {
      if (track.kind !== 'text' || !track.textClips) continue;
      const clip = track.textClips.find(c => c.id === selectedTextClipId);
      if (clip) return clip;
    }
    return null;
  }

  function showTextInspector(clip: TextClip): void {
    gradingPanel?.render(null);
    textInspectorPanel?.show(clip);
  }

  function hideTextInspector(): void {
    textInspectorPanel?.hide();
  }

  // ── Lazy-load TimelineRenderer / TimelineController ───────────────────────
  (async () => {
    try {
      const [{ TimelineRenderer: TR }, { TimelineController: TC }] = await Promise.all([
        import('./editor/TimelineRenderer.ts'),
        import('./editor/TimelineController.ts'),
      ]);

      tlRenderer = new TR(timelineCanvas, rulerCanvas, { pixelsPerSecond: timelineZoom });

      if (waveformCache)  tlRenderer.setWaveformCache(waveformCache);
      if (thumbnailCache) tlRenderer.setThumbnailCache(thumbnailCache);

      tlController = new TC(timelineCanvas, {
        onSeek(time: number) {
          void engine?.seekTo(time);
        },
        onZoomChange(pps: number) {
          timelineZoom = pps;
          graphEditor?.refresh();
        },
        onBeforeChange() {
          snapshot();
        },
        onSelectionChanged(ids: Set<string>) {
          const clipId = ids.size === 1 ? [...ids][0] : null;
          updateInspector(clipId);
          timelineCanvas.dispatchEvent(
            new CustomEvent('editor:clipselect', { detail: { clipId } }),
          );
          // Hide graph editor when no clip is selected
          if (!clipId) graphEditor?.hide();
        },
        onChange() {
          if (tlRenderer && tlController) {
            tlRenderer.syncState(tlController.state);
            tlRenderer.render(engine?.time ?? 0);
          }
          // Recompute duration after clip moves/trims
          if (project) {
            project.duration = recomputeDuration(project);
            refreshDuration();
          }
          // Refresh graph editor on scroll/zoom changes
          graphEditor?.refresh();
        },
      });

      if (project) {
        tlController.setProject(project);
        tlRenderer.setProject(project);
        tlRenderer.render(engine?.time ?? 0);
      }
    } catch (err) {
      console.error('[editor] timeline init failed:', err);
    }
  })();

  // ── UI helpers ────────────────────────────────────────────────────────────

  function refreshDuration(): void {
    durationEl.textContent = formatTime(project?.duration ?? 0);
  }

  function syncPlayPauseButtons(state: EngineState | 'paused'): void {
    const playing = state === 'playing';
    playBtn.disabled  =  playing;
    pauseBtn.disabled = !playing;
  }

  function refreshTrackLabels(): void {
    if (!project) return;
    trackLabels.innerHTML = '';
    for (const track of project.tracks) {
      const div = document.createElement('div');
      div.className = 'editor-track-label';
      div.title = track.name;
      const iconPath = track.kind === 'video'
        ? '<polygon points="23 7 16 12 23 17 23 7"></polygon><rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect>'
        : '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/>';
      div.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${iconPath}</svg>`;
      div.insertAdjacentText('beforeend', track.name);
      trackLabels.appendChild(div);
    }
  }

  function checkEmptyState(): void {
    if (!project) return;
    const hasMedia = project.tracks.some((t: Track) => t.clips.length > 0);
    dropHint.classList.toggle('hidden', hasMedia);
    emptyTimeline.classList.toggle('hidden', hasMedia);
  }

  function getClipAndTrack(clipId: string | null): { clip: Clip; track: Track } | null {
    if (!project || !clipId) return null;
    for (const track of project.tracks) {
      const clip = track.clips.find((c: Clip) => c.id === clipId);
      if (clip) return { clip, track };
    }
    return null;
  }

  function updateInspector(clipId: string | null): void {
    selectedClipId = clipId;
    panelDirty = false;

    // Clear text selection when a non-text clip is selected
    selectedTextClipId = null;
    hideTextInspector();

    const found = getClipAndTrack(clipId);
    if (!found) {
      gradingPanel?.render(null);
      graphEditor?.hide();
      return;
    }
    if (found.track.kind === 'audio') {
      audioPanel?.render(found.track);
    } else {
      gradingPanel?.render(found.clip, 'video');
    }
  }

  // ── Split clip at playhead ────────────────────────────────────────────────

  function splitClipAtPlayhead(): void {
    if (!project || !tlController || !engine) return;
    const selectedIds = tlController.state.selectedClipIds;
    if (selectedIds.size === 0) return;

    const playhead = engine.time;
    let didSplit = false;

    snapshot();

    // Collect clips to split (including their linked counterparts)
    const toSplit = new Set<string>(selectedIds);
    for (const track of project.tracks) {
      for (const clip of track.clips) {
        if (selectedIds.has(clip.id) && clip.linkedClipId) {
          toSplit.add(clip.linkedClipId);
        }
      }
    }

    // Map original clip id → [left new id, right new id] for cross-link patching
    const splitMap = new Map<string, [string, string]>();

    for (const track of project.tracks) {
      const newClips: Clip[] = [];
      for (const clip of track.clips) {
        if (!toSplit.has(clip.id)) { newClips.push(clip); continue; }

        const clipEnd = clip.timelineStart + clipTimelineDuration(clip);
        if (playhead <= clip.timelineStart || playhead >= clipEnd) {
          newClips.push(clip);
          continue;
        }

        const elapsed = playhead - clip.timelineStart;
        const splitSourceTime = clip.speed >= 0
          ? clip.sourceStart + elapsed * clip.speed
          : clip.sourceEnd   + elapsed * clip.speed;

        const leftId  = crypto.randomUUID();
        const rightId = crypto.randomUUID();

        const left: Clip  = { ...clip, id: leftId,  sourceEnd:   splitSourceTime, timelineStart: clip.timelineStart, linkedClipId: undefined };
        const right: Clip = { ...clip, id: rightId, sourceStart: splitSourceTime, timelineStart: playhead,           linkedClipId: undefined };

        newClips.push(left, right);
        splitMap.set(clip.id, [leftId, rightId]);
        didSplit = true;
      }
      track.clips = newClips;
    }

    // Patch linkedClipId: each new half links to the matching half of its pair
    for (const track of project.tracks) {
      for (const clip of track.clips) {
        if (!clip.linkedClipId) continue;
        const pair = splitMap.get(clip.linkedClipId);
        if (!pair) continue;
        const [leftId, rightId] = pair;
        clip.linkedClipId = clip.timelineStart >= playhead ? rightId : leftId;
      }
    }

    if (!didSplit) return;

    project.duration   = recomputeDuration(project);
    project.modifiedAt = Date.now();

    tlController.selectClips(new Set());
    engine.updateProject(project);
    tlController.setProject(project);
    if (tlRenderer) {
      tlRenderer.setProject(project);
      tlRenderer.render(engine.time);
    }
    refreshDuration();
  }

  // ── Delete selected clips ─────────────────────────────────────────────────

  function deleteSelectedClips(): void {
    if (!project || !tlController) return;
    const selectedIds = tlController.state.selectedClipIds;
    if (selectedIds.size === 0) return;

    snapshot();

    // Also collect linked clip IDs so they delete together
    const allDeleteIds = new Set(selectedIds);
    for (const track of project.tracks) {
      for (const clip of track.clips) {
        if (selectedIds.has(clip.id) && clip.linkedClipId) {
          allDeleteIds.add(clip.linkedClipId);
        }
      }
    }

    for (const track of project.tracks) {
      track.clips = track.clips.filter((c: Clip) => {
        if (allDeleteIds.has(c.id)) {
          waveformCache?.evict(c.id);
          thumbnailCache?.evict(c.id);
          return false;
        }
        return true;
      });
    }

    project.duration   = recomputeDuration(project);
    project.modifiedAt = Date.now();

    tlController.selectClips(new Set());
    updateInspector(null);

    engine?.updateProject(project);
    tlController.setProject(project);
    if (tlRenderer) {
      tlRenderer.setProject(project);
      tlRenderer.render(engine?.time ?? 0);
    }
    refreshDuration();
    refreshTrackLabels();
    checkEmptyState();
  }

  // ── Open files ────────────────────────────────────────────────────────────

  async function openFiles(files: FileList | null): Promise<void> {
    if (!files || files.length === 0 || !project || !engine) return;

    snapshot();

    const videoFiles = Array.from(files).filter(f => f.type.startsWith('video/'));
    const audioFiles = Array.from(files).filter(f => f.type.startsWith('audio/'));
    const allFiles   = [...videoFiles, ...audioFiles];

    const durations   = await Promise.all(allFiles.map(probeMediaDuration));
    const durationMap = new Map(allFiles.map((f, i) => [f, durations[i]]));

    let insertAt = project.duration;

    // For video files: create video clip + linked audio clip on a paired track
    function addVideoWithLinkedAudio(fileList: File[]): void {
      if (!fileList.length) return;
      // Find or create the primary (unlinked) video track
      let videoTrack = project!.tracks.find((t: Track) => t.kind === 'video' && !t.locked && !t.linkedTrackId);
      if (!videoTrack) {
        videoTrack = createTrack('video');
        project!.tracks.push(videoTrack);
      }
      // Find or create the paired audio track immediately below it
      let audioTrack: Track;
      if (videoTrack.linkedTrackId) {
        audioTrack = project!.tracks.find((t: Track) => t.id === videoTrack!.linkedTrackId) ?? createTrack('audio');
      } else {
        audioTrack = createTrack('audio');
        audioTrack.name = videoTrack.name.replace('Video', 'Audio');
        const videoIdx = project!.tracks.indexOf(videoTrack);
        project!.tracks.splice(videoIdx + 1, 0, audioTrack);
        videoTrack.linkedTrackId = audioTrack.id;
        audioTrack.linkedTrackId = videoTrack.id;
      }
      for (const file of fileList) {
        const dur       = durationMap.get(file) ?? 60;
        const videoClip = createClip(file, videoTrack!.id, 0, dur, insertAt);
        const audioClip = createClip(file, audioTrack.id,  0, dur, insertAt);
        videoClip.linkedClipId = audioClip.id;
        audioClip.linkedClipId = videoClip.id;
        videoTrack!.clips.push(videoClip);
        audioTrack.clips.push(audioClip);
        insertAt += dur;
        if (waveformCache) {
          waveformCache.requestDecode(audioClip.id, file, () => {
            if (tlRenderer && engine) tlRenderer.render(engine.time);
          });
        }
      }
    }

    function addAudioClips(fileList: File[]): void {
      if (!fileList.length) return;
      let track = project!.tracks.find((t: Track) => t.kind === 'audio' && !t.locked && !t.linkedTrackId);
      if (!track) {
        track = createTrack('audio');
        project!.tracks.push(track);
      }
      for (const file of fileList) {
        const dur  = durationMap.get(file) ?? 60;
        const clip = createClip(file, track!.id, 0, dur, insertAt);
        track!.clips.push(clip);
        insertAt += dur;
        if (waveformCache) {
          waveformCache.requestDecode(clip.id, file, () => {
            if (tlRenderer && engine) tlRenderer.render(engine.time);
          });
        }
      }
    }

    addVideoWithLinkedAudio(videoFiles);
    addAudioClips(audioFiles);

    project.duration   = recomputeDuration(project);
    project.modifiedAt = Date.now();

    engine.updateProject(project);
    if (tlController) tlController.setProject(project);
    if (tlRenderer) {
      tlRenderer.setProject(project);
      tlRenderer.render(engine.time);
    }

    refreshDuration();
    refreshTrackLabels();
    checkEmptyState();
  }

  // ── Export ────────────────────────────────────────────────────────────────

  function showExportProgress(show: boolean): void {
    exportProgress.classList.toggle('hidden', !show);
    exportBtn.disabled  =  show;
    playBtn.disabled    =  show;
    pauseBtn.disabled   =  show;
    openBtn.disabled    =  show;
  }

  function updateExportProgress(p: number): void {
    const pct = Math.round(p * 100);
    exportBar.style.width  = pct + '%';
    exportPct.textContent  = pct + '%';
  }

  async function runExport(): Promise<void> {
    if (!project || !engine) return;
    if (project.duration <= 0) {
      alert('Nothing to export — add some video clips first.');
      return;
    }
    engine.pause();
    exportAbort = new AbortController();
    showExportProgress(true);
    updateExportProgress(0);
    try {
      const result = await Exporter.export(project, {
        signal: exportAbort.signal,
        onProgress: updateExportProgress,
        onWarning: showToast,
      });
      const url = URL.createObjectURL(result.blob);
      const a   = document.createElement('a');
      a.href = url; a.download = result.filename; a.click();
      URL.revokeObjectURL(url);
    } catch (err: unknown) {
      if (!(err instanceof DOMException && err.name === 'AbortError')) {
        alert(`Export failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    } finally {
      exportAbort = null;
      showExportProgress(false);
    }
  }

  // ── Save project manifest ─────────────────────────────────────────────────

  function saveProject(): void {
    if (!project) return;
    const json = JSON.stringify({ ...project, tracks: project.tracks.map((t: Track) => ({
      ...t, clips: t.clips.map((c: Clip) => ({ ...c, sourceFile: c.sourceFile.name })),
    })) }, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url;
    a.download = `${project.name.replace(/[^\w\s.-]/g, '').replace(/\s+/g, '_').slice(0, 80) || 'project'}.morphit.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ── Keyboard shortcuts ────────────────────────────────────────────────────

  document.addEventListener('keydown', (e: KeyboardEvent) => {
    const mod = e.ctrlKey || e.metaKey;

    // Undo / redo (always active)
    if (mod && !e.shiftKey && e.key === 'z') { e.preventDefault(); undo(); return; }
    if (mod && (e.key === 'y' || (e.shiftKey && e.key === 'z'))) { e.preventDefault(); redo(); return; }

    // Remaining shortcuts are suppressed when a text input has focus
    if (isInputFocused()) return;

    // Space = play / pause toggle
    if (e.key === ' ') {
      e.preventDefault();
      if (engine?.playing) engine.pause(); else void engine?.play();
      return;
    }

    // ? = show keybindings
    if (e.key === '?') {
      e.preventDefault();
      keybindsModal.classList.toggle('hidden');
      return;
    }

    // Escape = close modal
    if (e.key === 'Escape') {
      if (!keybindsModal.classList.contains('hidden')) {
        keybindsModal.classList.add('hidden');
        return;
      }
    }

    // S = split selected clip(s) at playhead
    if (e.key === 's' || e.key === 'S') {
      e.preventDefault();
      splitClipAtPlayhead();
      return;
    }

    // Delete / Backspace = remove selected clips
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      deleteSelectedClips();
      return;
    }

    // Arrow keys = frame step (Shift = 10 frames)
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      if (!engine || !project) return;
      const frameRate  = project.frameRate;
      const frameStep  = (e.shiftKey ? 10 : 1) / frameRate;
      const direction  = e.key === 'ArrowLeft' ? -1 : 1;
      void engine.seekTo(Math.max(0, Math.min(project.duration, engine.time + direction * frameStep)));
      return;
    }
  });

  // ── Events ────────────────────────────────────────────────────────────────

  newBtn.addEventListener('click', () => {
    if (engine) { engine.pause(); engine.dispose(); }
    waveformCache?.clear();
    thumbnailCache?.clear();
    project        = createProject('Untitled Project');
    selectedClipId = null;
    historyStack.length = 0;
    historyIndex   = -1;
    engine = new PlaybackEngine(project, previewCanvas, {
      onTimeUpdate(time: number) {
        currentTimeEl.textContent = formatTime(time);
        tlRenderer?.render(time);
      },
      onEnded()                          { syncPlayPauseButtons('paused'); },
      onStateChange(s: EngineState)      { syncPlayPauseButtons(s); },
    });
    if (audioPanel) {
      audioPanel = new AudioTrackPanel(inspectorBody, engine.audioMixer, (tid: string) => {
        if (!project || !engine) return;
        if (!panelDirty) { snapshot(); panelDirty = true; }
        project.modifiedAt = Date.now();
        engine.updateProject(project);
        void tid;
      });
    }
    currentTimeEl.textContent = formatTime(0);
    gradingPanel?.render(null);
    tlController?.setProject(project);
    tlRenderer?.setProject(project);
    tlRenderer?.render(0);
    refreshDuration();
    refreshTrackLabels();
    checkEmptyState();
  });

  openBtn.addEventListener('click',      () => fileInput.click());
  dropHintOpen.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change',   () => { void openFiles(fileInput.files); fileInput.value = ''; });

  saveBtn.addEventListener('click',      saveProject);
  exportBtn.addEventListener('click',    () => { void runExport(); });
  exportCancelBtn.addEventListener('click', () => { exportAbort?.abort(); });

  keybindsBtn.addEventListener('click',   () => keybindsModal.classList.remove('hidden'));
  keybindsClose.addEventListener('click', () => keybindsModal.classList.add('hidden'));
  keybindsModal.addEventListener('click', (e) => { if (e.target === keybindsModal) keybindsModal.classList.add('hidden'); });

  const appFsSvgExpand  = '<polyline points="15 3 21 3 21 9"></polyline><polyline points="9 21 3 21 3 15"></polyline><line x1="21" y1="3" x2="14" y2="10"></line><line x1="3" y1="21" x2="10" y2="14"></line>';
  const appFsSvgCompress = '<polyline points="4 14 10 14 10 20"></polyline><polyline points="20 10 14 10 14 4"></polyline><line x1="10" y1="14" x2="3" y2="21"></line><line x1="21" y1="3" x2="14" y2="10"></line>';

  document.addEventListener('fullscreenchange', () => {
    const inner = appFsBtn.querySelector('svg');
    if (inner) inner.innerHTML = document.fullscreenElement ? appFsSvgCompress : appFsSvgExpand;
  });

  appFsBtn.addEventListener('click', () => {
    const editorPage = el<HTMLElement>('editor-page');
    if (!document.fullscreenElement) {
      void editorPage.requestFullscreen();
    } else {
      void document.exitFullscreen();
    }
  });

  videoFsBtn.addEventListener('click', () => {
    if (!document.fullscreenElement) {
      void previewCanvasArea.requestFullscreen();
    } else {
      void document.exitFullscreen();
    }
  });

  playBtn.addEventListener('click',  () => { void engine?.play(); });
  pauseBtn.addEventListener('click', () => { engine?.pause(); });

  zoomInBtn.addEventListener('click', () => {
    timelineZoom = Math.min(timelineZoom * 1.5, 1000);
    tlController?.setZoom(timelineZoom);
    if (tlRenderer && tlController) {
      tlRenderer.syncState(tlController.state);
      tlRenderer.render(engine?.time ?? 0);
    }
  });

  zoomOutBtn.addEventListener('click', () => {
    timelineZoom = Math.max(timelineZoom / 1.5, 10);
    tlController?.setZoom(timelineZoom);
    if (tlRenderer && tlController) {
      tlRenderer.syncState(tlController.state);
      tlRenderer.render(engine?.time ?? 0);
    }
  });

  // ── Add Text button ───────────────────────────────────────────────────────

  const addTextBtn = document.getElementById('editor-add-text-btn') as HTMLButtonElement | null;
  addTextBtn?.addEventListener('click', () => {
    if (!project || !engine) return;
    snapshot();

    // Find or create a text track
    let textTrack = project.tracks.find(t => t.kind === 'text' && !t.locked);
    if (!textTrack) {
      textTrack = createTextTrack('Text Track');
      project.tracks.push(textTrack);
    }

    // Create a 3-second text clip at playhead position
    const clipStart = engine.time;
    const newClip   = createTextClip(textTrack.id, clipStart, 3, 'Text');
    if (!textTrack.textClips) textTrack.textClips = [];
    textTrack.textClips.push(newClip);

    project.duration   = recomputeDuration(project);
    project.modifiedAt = Date.now();

    engine.updateProject(project);
    if (tlController) tlController.setProject(project);
    if (tlRenderer) {
      tlRenderer.setProject(project);
      tlRenderer.render(engine.time);
    }
    refreshDuration();
    refreshTrackLabels();
    checkEmptyState();

    // Select the new text clip
    selectedTextClipId = newClip.id;
    showTextInspector(newClip);

    showToast('Text clip added. Double-click the preview to edit text content.');
  });

  // ── Preview canvas: text clip drag-to-position and double-click to edit ───

  let textDragActive   = false;
  let textDragLastX    = 0;
  let textDragLastY    = 0;
  let textDragHadMove  = false;

  // Convert a pointer event on the preview canvas to canvas-space coordinates.
  function canvasPoint(e: PointerEvent): { cx: number; cy: number } {
    const rect   = previewCanvas.getBoundingClientRect();
    const scaleX = previewCanvas.width  / rect.width;
    const scaleY = previewCanvas.height / rect.height;
    return {
      cx: (e.clientX - rect.left) * scaleX,
      cy: (e.clientY - rect.top)  * scaleY,
    };
  }

  // Whether a canvas point is inside the text clip's rough bounding box.
  function hitTestTextClip(clip: TextClip, cx: number, cy: number): boolean {
    const halfW = Math.max(clip.style.fontSize * clip.content.length * 0.5, 60);
    const halfH = clip.style.fontSize;
    return (
      cx >= clip.x - halfW && cx <= clip.x + halfW &&
      cy >= clip.y - halfH && cy <= clip.y + halfH
    );
  }

  previewCanvas.addEventListener('pointerdown', (e: PointerEvent) => {
    if (textEditOverlay?.isEditing) return;

    const textClip = getSelectedTextClip();
    if (!textClip || !engine) return;
    if (!textClipActiveAt(textClip, engine.time)) return;

    const { cx, cy } = canvasPoint(e);
    if (!hitTestTextClip(textClip, cx, cy)) return;

    textDragActive  = true;
    textDragLastX   = e.clientX;
    textDragLastY   = e.clientY;
    textDragHadMove = false;
    previewCanvas.setPointerCapture(e.pointerId);
    e.preventDefault();
  });

  previewCanvas.addEventListener('pointermove', (e: PointerEvent) => {
    if (!textDragActive) return;
    const textClip = getSelectedTextClip();
    if (!textClip || !engine) return;

    const rect   = previewCanvas.getBoundingClientRect();
    const scaleX = previewCanvas.width  / rect.width;
    const scaleY = previewCanvas.height / rect.height;
    const dx = (e.clientX - textDragLastX) * scaleX;
    const dy = (e.clientY - textDragLastY) * scaleY;

    textDragLastX = e.clientX;
    textDragLastY = e.clientY;
    textDragHadMove = true;

    textClip.x += dx;
    textClip.y += dy;

    // Throttle re-render to rAF
    requestAnimationFrame(() => {
      if (!engine) return;
      engine.updateProject(project!);
      void engine.seekTo(engine.time);
      tlRenderer?.render(engine.time);
      textInspectorPanel?.update(textClip);
    });

    e.preventDefault();
  });

  previewCanvas.addEventListener('pointerup', (e: PointerEvent) => {
    if (!textDragActive) return;
    textDragActive = false;
    if (textDragHadMove) {
      // Commit drag to undo history
      snapshot();
      if (project) project.modifiedAt = Date.now();
    }
    e.preventDefault();
  });

  // Double-click on preview canvas: enter in-place text edit mode
  previewCanvas.addEventListener('dblclick', (e: MouseEvent) => {
    if (!engine) return;
    const textClip = getSelectedTextClip();
    if (!textClip) return;
    if (!textClipActiveAt(textClip, engine.time)) return;

    const rect = previewCanvas.getBoundingClientRect();
    const scaleX = previewCanvas.width  / rect.width;
    const scaleY = previewCanvas.height / rect.height;
    const cx = (e.clientX - rect.left) * scaleX;
    const cy = (e.clientY - rect.top)  * scaleY;

    if (!hitTestTextClip(textClip, cx, cy)) return;

    if (!textEditOverlay) return;
    void textEditOverlay.startEdit(textClip, (newContent: string) => {
      if (!project || !engine) return;
      snapshot();
      textClip.content = newContent;
      project.modifiedAt = Date.now();
      engine.updateProject(project);
      void engine.seekTo(engine.time);
      tlRenderer?.render(engine.time);
      textInspectorPanel?.show(textClip);
    });
  });

  // ── Delete text clips via keyboard ────────────────────────────────────────
  // (Augment existing Delete/Backspace handler above with text clip support)
  // Text clip deletion is handled in the keydown listener as part of a
  // dedicated check that fires before deleteSelectedClips():
  // We patch the keydown handler below by listening on a separate handler.
  document.addEventListener('keydown', (e: KeyboardEvent) => {
    if ((e.key === 'Delete' || e.key === 'Backspace') && !isInputFocused()) {
      if (textEditOverlay?.isEditing) return;
      const textClip = getSelectedTextClip();
      if (!textClip || !project || !engine) return;

      e.stopImmediatePropagation(); // prevent deleteSelectedClips from also firing
      snapshot();

      for (const track of project.tracks) {
        if (track.kind === 'text' && track.textClips) {
          track.textClips = track.textClips.filter(c => c.id !== textClip.id);
        }
      }

      selectedTextClipId = null;
      hideTextInspector();

      project.duration   = recomputeDuration(project);
      project.modifiedAt = Date.now();

      engine.updateProject(project);
      if (tlController) tlController.setProject(project);
      if (tlRenderer) {
        tlRenderer.setProject(project);
        tlRenderer.render(engine.time);
      }
      refreshDuration();
    }
  }, true); // capture phase so we can stopImmediatePropagation

  // ── Text clip timeline click selection ────────────────────────────────────
  // TimelineController emits hits via onSelectionChanged(ids). Text clips
  // have their own id namespace. We listen on a custom event the timeline
  // controller dispatches: 'editor:textclipselect' with { textClipId }.
  // If the TimelineController does not yet support text clip hit-testing,
  // we also handle clicks on the timeline canvas directly here via a fallback.
  timelineCanvas.addEventListener('editor:textclipselect' as 'click', (e: Event) => {
    const detail = (e as CustomEvent).detail as { textClipId: string } | undefined;
    if (!detail?.textClipId || !project) return;

    for (const track of project.tracks) {
      if (track.kind === 'text' && track.textClips) {
        const clip = track.textClips.find(c => c.id === detail.textClipId);
        if (clip) {
          selectedTextClipId = clip.id;
          selectedClipId = null; // deselect video/audio clips
          panelDirty = false;
          showTextInspector(clip);
          return;
        }
      }
    }
  });

  const workspace = previewCanvas.closest('.editor-workspace') as HTMLElement | null;
  if (workspace) {
    workspace.addEventListener('dragover',  (e) => { e.preventDefault(); e.dataTransfer!.dropEffect = 'copy'; });
    workspace.addEventListener('drop',      (e) => { e.preventDefault(); void openFiles(e.dataTransfer?.files ?? null); });
  }

  // ── Initial state ─────────────────────────────────────────────────────────
  syncPlayPauseButtons('idle');
  refreshDuration();
  checkEmptyState();
  // Seed history with the clean initial state so the first user action can be undone.
  snapshot();
}
