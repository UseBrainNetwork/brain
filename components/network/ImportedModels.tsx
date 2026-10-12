"use client";

import { useEffect, useState, type FormEvent } from "react";
import { cx } from "@/lib/format";
import { Panel } from "@/components/economy/parts";
import { Tag, gb } from "@/components/network/NativeFleet";

interface ImportedRow {
  id: string;
  repo: string;
  file: { file: string; quant: string; sizeBytes: number };
  params: string;
  context: number;
  license: string;
  minVramMb: number;
  createdAt: number;
  lastRequestedAt: number;
  requests: number;
  nodesOnline: number;
  nodesLoaded: number;
  status: "available" | "waiting_for_node";
}

interface ImportReply {
  model?: ImportedRow & { nodes_online: number; status: string };
  created?: boolean;
  use?: { model: string; curl: string };
  note?: string;
  error?: { code: string; message: string; suggestions?: { repo: string; downloads: number | null }[] };
}

function useImports(intervalMs = 15_000) {
  const [d, setD] = useState<{ models: ImportedRow[]; limit: number; stale?: boolean } | null | undefined>(undefined);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch("/api/models/imports")
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => alive && setD(j))
        .catch(() => alive && setD(null));
    void load();
    const t = setInterval(load, intervalMs);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [intervalMs, tick]);
  return { data: d, refresh: () => setTick((x) => x + 1) };
}

/**
 * Bring your own model: a Hugging Face repository becomes an `hf/<org>/<repo>` id the network
 * routes to nodes that serve it. The table is the coordinator's import record joined with the live
 * registry; nothing here is a promise that a node will pick a model up, only a count of which did.
 */
export function ImportedModels() {
  const { data, refresh } = useImports();
  const [source, setSource] = useState("");
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState<ImportReply | null>(null);

  const submit = async (e?: FormEvent, override?: string) => {
    e?.preventDefault();
    const s = (override ?? source).trim();
    if (!s || busy) return;
    setBusy(true);
    setReply(null);
    try {
      const r = await fetch("/v1/models/import", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ source: s }) });
      const j = (await r.json()) as ImportReply;
      setReply(j);
      if (j.model) {
        setSource("");
        refresh();
      }
    } catch (err) {
      setReply({ error: { code: "network", message: err instanceof Error ? err.message : "Request failed." } });
    } finally {
      setBusy(false);
    }
  };

  const rows = data?.models ?? [];

  return (
    <Panel title="Bring your own model" right={data ? <span>{rows.length} imported{data.limit ? ` of ${data.limit}` : ""}</span> : <span>loading</span>}>
      <p className="max-w-[760px] text-[13.5px] leading-relaxed text-chalk/60">
        Paste a Hugging Face repository. If it is a public text model with a single-file GGUF and a chat template, it becomes <span className="font-mono text-chalk">hf/&lt;org&gt;/&lt;repo&gt;</span> and nodes that opted in are asked to pull it. Requests naming it go only to nodes serving it; before one does, they are refused with the reason, not answered by another model. Repositories without a GGUF get a list of quantisations to import instead.
      </p>
      <form onSubmit={submit} className="mt-5 flex max-w-[760px] flex-col gap-2 sm:flex-row">
        <input
          value={source}
          onChange={(e) => setSource(e.target.value)}
          placeholder="https://huggingface.co/ggml-org/gpt-oss-20b-GGUF"
          aria-label="Hugging Face repository"
          spellCheck={false}
          className="h-11 min-w-0 flex-1 rounded-md bg-ink/60 px-4 font-mono text-[13px] text-chalk outline-none ring-1 ring-inset ring-chalk/15 placeholder:text-chalk/30 focus:ring-chalk/50"
        />
        <button type="submit" disabled={busy || !source.trim()} className="h-11 rounded-md bg-chalk px-5 font-mono text-[12px] font-semibold uppercase tracking-[0.12em] text-ink disabled:opacity-40">
          {busy ? "Checking…" : "Import"}
        </button>
      </form>
      {reply?.error && (
        <div className="mt-3 max-w-[760px] font-mono text-[12px] leading-relaxed text-warn">
          {reply.error.message}
          {reply.error.suggestions?.length ? (
            <div className="mt-2 flex flex-wrap gap-2">
              {reply.error.suggestions.map((s) => (
                <button key={s.repo} type="button" onClick={() => void submit(undefined, s.repo)} className="rounded-md bg-ink/60 px-3 py-1.5 text-chalk ring-1 ring-inset ring-chalk/15 hover:ring-chalk/50">
                  {s.repo}
                  {s.downloads != null ? <span className="text-chalk/40"> · {s.downloads.toLocaleString()} downloads</span> : null}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      )}
      {reply?.model && (
        <div className="mt-3 max-w-[760px] rounded-md bg-ink/60 p-4 font-mono text-[12px] leading-relaxed text-chalk/80">
          <div>
            <span className="text-chalk">{reply.model.id}</span> {reply.created ? "imported" : "already imported"} · {reply.model.file.file} · {(reply.model.file.sizeBytes / 1e9).toFixed(1)} GB · {reply.model.params} params · needs {gb(reply.model.minVramMb)}
          </div>
          <div className="mt-1 text-chalk/60">{reply.note}</div>
          {reply.use && <pre className="mt-3 overflow-x-auto whitespace-pre-wrap break-all text-chalk/70">{reply.use.curl}</pre>}
        </div>
      )}

      <div className="mt-6 overflow-x-auto">
        <table className="w-full text-left font-mono text-[12px]">
          <thead className="text-[10px] uppercase tracking-[0.12em] text-chalk/40">
            <tr>
              {["Model", "File", "Size", "Params", "Min memory", "License", "Nodes online", "Loaded", "Requests", "Status"].map((h) => (
                <th key={h} className="pb-2 pr-4 font-normal">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="text-chalk/80">
            {data === undefined && (
              <tr>
                <td colSpan={10} className="py-3 text-chalk/40">
                  loading
                </td>
              </tr>
            )}
            {data === null && (
              <tr>
                <td colSpan={10} className="py-3 text-chalk/40">
                  table unavailable
                </td>
              </tr>
            )}
            {data && rows.length === 0 && (
              <tr>
                <td colSpan={10} className="py-3 text-chalk/40">
                  nothing imported yet
                </td>
              </tr>
            )}
            {rows.map((m) => (
              <tr key={m.id} className="border-t border-chalk/5">
                <td className="py-2.5 pr-4 text-chalk">
                  <a href={`https://huggingface.co/${m.repo}`} target="_blank" rel="noreferrer" className="hover:underline">
                    {m.id}
                  </a>
                </td>
                <td className="py-2.5 pr-4 max-w-[220px] truncate" title={m.file.file}>
                  {m.file.file}
                </td>
                <td className="py-2.5 pr-4">{(m.file.sizeBytes / 1e9).toFixed(1)} GB</td>
                <td className="py-2.5 pr-4">{m.params}</td>
                <td className="py-2.5 pr-4">{gb(m.minVramMb)}</td>
                <td className="py-2.5 pr-4 max-w-[160px] truncate" title={m.license}>
                  {m.license}
                </td>
                <td className="py-2.5 pr-4">{m.nodesOnline}</td>
                <td className="py-2.5 pr-4">{m.nodesLoaded}</td>
                <td className="py-2.5 pr-4">{m.requests}</td>
                <td className={cx("py-2.5 pr-4 uppercase", m.status === "available" ? "text-ok" : "text-chalk/40")}>{m.status === "available" ? "available" : <Tag>waiting for a node</Tag>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-5 max-w-[760px] font-mono text-[11px] leading-relaxed text-chalk/40">
        File, size, parameter count, context and license come from the repository as Hugging Face reports them. Min memory is a requirement derived from the file size, not a measurement. Nodes online are nodes advertising the model this minute. To serve imported models on your node: <span className="text-chalk/70">BRAIN_NODE_IMPORTS=1</span> (Ollama pulls them itself; llama.cpp, mlx-lm and exo are told which file to load).
        {data?.stale ? " Table is the last successful read." : ""}
      </p>
    </Panel>
  );
}
