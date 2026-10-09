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

/**
 * AMD on Linux: `rocm-smi --json`. Key names differ between ROCm releases ("VRAM Total Memory (B)",
 * "GPU use (%)", "Temperature (Sensor edge) (C)", "Average Graphics Package Power (W)"), so they are
 * matched loosely. No rocm-smi (Windows, or no ROCm) → no AMD GPU is reported.
 */
export async function rocmSmi(): Promise<GpuReport[]> {
  try {
    const { stdout } = await run("rocm-smi", ["--showproductname", "--showmeminfo", "vram", "--showuse", "--showtemp", "--showpower", "--showdriverversion", "--json"], { timeout: 6_000 });
    const j = JSON.parse(stdout) as Record<string, Record<string, string>>;
    const pick = (card: Record<string, string>, re: RegExp) => {
      const k = Object.keys(card).find((key) => re.test(key));
      return k ? card[k] : undefined;
    };
    const num = (s: string | undefined) => {
      const n = Number(String(s ?? "").trim());
      return Number.isFinite(n) ? n : null;
    };
    const driver = pick(j.system ?? {}, /driver version/i) ?? null;
    return Object.entries(j)
      .filter(([k]) => /^card\d+$/i.test(k))
      .map(([, card], index) => {
        const totalB = num(pick(card, /vram total memory/i));
        const usedB = num(pick(card, /vram total used/i));
        return {
          index,
          model: pick(card, /card series|card model|device name/i)?.trim() || "AMD GPU",
          vramTotalMb: totalB == null ? null : Math.round(totalB / 1048576),
          vramUsedMb: usedB == null ? null : Math.round(usedB / 1048576),
          utilizationPct: num(pick(card, /gpu use/i)),
          temperatureC: num(pick(card, /temperature.*(edge|junction)/i)),
          powerW: num(pick(card, /package power|socket power|power \(w\)/i)),
          driverVersion: driver,
          cudaVersion: null,
          source: "rocm-smi" as const,
        };
      });
  } catch {
    return [];
  }
}

/**
 * Apple silicon: the GPU shares the machine's unified memory, so vramTotalMb is total RAM and is
 * labelled by its source. Utilisation, temperature and power are not exposed without root; null.
 */
export async function appleGpu(): Promise<GpuReport[]> {
  if (platform() !== "darwin") return [];
  try {
    const { stdout } = await run("system_profiler", ["SPDisplaysDataType", "-json"], { timeout: 8_000 });
    const j = JSON.parse(stdout) as { SPDisplaysDataType?: { _name?: string; sppci_model?: string; spdisplays_vendor?: string }[] };
    return (j.SPDisplaysDataType ?? [])
      .filter((d) => /apple/i.test(d.spdisplays_vendor ?? "") || /^apple m\d/i.test(d.sppci_model ?? d._name ?? ""))
      .map((d, index) => ({
        index,
        model: (d.sppci_model ?? d._name ?? "Apple GPU").trim(),
        vramTotalMb: Math.round(totalmem() / 1048576),
        vramUsedMb: null,
        utilizationPct: null,
        temperatureC: null,
        powerW: null,
        driverVersion: null,
        cudaVersion: null,
        source: "system_profiler" as const,
      }));
  } catch {
    return [];
  }
}

/** Every GPU any supported tool can see, NVIDIA first. Empty when nothing reports. */
export async function detectGpus(): Promise<GpuReport[]> {
  const [nv, amd, apple] = await Promise.all([nvidiaSmi(), rocmSmi(), appleGpu()]);
  return [...nv, ...amd, ...apple].map((g, index) => ({ ...g, index }));
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
  const gpus = mock ? [MOCK_GPU] : await detectGpus();
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
  // system_profiler takes seconds and reports nothing live; heartbeats sample only the SMI tools.
  const g = mock ? MOCK_GPU : (await Promise.all([nvidiaSmi(), rocmSmi()])).flat()[0];
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
