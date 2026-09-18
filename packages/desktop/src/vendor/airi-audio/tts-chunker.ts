// Adapted from Project AIRI's processors/tts-chunker.ts (MIT).
// The original commit, source hash, and adaptation scope are in provenance.json.

const hardPunctuations = new Set('.。?？!！…⋯～~\n\t\r');
const softPunctuations = new Set(',，、–—:：;；《》「」');
const ellipsisPunctuations = new Set('.…⋯');
const singleDigit = /^\p{Decimal_Number}$/u;
const boost = 2;
const minimumWords = 4;
const maximumWords = 12;

export interface TtsChunkerOptions {
  /** Flush threshold in UTF-16 code units. An indivisible grapheme stays intact. */
  maxCharacters?: number;
}

export interface TtsChunker {
  push: (text: string) => string[];
  finish: () => string[];
}

/**
 * AIRI punctuation/word batching adapted to the client's lossless sentence contract.
 * Concatenating every returned chunk reproduces every pushed string exactly.
 * The final grapheme is retained until another arrives, or finish() establishes EOF,
 * so delta boundaries cannot split combining characters, Hangul jamo, or emoji.
 */
export function createTtsChunker(options: TtsChunkerOptions = {}): TtsChunker {
  const maxCharacters = options.maxCharacters ?? 300;
  if (!Number.isSafeInteger(maxCharacters) || maxCharacters < 1) {
    throw new RangeError('maxCharacters must be a positive safe integer');
  }
  const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  const words = new Intl.Segmenter(undefined, { granularity: 'word' });
  let pending = '';
  let yieldCount = 0;
  let finished = false;

  function wordCount(text: string): number {
    let count = 0;
    for (const word of words.segment(text)) {
      if (word.isWordLike) count++;
    }
    return count;
  }

  function numericBoundary(segments: readonly { segment: string; index: number }[], boundary: number): number {
    for (let index = 0; index < segments.length; index++) {
      if (!singleDigit.test(segments[index]!.segment)) continue;
      const start = segments[index]!.index;
      let next = index + 1;
      // Include an undecided trailing separator too: the next push may turn
      // "123." into "123.45". This also keeps grouped thousands together.
      while (next < segments.length && (singleDigit.test(segments[next]!.segment)
        || segments[next]!.segment === '.' || segments[next]!.segment === ',')) next++;
      const end = segments[next]?.index ?? pending.length;
      if (start < boundary && boundary < end) {
        // Move a normal number to the next chunk. If a number already starts
        // the chunk and crosses the threshold, it is itself over the budget:
        // split at the original grapheme boundary instead of buffering forever.
        return start > 0 ? start : boundary;
      }
      if (start >= boundary) break;
      index = next - 1;
    }
    return boundary;
  }

  function drain(final: boolean): string[] {
    const chunks: string[] = [];
    while (pending) {
      const segments = [...graphemes.segment(pending)];
      // A split high surrogate may become an emoji modifier or a regional
      // indicator and merge with the preceding grapheme when its low half arrives.
      const lastCodeUnit = pending.charCodeAt(pending.length - 1);
      const incompleteSurrogate = lastCodeUnit >= 0xD800 && lastCodeUnit <= 0xDBFF;
      const stableCount = Math.max(0, segments.length - (final ? 0 : incompleteSurrogate ? 2 : 1));
      let cut = 0;
      let limitCut = 0;
      let previousSoft = 0;
      let previousSoftWords = 0;

      for (let index = 0; index < stableCount; index++) {
        const segment = segments[index]!;
        const value = segment.segment;
        const end = segment.index + value.length;
        if (end <= maxCharacters || index === 0) limitCut = end;
        if (end > maxCharacters) break;

        // Intl keeps CRLF together. Test its first character without splitting it.
        const punctuation = value[0]!;
        const hard = hardPunctuations.has(punctuation);
        const soft = softPunctuations.has(punctuation);
        if (!hard && !soft) continue;

        const before = segments[index - 1]?.segment;
        const after = segments[index + 1]?.segment;
        if ((value === '.' || value === ',') && before && singleDigit.test(before)) {
          // A next delta may still turn the separator into part of a number.
          if (after === undefined && !final) break;
          if (after && singleDigit.test(after)) continue;
        }

        let boundary = end;
        if (ellipsisPunctuations.has(value)) {
          // Group the original run; unlike upstream, never rewrite "..." to "…".
          let next = index + 1;
          while (next < segments.length && ellipsisPunctuations.has(segments[next]!.segment)) next++;
          if (next > stableCount || (next === segments.length && !final)) break;
          boundary = segments[next - 1]!.index + segments[next - 1]!.segment.length;
          if (boundary > maxCharacters) break;
          index = next - 1;
        }

        const count = wordCount(pending.slice(0, boundary));
        if (previousSoftWords > minimumWords && count > maximumWords) {
          cut = previousSoft;
          break;
        }
        if (hard || count > maximumWords || (yieldCount < boost && count > 0)) {
          // Keep following whitespace with the sentence. If no next text exists
          // yet, wait rather than manufacture a trailing whitespace-only request.
          let next = index + 1;
          while (next < stableCount && /^\s+$/u.test(segments[next]!.segment)) {
            const whitespaceEnd = segments[next]!.index + segments[next]!.segment.length;
            if (whitespaceEnd > maxCharacters) break;
            boundary = whitespaceEnd;
            next++;
          }
          if (final || /\S/u.test(pending.slice(boundary))) cut = boundary;
          if (cut) break;
        }
        if (soft) {
          previousSoft = boundary;
          previousSoftWords = count;
        }
      }

      if (!cut && pending.length > maxCharacters) cut = numericBoundary(segments, limitCut);
      if (!cut && final) cut = pending.length;
      if (!cut) break;
      chunks.push(pending.slice(0, cut));
      pending = pending.slice(cut);
      yieldCount++;
    }
    return chunks;
  }

  return {
    push(text) {
      if (finished) throw new Error('TTS chunker is finished');
      if (typeof text !== 'string') throw new TypeError('TTS input must be a string');
      pending += text;
      return drain(false);
    },
    finish() {
      if (finished) return [];
      finished = true;
      return drain(true);
    },
  };
}
