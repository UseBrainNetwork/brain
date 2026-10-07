"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { ComputeJob, JobStatus } from "@/domain/types";
import { Button, Container, Prov, Section } from "@/components/ui";
import { useNetwork } from "@/network/realtime/store";
import { isSimulatedJobId, mockJob } from "@/services/mock/mockNetwork";
import { cx, fmtMs } from "@/lib/format";
import { StatusPill, stageAt, useNow } from "./Explorer";

const STAGES: { s: JobStatus; label: string; about: string }[] = [
  { s: "submitted", label: "Submitted", about: "Request accepted by the gateway and queued for a pool." },
  { s: "split", label: "Split", about: "Router partitions the work into independent units." },
  { s: "assigned", label: "Assigned", about: "Units dispatched to nodes ranked by score, reputation and latency." },
  { s: "executing", label: "Executed", about: "WGSL kernels run on contributor GPUs." },
  { s: "verifying", label: "Verified", about: "Server checks secret rows / canaries / redundant results." },
  { s: "merged", label: "Merged", about: "Verified partial results are recombined." },
  { s: "completed", label: "Completed", about: "Result returned; compute credited to verified nodes only." },
];

type Load = { state: "loading" } | { state: "missing" } | { state: "ok"; job: ComputeJob };

export function JobDetail({ id }: { id: string }) {
  const fromStore = useNetwork((s) => s.jobs.find((j) => j.id === id));
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const now = useNow(100);

  useEffect(() => {
    if (fromStore) return;
    if (!/^\d+$/.test(id)) return setLoad({ state: "missing" });
    if (isSimulatedJobId(id)) {
      setLoad({ state: "ok", job: mockJob(Number(id), Date.now() - 45_000) });
      return;
    }
    let dead = false;
    fetch(`/api/jobs/${id}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { job: ComputeJob } | null) => !dead && setLoad(d ? { state: "ok", job: d.job } : { state: "missing" }))
      .catch(() => !dead && setLoad({ state: "missing" }));
    return () => {
      dead = true;
    };
  }, [id, fromStore]);

  const job = fromStore ?? (load.state === "ok" ? load.job : null);

  return (
    <Section className="min-h-dvh pb-28 pt-[120px] md:pt-[150px]">
      <Container>
        <Link href="/explorer" className="font-mono text-[12px] text-fog hover:text-ink">
          ← Explorer
        </Link>
        {!job ? (
          <div className="py-24">
            <div className="label text-fog">Job</div>
            <h1 className="display mt-3 text-[56px] md:text-[96px]">#{id}</h1>
            <p className="mt-6 font-mono text-[13px] text-ink/60">{load.state === "missing" ? "No job with this id exists on this server." : "Loading…"}</p>
          </div>
        ) : (
          <Detail job={job} now={now} />
        )}
      </Container>
    </Section>
  );
}

function Detail({ job, now }: { job: ComputeJob; now: number }) {
  const stage = stageAt(job, now);
  const finished = stage === "completed" || stage === "failed";
  const t0 = job.submittedAt;
  const verify = job.lifecycle.find((e) => e.stage === "verifying")?.detail;
  const failed = job.lifecycle.find((e) => e.stage === "failed");
  const num = Number(job.id);
  return (
    <>
      <div className="mt-8 flex flex-col justify-between gap-6 md:flex-row md:items-end">
        <div>
          <div className="label flex items-center gap-2 text-fog">
            Job <Prov p={job.provenance} />
          </div>
          <h1 className="display mt-3 text-[56px] md:text-[112px]">#{job.id}</h1>
        </div>
        <div className="flex items-center gap-6 pb-3">
          <StatusPill s={stage} />
          {job.provenance === "live" && finished && (
            <Button href={`/receipt/r-${String(job.id).split("-")[0]}`} variant="secondary" className="h-9 px-4 text-[12px]">
              Compute receipt →
            </Button>
          )}
          {isSimulatedJobId(job.id) && (
            <div className="flex gap-2">
              <Button href={`/explorer/job/${num - 1}`} variant="secondary" className="h-9 px-4 text-[12px]">
                ← #{num - 1}
              </Button>
              <Button href={`/explorer/job/${num + 1}`} variant="secondary" className="h-9 px-4 text-[12px]">
                #{num + 1} →
              </Button>
            </div>
          )}
        </div>
      </div>

      <div className="mt-12 grid gap-10 lg:grid-cols-[1fr_420px]">
        <ol className="relative">
          {STAGES.map((st, i) => {
            const e = job.lifecycle.find((x) => x.stage === st.s);
            const reached = e && e.at <= now;
            const skipped = !e && finished;
            const current = reached && !finished && stageAt(job, now) === st.s;
            return (
              <li key={st.s} className="relative grid grid-cols-[28px_1fr_auto] gap-4 pb-8 last:pb-0">
                {i < STAGES.length - 1 && <span className={cx("absolute left-[13px] top-7 h-[calc(100%-20px)] w-px", reached ? "bg-ink" : "bg-ink/15")} />}
                <span
                  className={cx(
                    "relative mt-0.5 grid size-[27px] place-items-center rounded-full font-mono text-[10px] font-semibold",
                    reached ? (current ? "bg-signal text-white" : "bg-ink text-chalk") : "bg-transparent text-fog ring-1 ring-inset ring-ink/20",
                  )}
                >
                  {current && <span className="absolute inset-0 animate-ping rounded-full bg-signal/40" />}
                  {String(i + 1).padStart(2, "0")}
                </span>
                <div>
                  <div className={cx("text-[19px] font-semibold tracking-[-0.02em]", !reached && "text-ink/35")}>{st.label}</div>
                  <div className="mt-1 text-[13.5px] leading-relaxed text-ink/55">{st.about}</div>
                  {e?.detail && reached && <div className="mt-2 font-mono text-[12px] text-ink/80">{e.detail}</div>}
                  {skipped && <div className="mt-2 font-mono text-[12px] text-fog">{failed ? "not reached" : "not applicable: single work unit"}</div>}
                  {failed && st.s === "completed" && <div className="mt-2 font-mono text-[12px] text-signal">failed: {failed.detail ?? "rejected"} · no compute credited</div>}
                </div>
                <div className="pt-1 text-right font-mono text-[12px] text-fog">{reached && e ? `+${fmtMs(e.at - t0)}` : ""}</div>
              </li>
            );
          })}
        </ol>

        <aside className="h-fit rounded-[12px] border border-ink/10 bg-paper p-7">
          <div className="flex items-center justify-between font-mono text-[11px] text-fog">
            <span>RECEIPT</span>
            <span>{new Date(job.submittedAt).toISOString().replace("T", " ").slice(0, 19)}Z</span>
          </div>
          <div className="mt-6 space-y-0 font-mono text-[12.5px]">
            {[
              ["Model", job.model],
              ["Kind", job.kind],
              ["Work units", String(job.workUnits)],
              ["Compute", `${job.computeUnits}u`],
              ["Latency", finished && job.latencyMs ? fmtMs(job.latencyMs) : "—"],
              ["Verification", verify ?? (finished ? "server check" : "pending")],
            ].map(([k, v]) => (
              <div key={k} className="flex justify-between border-b border-dashed border-ink/15 py-2.5">
                <span className="text-fog">{k}</span>
                <span>{v}</span>
              </div>
            ))}
          </div>
          <div className="label mt-7 text-fog">Nodes ({job.nodeIds.length})</div>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {job.nodeIds.map((n, i) => (
              <span key={n + i} className="rounded-md bg-ink px-2 py-1 font-mono text-[11.5px] text-chalk">
                {n}
              </span>
            ))}
          </div>
          <p className="mt-7 text-[12px] leading-relaxed text-fog">
            {job.provenance === "live"
              ? "Real job executed by a browser connected to this server and verified server-side."
              : "Simulated job from the demo stream. The lifecycle mirrors the real pipeline."}
          </p>
        </aside>
      </div>
    </>
  );
}
