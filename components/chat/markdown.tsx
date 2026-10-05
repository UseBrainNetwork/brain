"use client";

import { type ReactNode, useState } from "react";

/**
 * Deliberately small markdown renderer for assistant replies: fenced code (with copy), inline code,
 * bold, italics, links (http/https only), headings, bullet/numbered lists, tables, blockquotes,
 * horizontal rules, paragraphs. No HTML passthrough.
 */
export function renderMarkdown(src: string): ReactNode[] {
  const out: ReactNode[] = [];
  const parts = src.split(/```/);
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      const nl = part.indexOf("\n");
      const lang = nl >= 0 ? part.slice(0, nl).trim() : "";
      const code = nl >= 0 ? part.slice(nl + 1) : part;
      out.push(<CodeBlock key={`c${i}`} lang={lang} code={code.replace(/\n$/, "")} />);
      return;
    }
    out.push(...blocks(part, i));
  });
  return out;
}

const LANG_LABEL: Record<string, string> = { ts: "TypeScript", tsx: "TSX", js: "JavaScript", jsx: "JSX", rs: "Rust", rust: "Rust", sol: "Solidity", solidity: "Solidity", py: "Python", python: "Python", sh: "Shell", bash: "Shell", zsh: "Shell", json: "JSON", toml: "TOML", yaml: "YAML", yml: "YAML", go: "Go", move: "Move", sql: "SQL", md: "Markdown", html: "HTML", css: "CSS", c: "C", cpp: "C++", wgsl: "WGSL", diff: "Diff" };

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false);
  const label = LANG_LABEL[lang.toLowerCase()] ?? lang;
  const lines = code.split("\n").length;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard blocked */
    }
  };
  return (
    <div className="group/code my-3 overflow-hidden rounded-[10px] bg-ink ring-1 ring-inset ring-chalk/10">
      <div className="flex items-center justify-between border-b border-chalk/[0.07] px-3.5 py-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-chalk/40">
        <span>
          {label || "code"}
          <span className="ml-2 text-chalk/25">{lines} {lines === 1 ? "line" : "lines"}</span>
        </span>
        <button type="button" onClick={() => void copy()} className={copied ? "text-ok" : "text-chalk/50 hover:text-chalk"}>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="overflow-x-auto px-4 py-3 font-mono text-[12.5px] leading-relaxed text-chalk/90">
        <code>{code}</code>
      </pre>
    </div>
  );
}

function blocks(text: string, key: number): ReactNode[] {
  const lines = text.split("\n");
  const out: ReactNode[] = [];
  let para: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let quote: string[] = [];
  let table: string[] = [];
  const flushPara = () => {
    if (para.length) out.push(<p key={`p${key}-${out.length}`} className="my-2 leading-[1.65]">{inline(para.join(" "))}</p>);
    para = [];
  };
  const flushList = () => {
    if (!list) return;
    const Tag = list.ordered ? "ol" : "ul";
    out.push(
      <Tag key={`l${key}-${out.length}`} className={`my-2 space-y-1 pl-5 leading-[1.6] ${list.ordered ? "list-decimal" : "list-disc"} marker:text-chalk/40`}>
        {list.items.map((it, j) => (
          <li key={j}>{inline(it)}</li>
        ))}
      </Tag>,
    );
    list = null;
  };
  const flushQuote = () => {
    if (!quote.length) return;
    out.push(
      <blockquote key={`q${key}-${out.length}`} className="my-2 border-l-2 border-chalk/20 pl-3 text-chalk/70">
        {inline(quote.join(" "))}
      </blockquote>,
    );
    quote = [];
  };
  const flushTable = () => {
    if (table.length < 2) {
      // Not a table after all: render as paragraph text.
      if (table.length) para.push(...table);
      table = [];
      return;
    }
    const rows = table.filter((r) => !/^\s*\|?\s*:?-{2,}/.test(r)).map((r) => r.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim()));
    const [head, ...body] = rows;
    out.push(
      <div key={`t${key}-${out.length}`} className="my-3 overflow-x-auto rounded-[8px] ring-1 ring-inset ring-chalk/10">
        <table className="w-full border-collapse text-left text-[13.5px]">
          <thead>
            <tr className="bg-chalk/[0.04]">
              {head.map((c, j) => (
                <th key={j} className="px-3 py-2 font-mono text-[10.5px] font-medium uppercase tracking-[0.12em] text-chalk/50">
                  {inline(c)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {body.map((r, i) => (
              <tr key={i} className="border-t border-chalk/[0.07]">
                {head.map((_, j) => (
                  <td key={j} className="px-3 py-2 align-top text-chalk/85">
                    {inline(r[j] ?? "")}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>,
    );
    table = [];
  };
  const flushAll = () => {
    flushPara();
    flushList();
    flushQuote();
    flushTable();
  };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    const ul = /^\s*[-*•]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    const bq = /^\s*>\s?(.*)$/.exec(line);
    const isTable = /^\s*\|.*\|\s*$/.test(line);
    if (!line.trim()) {
      flushAll();
      continue;
    }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushAll();
      out.push(<hr key={`hr${key}-${out.length}`} className="my-4 border-chalk/10" />);
      continue;
    }
    if (isTable) {
      flushPara();
      flushList();
      flushQuote();
      table.push(line);
      continue;
    }
    if (table.length) flushTable();
    if (h) {
      flushAll();
      const lvl = h[1].length;
      out.push(
        <div key={`h${key}-${out.length}`} className={`mt-4 mb-1 font-semibold ${lvl <= 2 ? "text-[16px]" : "text-[14.5px]"}`}>
          {inline(h[2])}
        </div>,
      );
      continue;
    }
    if (bq) {
      flushPara();
      flushList();
      quote.push(bq[1]);
      continue;
    }
    if (quote.length) flushQuote();
    if (ul || ol) {
      flushPara();
      const ordered = Boolean(ol);
      if (!list || list.ordered !== ordered) {
        flushList();
        list = { ordered, items: [] };
      }
      list.items.push((ul ?? ol)![1]);
      continue;
    }
    flushList();
    para.push(line.trim());
  }
  flushAll();
  return out;
}

function inline(s: string): ReactNode[] {
  const out: ReactNode[] = [];
  // code | bold | link | italic
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|(\*[^*\s][^*]*\*|_[^_\s][^_]*_)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(s.slice(last, m.index));
    if (m[1]) out.push(<code key={k++} className="rounded-[4px] bg-chalk/10 px-1.5 py-0.5 font-mono text-[12.5px] text-chalk">{m[1].slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong key={k++} className="font-semibold text-chalk">{m[2].slice(2, -2)}</strong>);
    else if (m[3] && m[4])
      out.push(
        <a key={k++} href={m[4]} target="_blank" rel="noopener noreferrer nofollow" className="text-chalk underline decoration-chalk/30 underline-offset-2 hover:decoration-chalk">
          {m[3]}
        </a>,
      );
    else if (m[5]) out.push(<em key={k++}>{m[5].slice(1, -1)}</em>);
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}
