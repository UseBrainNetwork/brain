"use client";

import { useState, type ReactNode } from "react";
import { cx } from "@/lib/format";

type Lang = "bash" | "python" | "js" | "json";

const KEYWORDS: Record<Lang, RegExp> = {
  bash: /\b(curl|export)\b/g,
  python: /\b(from|import|as|print|def|return|for|in|with|None|True|False)\b/g,
  js: /\b(import|from|const|let|await|async|new|return|for|of|export|function)\b/g,
  json: /\b(true|false|null)\b/g,
};

/** Tiny dependency-free highlighter: strings, comments, keywords, flags, numbers. */
function highlight(code: string, lang: Lang): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(#.*$|\/\/.*$)|(\s-[A-Za-z]\b|--[a-z-]+)|(\b\d+(?:\.\d+)?\b)/gm;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  const pushPlain = (s: string) => {
    let l = 0;
    const kw = new RegExp(KEYWORDS[lang]);
    let k: RegExpExecArray | null;
    while ((k = kw.exec(s))) {
      if (k.index > l) out.push(s.slice(l, k.index));
      out.push(
        <span key={`k${i++}`} className="text-[#9ec1ff]">
          {k[0]}
        </span>,
      );
      l = k.index + k[0].length;
    }
    if (l < s.length) out.push(s.slice(l));
  };
  while ((m = re.exec(code))) {
    if (m.index > last) pushPlain(code.slice(last, m.index));
    const cls = m[1] ? "text-[#f3c58b]" : m[2] ? (lang === "bash" && m[2].startsWith("#!") ? "" : "text-chalk/35") : m[3] ? "text-signal-2" : "text-[#8fd4b0]";
    if (m[2] && lang === "json") pushPlain(m[0]);
    else
      out.push(
        <span key={`t${i++}`} className={cls}>
          {m[0]}
        </span>,
      );
    last = m.index + m[0].length;
  }
  if (last < code.length) pushPlain(code.slice(last));
  return out;
}

export function CodeBlock({ code, lang, title, className }: { code: string; lang: Lang; title?: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div data-theme="dark" className={cx("overflow-hidden rounded-[18px] bg-ink text-chalk ring-1 ring-black/30", className)}>
      <div className="flex items-center justify-between border-b border-chalk/[0.08] px-4 py-2.5">
        <span className="font-mono text-[11px] text-chalk/50">{title ?? lang}</span>
        <button
          onClick={() => {
            navigator.clipboard?.writeText(code);
            setCopied(true);
            setTimeout(() => setCopied(false), 1400);
          }}
          className="font-mono text-[11px] text-chalk/50 transition-colors hover:text-chalk"
        >
          {copied ? "copied" : "copy"}
        </button>
      </div>
      <pre className="scrollbar-none overflow-x-auto p-4 font-mono text-[12.5px] leading-[1.7] md:p-5 md:text-[13px]">
        <code>{highlight(code, lang)}</code>
      </pre>
    </div>
  );
}

export function CodeTabs({ tabs, className }: { tabs: { label: string; lang: Lang; code: string }[]; className?: string }) {
  const [i, setI] = useState(0);
  return (
    <div className={className}>
      <div className="mb-3 flex gap-1">
        {tabs.map((t, k) => (
          <button
            key={t.label}
            onClick={() => setI(k)}
            className={cx("rounded-full px-3.5 py-1.5 text-[13px] font-medium transition-colors", k === i ? "bg-chalk text-ink" : "text-chalk/60 hover:text-chalk")}
          >
            {t.label}
          </button>
        ))}
      </div>
      <CodeBlock code={tabs[i].code} lang={tabs[i].lang} title={tabs[i].label} />
    </div>
  );
}
