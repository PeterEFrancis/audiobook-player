// LRC text is untrusted. Display cue/word text with textContent, never innerHTML.
function time(value) {
  const match = /^(\d+):(\d{2})(?::(\d{2}))?(?:[.,](\d{1,3}))?$/.exec(value);
  if (!match || Number(match[2]) >= 60 || (match[3] && Number(match[3]) >= 60)) return null;
  const seconds = match[3] == null
    ? Number(match[1]) * 60 + Number(match[2])
    : Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
  const result = seconds + Number(`0.${match[4] || '0'}`);
  return Number.isFinite(result) ? result : null;
}

const shiftedTime = (value, fallback = null) => Number.isFinite(value) ? Math.max(0, Number(value.toFixed(3))) : fallback;

function enhanced(text, start) {
  const marks = [...text.matchAll(/<([^<>\r\n]+)>/g)]
    .map(match => ({ at: time(match[1]), index: match.index, length: match[0].length }))
    .filter(mark => mark.at != null);
  if (!marks.length) return { text };
  const words = [];
  const prefix = text.slice(0, marks[0].index);
  if (prefix.trim()) words.push({ start, text: prefix.trim() });
  marks.forEach((mark, index) => {
    const word = text.slice(mark.index + mark.length, marks[index + 1]?.index ?? text.length);
    if (word.trim()) words.push({ start: mark.at, text: word.trim() });
  });
  const plain = text.replace(/<([^<>\r\n]+)>/g, (tag, stamp) => time(stamp) == null ? tag : '');
  const trailing = text.slice(marks.at(-1).index + marks.at(-1).length).trim() ? null : marks.at(-1).at;
  return { text: plain.trim(), words, trailing };
}

/** Parse standard/enhanced LRC. All public times are seconds on the audio-file clock. */
export function parseLRC(source) {
  if (typeof source !== 'string') return [];
  const lines = source.replace(/^\uFEFF/, '').split(/\r?\n/);
  let offset = 0;
  for (const line of lines) {
    const match = /^\s*\[offset:\s*([+-]?\d+)\]\s*$/i.exec(line);
    // LRC positive offsets advance lyrics; negative offsets delay them.
    if (match && Number.isFinite(Number(match[1]))) offset = -Number(match[1]) / 1000;
  }
  const cues = [];
  for (const line of lines) {
    let rest = line.trimStart(), match;
    const stamps = [];
    while ((match = /^\[([^\]\r\n]+)\]/.exec(rest))) {
      const stamp = time(match[1]);
      if (stamp == null) break;
      stamps.push(stamp);
      rest = rest.slice(match[0].length);
    }
    if (!stamps.length) continue;
    const parsed = enhanced(rest.trim(), stamps[0]);
    for (const stamp of stamps) {
      const start = shiftedTime(stamp + offset);
      if (start == null) continue;
      const cue = { start, end: null, text: parsed.text };
      if (parsed.words?.length) {
        let previous = start;
        cue.words = parsed.words.map(word => {
          const at = Math.max(previous, shiftedTime(word.start + stamp - stamps[0] + offset, previous));
          previous = at;
          return { start: at, end: null, text: word.text };
        });
        cue.trailing = parsed.trailing == null ? null : shiftedTime(parsed.trailing + stamp - stamps[0] + offset);
      }
      cues.push(cue);
    }
  }
  cues.sort((a, b) => a.start - b.start);
  cues.forEach((cue, index) => {
    cue.end = cues[index + 1]?.start ?? null;
    cue.words?.forEach((word, wi) => {
      const end = cue.words[wi + 1]?.start ?? cue.trailing ?? cue.end;
      word.end = end == null ? null : Math.max(word.start, Math.min(end, cue.end ?? end));
    });
    delete cue.trailing;
  });
  return cues;
}

function sentenceEnd(text) {
  const end = text.trim().replace(/["'”’»\)\]]+$/u, '');
  if (/\b(?:Mr|Mrs|Ms|Dr|Prof|St|Jr|Sr|vs|etc|e\.g|i\.e|a\.m|p\.m)\.$/i.test(end)
      || /\b(?:[A-Za-z]\.){2,}$/.test(end) || /\b[A-Z]\.$/.test(end)) return false;
  return /[.!?…]$/.test(end);
}

/** Keep a complete sentence active across LRC rows, without inventing word times. */
export function sentenceCues(cues) {
  const result = [];
  let sentence;
  const flush = () => { if (sentence) result.push(sentence); sentence = null; };
  for (const cue of cues) {
    if (!cue.text.trim()) { flush(); result.push({ ...cue }); continue; }
    if (!sentence) sentence = { ...cue, ...(cue.words ? { words: [...cue.words] } : {}) };
    else {
      sentence.text += ` ${cue.text}`;
      sentence.end = cue.end;
      if (cue.words) sentence.words = [...(sentence.words || []), ...cue.words];
    }
    if (sentenceEnd(cue.text)) flush();
  }
  flush();
  return result;
}

/** The last starting cue wins, including empty cues used to clear the text. */
export function cueAt(cues, position) {
  if (!Number.isFinite(position)) return -1;
  let low = 0, high = cues.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (cues[middle].start <= position) low = middle + 1;
    else high = middle;
  }
  return low - 1;
}
