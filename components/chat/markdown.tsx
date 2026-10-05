import type { ReactNode } from "react";

/**
 * Deliberately small markdown renderer for assistant replies: fenced code, inline code, bold,
 * headings, bullet/numbered lists, paragraphs. No HTML passthrough.
 */
export function renderMarkdown(src: string): ReactNode[] {
  const out: ReactNode[] = [];
  const parts = src.split(/```/);
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      const nl = part.indexOf("\n");
      const lang = nl >= 0 ? part.slice(0, nl).trim() : "";
      const code = nl >= 0 ? part.slice(nl + 1) : part;
      out.push(
        <pre key={`c${i}`} className="my-3 overflow-x-auto rounded-[10px] bg-ink px-4 py-3 font-mono text-[12.5px] leading-relaxed text-chalk/90 ring-1 ring-inset ring-chalk/10">
          {lang && <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.14em] text-chalk/35">{lang}</div>}
          <code>{code.replace(/\n$/, "")}</code>
        </pre>,
      );
      return;
    }
    out.push(...blocks(part, i));
  });
  return out;
}

function blocks(text: string, key: number): ReactNode[] {
  const lines = text.split("\n");
  const out: ReactNode[] = [];
  let para: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
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
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    const ul = /^\s*[-*•]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (!line.trim()) {
      flushPara();
      flushList();
      continue;
    }
    if (h) {
      flushPara();
      flushList();
      const lvl = h[1].length;
      out.push(
        <div key={`h${key}-${out.length}`} className={`mt-4 mb-1 font-semibold ${lvl <= 2 ? "text-[16px]" : "text-[14.5px]"}`}>
          {inline(h[2])}
        </div>,
      );
      continue;
    }
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
  flushPara();
  flushList();
  return out;
}

function inline(s: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(s.slice(last, m.index));
    if (m[1]) out.push(<code key={k++} className="rounded-[4px] bg-chalk/10 px-1.5 py-0.5 font-mono text-[12.5px] text-chalk">{m[1].slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong key={k++} className="font-semibold text-chalk">{m[2].slice(2, -2)}</strong>);
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}
