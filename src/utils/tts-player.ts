/**
 * Shared TTS audio player utilities — word highlighting, timing, sentence teleprompter.
 * Used by speech-tool, ocr-tool, and summarize-tool.
 */

import { spokenWeight } from "../speech-tool.js";

// ── SVG icons ──────────────────────────────────────────────────────────────
export const PLAY_SVG = `<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>`;
export const PAUSE_SVG = `<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg>`;

// ── Types ──────────────────────────────────────────────────────────────────
export interface WordTiming {
  word: string;
  start: number;
  end: number;
  el: HTMLSpanElement;
}

export interface SentenceTiming {
  text: string;
  start: number;
  end: number;
}

// ── Helpers ────────────────────────────────────────────────────────────────
export function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// ── Build word display with spans ──────────────────────────────────────────
export function buildWordSpans(container: HTMLElement, chunks: string[]): HTMLSpanElement[] {
  container.innerHTML = "";
  const spans: HTMLSpanElement[] = [];
  for (let c = 0; c < chunks.length; c++) {
    if (c > 0) container.appendChild(document.createTextNode(" "));
    const tokens = chunks[c].split(/(\s+)/);
    for (const tok of tokens) {
      if (/^\s+$/.test(tok)) {
        container.appendChild(document.createTextNode(tok));
      } else if (tok) {
        const sp = document.createElement("span");
        sp.className = "speech-word";
        sp.textContent = tok;
        container.appendChild(sp);
        spans.push(sp);
      }
    }
  }
  return spans;
}

// ── Build timing map from stream chunks (character-weighted) ────────────
export function buildTimings(
  chunks: Array<{ text: string; samples: number }>,
  sampleRate: number,
  wordSpans: HTMLSpanElement[],
): WordTiming[] {
  const timings: WordTiming[] = [];
  let sampleOffset = 0;
  let spanIdx = 0;

  for (const chunk of chunks) {
    const chunkStart = sampleOffset / sampleRate;
    const chunkEnd = (sampleOffset + chunk.samples) / sampleRate;
    const chunkWords = chunk.text.trim().split(/\s+/).filter(Boolean);

    if (chunkWords.length === 0) {
      sampleOffset += chunk.samples;
      continue;
    }

    // Weight each word's duration by estimated spoken length
    const weights = chunkWords.map(spokenWeight);
    const totalWeight = weights.reduce((a, b) => a + b, 0);
    const chunkDuration = chunkEnd - chunkStart;
    let t = chunkStart;

    for (let i = 0; i < chunkWords.length; i++) {
      const el = wordSpans[spanIdx];
      if (!el) break;
      const dur = (weights[i] / totalWeight) * chunkDuration;
      timings.push({
        word: chunkWords[i],
        start: t,
        end: t + dur,
        el,
      });
      t += dur;
      spanIdx++;
    }
    sampleOffset += chunk.samples;
  }
  return timings;
}

// ── Binary search for active word at a given time ─────────────────────────
export function findWordAtTime(wordTimings: WordTiming[], t: number): number {
  if (wordTimings.length === 0) return -1;
  let lo = 0, hi = wordTimings.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (t < wordTimings[mid].start) hi = mid - 1;
    else if (t >= wordTimings[mid].end) lo = mid + 1;
    else return mid;
  }
  // Past all words — highlight last
  if (t >= wordTimings[wordTimings.length - 1]?.start) return wordTimings.length - 1;
  return -1;
}

// ── Find which sentence is active at a given time ─────────────────────────
export function findSentenceAtTime(sentenceTimings: SentenceTiming[], t: number): number {
  for (let i = 0; i < sentenceTimings.length; i++) {
    if (t >= sentenceTimings[i].start && t < sentenceTimings[i].end) return i;
  }
  if (sentenceTimings.length && t >= sentenceTimings[sentenceTimings.length - 1].start) return sentenceTimings.length - 1;
  return -1;
}

// ── Build sentence navigation spans ───────────────────────────────────────
export function buildSentenceSpans(container: HTMLElement, text: string): HTMLSpanElement[] {
  container.innerHTML = "";
  const spans: HTMLSpanElement[] = [];
  const tokens = text.split(/(\s+)/);
  for (const tok of tokens) {
    if (/^\s+$/.test(tok)) {
      container.appendChild(document.createTextNode(tok));
    } else {
      const sp = document.createElement("span");
      sp.textContent = tok;
      container.appendChild(sp);
      spans.push(sp);
    }
  }
  return spans;
}

// ── Map a global word index to local index within the current sentence ────
export function globalToSentenceWordIdx(
  sentenceTimings: SentenceTiming[],
  globalIdx: number,
  sIdx: number,
): number {
  if (sIdx < 0 || globalIdx < 0) return -1;
  let count = 0;
  for (let i = 0; i < sIdx; i++) {
    count += sentenceTimings[i].text.trim().split(/\s+/).filter(Boolean).length;
  }
  return globalIdx - count;
}

// ── Update word highlight + optional sentence teleprompter ────────────────
export interface HighlightState {
  wordTimings: WordTiming[];
  activeWordIdx: number;
  wordDisplayEl: HTMLElement;
  // Sentence teleprompter (optional — omit for simple word-only highlighting)
  sentenceTimings?: SentenceTiming[];
  activeSentenceIdx?: number;
  sentenceEl?: HTMLElement;
  sentenceWordSpans?: HTMLSpanElement[];
  sentenceActiveIdx?: number;
}

/**
 * Updates word highlighting based on current audio time.
 * Returns the mutated state indices so callers can track them.
 */
export function updateWordHighlight(
  currentTime: number,
  state: HighlightState,
): { activeWordIdx: number; activeSentenceIdx: number; sentenceWordSpans: HTMLSpanElement[]; sentenceActiveIdx: number } {
  let { activeWordIdx, wordTimings, wordDisplayEl } = state;
  let activeSentenceIdx = state.activeSentenceIdx ?? -1;
  let sentenceWordSpans = state.sentenceWordSpans ?? [];
  let sentenceActiveIdx = state.sentenceActiveIdx ?? -1;

  const newIdx = findWordAtTime(wordTimings, currentTime);
  if (newIdx !== activeWordIdx) {
    if (activeWordIdx >= 0 && activeWordIdx < wordTimings.length) {
      wordTimings[activeWordIdx].el.classList.remove("active");
    }
    if (newIdx >= 0) {
      wordTimings[newIdx].el.classList.add("active");
      const el = wordTimings[newIdx].el;
      if (el.offsetTop < wordDisplayEl.scrollTop || el.offsetTop + el.offsetHeight > wordDisplayEl.scrollTop + wordDisplayEl.clientHeight) {
        el.scrollIntoView({ block: "center", behavior: "smooth" });
      }
    }
    activeWordIdx = newIdx;
  }

  // Update sentence teleprompter (if provided)
  if (state.sentenceTimings && state.sentenceEl) {
    const sIdx = findSentenceAtTime(state.sentenceTimings, currentTime);
    if (sIdx !== activeSentenceIdx) {
      activeSentenceIdx = sIdx;
      if (sIdx >= 0) {
        sentenceWordSpans = buildSentenceSpans(state.sentenceEl, state.sentenceTimings[sIdx].text);
      } else {
        state.sentenceEl.textContent = "";
        sentenceWordSpans = [];
      }
      sentenceActiveIdx = -1;
    }
    // Highlight current word in sentence
    const localIdx = globalToSentenceWordIdx(state.sentenceTimings, newIdx, sIdx);
    if (localIdx !== sentenceActiveIdx) {
      if (sentenceActiveIdx >= 0 && sentenceActiveIdx < sentenceWordSpans.length) {
        sentenceWordSpans[sentenceActiveIdx].classList.remove("ocr-sentence-hl");
      }
      if (localIdx >= 0 && localIdx < sentenceWordSpans.length) {
        sentenceWordSpans[localIdx].classList.add("ocr-sentence-hl");
      }
      sentenceActiveIdx = localIdx;
    }
  }

  return { activeWordIdx, activeSentenceIdx, sentenceWordSpans, sentenceActiveIdx };
}

// ── Build sentence timings from chunk metadata ────────────────────────────
export function buildSentenceTimings(
  chunkMeta: Array<{ text: string; samples: number }>,
  sampleRate: number,
): SentenceTiming[] {
  const timings: SentenceTiming[] = [];
  let sampleOffset = 0;
  for (const ch of chunkMeta) {
    const start = sampleOffset / sampleRate;
    const end = (sampleOffset + ch.samples) / sampleRate;
    timings.push({ text: ch.text, start, end });
    sampleOffset += ch.samples;
  }
  return timings;
}
