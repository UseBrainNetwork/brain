import { execFile } from "node:child_process";
import { statfs } from "node:fs/promises";
import { arch, cpus, freemem, homedir, platform, release, totalmem } from "node:os";
import { promisify } from "node:util";
import type { GpuReport, HardwareReport, Telemetry } from "../protocol";

const run = promisify(execFile);

/**
 * Hardware detection. Reports only what the coordinator displays: OS family, CPU model and core
 * count, RAM, free disk on the data volume, GPUs. No hostnames, usernames, MAC addresses or exact
 * locations. Everything is still a claim as far as the network is concerned.
 *
 * NVIDIA: `nvidia-smi` is queried (it ships with the driver; DCGM/NVML bindings are not required
 * for V1 and the query set below mirrors the DCGM exporter's core fields). No NVIDIA driver → no
 * GPU is reported, never a guess.
 */
export async function nvidiaSmi(): Promise<GpuReport[]> {
  try {
    const q = "name,memory.total,memory.used,utilization.gpu,temperature.gpu,power.draw,driver_version";
    const { stdout } = await run("nvidia-smi", [`--query-gpu=${q}`, "--format=csv,noheader,nounits"], { timeout: 4_000 });
    let cuda: string | null = null;
    try {
      const h = await run("nvidia-smi", [], { timeout: 4_000 });
      cuda = /CUDA Version:\s*([\d.]+)/.exec(h.stdout)?.[1] ?? null;
    } catch {
      /* header unavailable; CUDA version stays unknown */
    }
    const num = (s: string) => {
      const n = Number(s.trim());
      return Number.isFinite(n) ? n : null;
    };
    return stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line, index) => {
        const [name, total, used, util, temp, power, driver] = line.split(",").map((s) => s.trim());
        return { index, model: name || "NVIDIA GPU", vramTotalMb: num(total), vramUsedMb: num(used), utilizationPct: num(util), temperatureC: num(temp), powerW: num(power), driverVersion: driver || null, cudaVersion: cuda, source: "nvidia-smi" as const };
      });
  } catch {
    return [];
  }
}

export const MOCK_GPU: GpuReport = { index: 0, model: "Mock GPU (no hardware)", vramTotalMb: 24_576, vramUsedMb: 0, utilizationPct: 0, temperatureC: null, powerW: null, driverVersion: null, cudaVersion: null, source: "mock" };

async function diskFreeGb(): Promise<number | null> {
  try {
    const s = await statfs(process.env.BRAIN_NODE_HOME || homedir());
    return Math.round((Number(s.bavail) * Number(s.bsize)) / 1e9);
  } catch {
    return null;
  }
}

export async function detectHardware(mock: boolean): Promise<HardwareReport> {
  const gpus = mock ? [MOCK_GPU] : await nvidiaSmi();
  const c = cpus();
  return {
    os: { platform: platform(), release: release().split("-")[0] ?? release(), arch: arch() },
    cpu: { model: c[0]?.model?.trim() ?? "unknown", cores: c.length },
    ramTotalMb: Math.round(totalmem() / 1048576),
    ramFreeMb: Math.round(freemem() / 1048576),
    diskFreeGb: await diskFreeGb(),
    gpus,
    cuda: !mock && gpus.some((g) => g.cudaVersion != null),
    mock,
  };
}

/** Live telemetry for a heartbeat. GPU figures from nvidia-smi when present; mock reports load only. */
export async function sampleTelemetry(mock: boolean, activeJobs: number, maxConcurrency: number, loadedModels: string[], rttMs: number | null): Promise<Telemetry> {
  const g = mock ? MOCK_GPU : (await nvidiaSmi())[0];
  return {
    gpuUtilPct: mock ? Math.min(100, Math.round((100 * activeJobs) / Math.max(1, maxConcurrency))) : (g?.utilizationPct ?? null),
    vramUsedMb: g?.vramUsedMb ?? null,
    vramTotalMb: g?.vramTotalMb ?? null,
    temperatureC: g?.temperatureC ?? null,
    powerW: g?.powerW ?? null,
    load: Math.min(1, activeJobs / Math.max(1, maxConcurrency)),
    activeJobs,
    loadedModels,
    rttMs,
  };
}
