/**
 * Byte-level BPE tokenizer compatible with the Hugging Face `tokenizers` JSON format as used by
 * the Qwen and SmolLM families (GPT-2 style byte mapping; either a Digits pre-tokenizer or the
 * Qwen2 `Split` regex; no normalizer).
 */

export interface TokenizerJson {
  model: { type: string; vocab: Record<string, number>; merges: (string | [string, string])[] };
  added_tokens?: { id: number; content: string; special?: boolean }[];
  pre_tokenizer?: { type: string; pattern?: { Regex?: string }; pretokenizers?: { type: string; individual_digits?: boolean; pattern?: { Regex?: string } }[] } | null;
}

const GPT2_SPLIT = /'s|'t|'re|'ve|'m|'ll|'d| ?\p{L}+| ?\p{N}+| ?[^\s\p{L}\p{N}]+|\s+(?!\S)|\s+/gu;

/**
 * The Qwen2 pre-tokenizer regex, with its `(?i:...)` group expanded because JS regexes do not take
 * inline flags everywhere we run. Any other `Split` pattern falls back to the GPT-2 split.
 */
const QWEN2_PATTERN = "(?i:'s|'t|'re|'ve|'m|'ll|'d)|[^\\r\\n\\p{L}\\p{N}]?\\p{L}+|\\p{N}| ?[^\\s\\p{L}\\p{N}]+[\\r\\n]*|\\s*[\\r\\n]+|\\s+(?!\\S)|\\s+";
const QWEN2_SPLIT = /'[sS]|'[tT]|'[rR][eE]|'[vV][eE]|'[mM]|'[lL][lL]|'[dD]|[^\r\n\p{L}\p{N}]?\p{L}+|\p{N}| ?[^\s\p{L}\p{N}]+[\r\n]*|\s*[\r\n]+|\s+(?!\S)|\s+/gu;

function splitPattern(json: TokenizerJson): RegExp {
  const pre = json.pre_tokenizer;
  const candidates = [pre, ...(pre?.pretokenizers ?? [])];
  for (const c of candidates) {
    const rx = c?.type === "Split" ? c.pattern?.Regex : undefined;
    if (rx === QWEN2_PATTERN) return QWEN2_SPLIT;
  }
  return GPT2_SPLIT;
}

function bytesToUnicode(): { enc: string[]; dec: Map<string, number> } {
  const bs: number[] = [];
  for (let i = 33; i <= 126; i++) bs.push(i);
  for (let i = 161; i <= 172; i++) bs.push(i);
  for (let i = 174; i <= 255; i++) bs.push(i);
  const cs = [...bs];
  let n = 0;
  for (let b = 0; b < 256; b++) {
    if (!bs.includes(b)) {
      bs.push(b);
      cs.push(256 + n);
      n++;
    }
  }
  const enc: string[] = new Array(256);
  const dec = new Map<string, number>();
  for (let i = 0; i < bs.length; i++) {
    const ch = String.fromCodePoint(cs[i]);
    enc[bs[i]] = ch;
    dec.set(ch, bs[i]);
  }
  return { enc, dec };
}

export class Tokenizer {
  private vocab: Map<string, number>;
  private inverse: Map<number, string>;
  private ranks = new Map<string, number>();
  private special: Map<string, number>;
  private specialPattern: RegExp | null;
  private byteEnc: string[];
  private byteDec: Map<string, number>;
  private splitDigits: boolean;
  private split: RegExp;
  private cache = new Map<string, number[]>();

  constructor(json: TokenizerJson) {
    if (json.model.type !== "BPE") throw new Error(`unsupported tokenizer model ${json.model.type}`);
    this.vocab = new Map(Object.entries(json.model.vocab));
    this.inverse = new Map([...this.vocab].map(([k, v]) => [v, k]));
    json.model.merges.forEach((m, i) => {
      const [a, b] = typeof m === "string" ? (m.split(" ") as [string, string]) : m;
      this.ranks.set(`${a}\u0000${b}`, i);
    });
    this.special = new Map();
    for (const t of json.added_tokens ?? []) {
      this.special.set(t.content, t.id);
      this.inverse.set(t.id, t.content);
    }
    const specials = [...this.special.keys()].sort((a, b) => b.length - a.length);
    this.specialPattern = specials.length ? new RegExp(specials.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g") : null;
    const { enc, dec } = bytesToUnicode();
    this.byteEnc = enc;
    this.byteDec = dec;
    this.splitDigits = (json.pre_tokenizer?.pretokenizers ?? []).some((p) => p.type === "Digits" && p.individual_digits);
    this.split = splitPattern(json);
  }

  get size(): number {
    return this.vocab.size + this.special.size;
  }

  tokenId(content: string): number | undefined {
    return this.special.get(content) ?? this.vocab.get(content);
  }

  encode(text: string): number[] {
    const out: number[] = [];
    if (!this.specialPattern) {
      this.encodeChunk(text, out);
      return out;
    }
    let last = 0;
    this.specialPattern.lastIndex = 0;
    for (const m of text.matchAll(this.specialPattern)) {
      if (m.index! > last) this.encodeChunk(text.slice(last, m.index), out);
      out.push(this.special.get(m[0])!);
      last = m.index! + m[0].length;
    }
    if (last < text.length) this.encodeChunk(text.slice(last), out);
    return out;
  }

  private encodeChunk(text: string, out: number[]): void {
    const pieces = this.splitDigits ? splitDigits(text) : [text];
    for (const piece of pieces) {
      for (const m of piece.matchAll(this.split)) {
        const word = m[0];
        let ids = this.cache.get(word);
        if (!ids) {
          ids = this.bpe(word);
          if (this.cache.size < 50_000) this.cache.set(word, ids);
        }
        for (const id of ids) out.push(id);
      }
    }
  }

  private bpe(word: string): number[] {
    const bytes = new TextEncoder().encode(word);
    let symbols: string[] = Array.from(bytes, (b) => this.byteEnc[b]);
    while (symbols.length > 1) {
      let best = Infinity;
      let at = -1;
      for (let i = 0; i < symbols.length - 1; i++) {
        const r = this.ranks.get(`${symbols[i]}\u0000${symbols[i + 1]}`);
        if (r !== undefined && r < best) {
          best = r;
          at = i;
        }
      }
      if (at < 0) break;
      const merged = symbols[at] + symbols[at + 1];
      const next: string[] = [];
      for (let i = 0; i < symbols.length; i++) {
        if (i === at) {
          next.push(merged);
          i++;
        } else next.push(symbols[i]);
      }
      symbols = next;
    }
    return symbols.map((s) => {
      const id = this.vocab.get(s);
      if (id === undefined) throw new Error(`token not in vocab: ${JSON.stringify(s)}`);
      return id;
    });
  }

  /** Raw bytes for a token id (special tokens are returned as their UTF-8 text). */
  tokenBytes(id: number): Uint8Array {
    const s = this.inverse.get(id);
    if (s === undefined) return new Uint8Array();
    if (this.special.has(s)) return new TextEncoder().encode(s);
    const out = new Uint8Array(s.length);
    let n = 0;
    for (const ch of s) {
      const b = this.byteDec.get(ch);
      if (b !== undefined) out[n++] = b;
    }
    return out.subarray(0, n);
  }

  decode(ids: ArrayLike<number>, opts: { skipSpecial?: boolean } = {}): string {
    const parts: Uint8Array[] = [];
    let total = 0;
    for (let i = 0; i < ids.length; i++) {
      const s = this.inverse.get(ids[i]);
      if (s !== undefined && opts.skipSpecial && this.special.has(s)) continue;
      const b = this.tokenBytes(ids[i]);
      parts.push(b);
      total += b.length;
    }
    const joined = new Uint8Array(total);
    let o = 0;
    for (const p of parts) {
      joined.set(p, o);
      o += p.length;
    }
    return new TextDecoder("utf-8", { fatal: false }).decode(joined);
  }

  isSpecial(id: number): boolean {
    const s = this.inverse.get(id);
    return s !== undefined && this.special.has(s);
  }
}

function splitDigits(text: string): string[] {
  const out: string[] = [];
  let buf = "";
  for (const ch of text) {
    if (/\p{N}/u.test(ch)) {
      if (buf) out.push(buf);
      buf = "";
      out.push(ch);
    } else buf += ch;
  }
  if (buf) out.push(buf);
  return out;
}

/** Incremental UTF-8 decoder for streaming: multi-byte characters split across tokens stay intact. */
export class StreamDecoder {
  private pending = new Uint8Array(0);
  constructor(private tok: Tokenizer) {}
  push(id: number): string {
    const b = this.tok.tokenBytes(id);
    const joined = new Uint8Array(this.pending.length + b.length);
    joined.set(this.pending);
    joined.set(b, this.pending.length);
    // Hold back a trailing incomplete sequence.
    let cut = joined.length;
    for (let i = Math.max(0, joined.length - 3); i < joined.length; i++) {
      const c = joined[i];
      const need = c >= 0xf0 ? 4 : c >= 0xe0 ? 3 : c >= 0xc0 ? 2 : 0;
      if (need && i + need > joined.length) {
        cut = i;
        break;
      }
    }
    this.pending = joined.slice(cut);
    return new TextDecoder("utf-8", { fatal: false }).decode(joined.subarray(0, cut));
  }
  flush(): string {
    const s = new TextDecoder("utf-8", { fatal: false }).decode(this.pending);
    this.pending = new Uint8Array(0);
    return s;
  }
}

/* ------------------------------------------------------------------ chat template */

export interface ChatTurn {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * ChatML template (Qwen3, SmolLM2), ending with the assistant header so generation starts the
 * reply. `noThink` adds the empty think block Qwen3 uses for `enable_thinking=false`, so the model
 * answers directly instead of emitting a reasoning trace.
 */
export function chatPrompt(turns: ChatTurn[], opts: { noThink?: boolean } = {}): string {
  let s = "";
  for (const t of turns) s += `<|im_start|>${t.role}\n${t.content}<|im_end|>\n`;
  s += "<|im_start|>assistant\n";
  if (opts.noThink) s += "<think>\n\n</think>\n\n";
  return s;
}
