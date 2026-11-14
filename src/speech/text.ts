/** Text handling for speech: mood markup, sentence splitting, and spoken-form normalisation. */

export const MOODS = ["neutral", "smile", "happy", "sad", "surprised", "concerned", "thinking", "angry"] as const;
export type Mood = (typeof MOODS)[number];

export interface SpeechSegment {
  text: string;
  mood?: Mood;
}

const EMOJI_MOOD: Array<[RegExp, Mood]> = [
  [/[😀😃😄😁😆😂🤣🥳🎉]/u, "happy"],
  [/[🙂😊☺️😉🤗👍]/u, "smile"],
  [/[😢😭😞😔☹️🙁😟]/u, "sad"],
  [/[😮😯😲🤯😱]/u, "surprised"],
  [/[🤔🧐]/u, "thinking"],
  [/[😠😡🤬]/u, "angry"],
];

const EMOJI = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{FE0F}\u{200D}]/gu;

/**
 * Split "[happy] Great news! [neutral] Here are the details." into mood-tagged segments.
 * Unknown [tags] are dropped. Emojis set the mood of their segment and are not spoken.
 */
export function parseMarkup(input: string): SpeechSegment[] {
  const out: SpeechSegment[] = [];
  let mood: Mood | undefined;
  const parts = input.split(/(\[[a-zA-Z]+\])/);
  for (const part of parts) {
    const tag = /^\[([a-zA-Z]+)\]$/.exec(part);
    if (tag) {
      const m = tag[1].toLowerCase();
      if ((MOODS as readonly string[]).includes(m)) mood = m as Mood;
      continue;
    }
    let text = part;
    let segMood = mood;
    for (const [re, m] of EMOJI_MOOD) if (re.test(text)) segMood = segMood ?? m;
    text = cleanText(text);
    if (text) out.push({ text, mood: segMood });
  }
  return out;
}

/** Strip markdown, emojis and URLs that should not be read aloud. */
export function cleanText(s: string): string {
  return s
    .replace(EMOJI, "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "the link")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*[-*•]\s+/gm, "")
    .replace(/(\*\*|__|\*|_)(\S[^*_]*?)\1/g, "$2")
    .replace(/\s+/g, " ")
    .trim();
}

const ABBREV = /\b(Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc|approx|No|e\.g|i\.e|a\.m|p\.m|U\.S)\.$/i;

/** Split into sentences, keeping punctuation; long sentences are split at clause boundaries. */
export function splitSentences(text: string, maxLen = 280): string[] {
  const s = text.replace(/\s+/g, " ").trim();
  if (!s) return [];
  const out: string[] = [];
  let start = 0;
  const re = /[.!?…]+["'”’)\]]*(?=\s+|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const end = m.index + m[0].length;
    const candidate = s.slice(start, end);
    if (ABBREV.test(candidate)) continue;
    if (/\d\.$/.test(candidate) && /^\s*\d/.test(s.slice(end))) continue; // decimal number
    out.push(candidate.trim());
    start = end;
  }
  if (start < s.length && s.slice(start).trim()) out.push(s.slice(start).trim());
  return out.flatMap((x) => splitLong(x, maxLen));
}

function splitLong(s: string, maxLen: number): string[] {
  if (s.length <= maxLen) return [s];
  const window = s.slice(0, maxLen);
  const cut = Math.max(window.lastIndexOf(", "), window.lastIndexOf("; "), window.lastIndexOf(" – "), window.lastIndexOf(" - "));
  const at = cut > maxLen * 0.4 ? cut + 1 : window.lastIndexOf(" ");
  if (at <= 0) return [s];
  return [s.slice(0, at).trim(), ...splitLong(s.slice(at).trim(), maxLen)];
}

/** Incremental sentence splitter for streamed LLM tokens. */
export class SentenceStream {
  private buf = "";
  push(token: string): string[] {
    this.buf += token;
    const sentences = splitSentences(this.buf);
    if (sentences.length <= 1) return [];
    // last piece may be incomplete; keep it buffered
    const done = sentences.slice(0, -1);
    this.buf = sentences[sentences.length - 1];
    return done;
  }
  flush(): string[] {
    const rest = splitSentences(this.buf);
    this.buf = "";
    return rest;
  }
}

// ------------------------------------------------------------------------- spoken-form normalisation

const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven",
  "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
const ORD: Record<string, string> = { one: "first", two: "second", three: "third", five: "fifth", eight: "eighth",
  nine: "ninth", twelve: "twelfth" };
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October",
  "November", "December"];

export function numberWords(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  if (n < 0) return "minus " + numberWords(-n);
  if (n < 20) return ONES[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? "-" + ONES[n % 10] : "");
  if (n < 1000) return ONES[Math.floor(n / 100)] + " hundred" + (n % 100 ? " " + numberWords(n % 100) : "");
  for (const [v, w] of [[1e9, "billion"], [1e6, "million"], [1e3, "thousand"]] as const) {
    if (n >= v) return numberWords(Math.floor(n / v)) + " " + w + (n % v ? " " + numberWords(n % v) : "");
  }
  return String(n);
}

export function ordinalWords(n: number): string {
  const w = numberWords(n);
  const parts = w.split(/([ -])/);
  const last = parts[parts.length - 1];
  parts[parts.length - 1] = ORD[last] ?? (last.endsWith("y") ? last.slice(0, -1) + "ieth" : last + "th");
  return parts.join("");
}

const WORDS: Record<string, string> = {
  "Dr.": "Doctor", "Mr.": "Mister", "Mrs.": "Missus", "Ms.": "Miz", "Prof.": "Professor", "Jr.": "Junior",
  "Sr.": "Senior", "vs.": "versus", "etc.": "et cetera", "e.g.": "for example", "i.e.": "that is",
  "approx.": "approximately", "&": "and", "w/": "with", "°C": "degrees Celsius", "°F": "degrees Fahrenheit",
  "km/h": "kilometers per hour", "mph": "miles per hour", "km": "kilometers", "kg": "kilograms", "cm": "centimeters",
};

const CURRENCY: Record<string, [string, string]> = { $: ["dollar", "cent"], "€": ["euro", "cent"], "£": ["pound", "penny"] };

export type TTSInputItem = string | { type: "speech"; value: string; subtitles: string };

/**
 * Turn a sentence into HeadTTS input items. Tokens that the G2P would misread (currency, percent,
 * ISO dates, ordinals, titles, ranges, units) become {type:"speech"} items whose `subtitles` keep the
 * original text, so word timings still line up with what is shown on screen.
 */
export function normalizeForSpeech(sentence: string): TTSInputItem[] {
  const items: TTSInputItem[] = [];
  const tokens = sentence.split(/(\s+)/);
  let plain = "";
  const flush = () => {
    if (plain) items.push(plain);
    plain = "";
  };
  for (const tok of tokens) {
    if (!tok) continue;
    if (/^\s+$/.test(tok)) {
      plain += tok;
      continue;
    }
    const spoken = speakToken(tok);
    if (spoken === null) {
      plain += tok;
    } else {
      flush();
      items.push({ type: "speech", value: spoken + " ", subtitles: tok + " " });
    }
  }
  flush();
  // a single plain string is the common case
  return items;
}

function speakToken(tok: string): string | null {
  const m0 = /^(["'(\[]*)(.*?)([.,!?;:"')\]]*)$/.exec(tok)!;
  const [, pre, core, post] = m0;
  const tail = post.replace(/[^.,!?;:]/g, "");
  let m: RegExpExecArray | null;
  const wrap = (s: string) => `${pre.replace(/[^"']/g, "")}${s}${tail}`;

  if (WORDS[core + post] && post.startsWith(".")) return wrap(WORDS[core + post]).replace(/\.$/, "");
  if (WORDS[core]) return wrap(WORDS[core]);
  if ((m = /^([$€£])(\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d{1,2}))?$/.exec(core))) {
    const [major, minor] = CURRENCY[m[1]];
    const whole = parseInt(m[2].replace(/,/g, ""), 10);
    const cents = m[3] ? parseInt(m[3].padEnd(2, "0"), 10) : 0;
    let s = `${numberWords(whole)} ${major}${whole === 1 ? "" : "s"}`;
    if (cents) s += ` and ${numberWords(cents)} ${cents === 1 ? minor : minor === "penny" ? "pence" : minor + "s"}`;
    return wrap(s);
  }
  if ((m = /^(\d+(?:\.\d+)?)%$/.exec(core))) return wrap(`${m[1]} percent`);
  if ((m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(core))) {
    const mo = parseInt(m[2], 10), d = parseInt(m[3], 10);
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) return wrap(`${MONTHS[mo - 1]} ${ordinalWords(d)}, ${m[1]}`);
  }
  if ((m = /^(\d+)(st|nd|rd|th)$/i.exec(core))) return wrap(ordinalWords(parseInt(m[1], 10)));
  if ((m = /^(\d+(?:\.\d+)?)[-–](\d+(?:\.\d+)?)$/.exec(core))) return wrap(`${m[1]} to ${m[2]}`);
  if ((m = /^(\d+(?:\.\d+)?)(km|kg|cm|mph|°C|°F)$/.exec(core))) return wrap(`${m[1]} ${WORDS[m[2]]}`);
  if ((m = /^#(\d+)$/.exec(core))) return wrap(`number ${m[1]}`);
  return null;
}
