"use client";

import type { DeviceClass } from "@/domain/types";

/**
 * Hardware detection using only what browser APIs actually expose.
 * Every field carries a `source` so the UI can label it truthfully.
 */

export type FieldSource = "webgpu" | "webgl" | "navigator" | "inferred" | "unavailable";

export interface DetectedField<T> {
  value: T | null;
  source: FieldSource;
  note?: string;
}

export interface DeviceDetection {
  webgpu: "ready" | "no-adapter" | "unsupported" | "error";
  error?: string;
  gpuName: DetectedField<string>;
  vendor: DetectedField<string>;
  architecture: DetectedField<string>;
  maxBufferBytes: DetectedField<number>;
  maxStorageBindingBytes: DetectedField<number>;
  maxWorkgroupInvocations: DetectedField<number>;
  systemMemoryGb: DetectedField<number>;
  gpuMemory: DetectedField<string>;
  browser: DetectedField<string>;
  os: DetectedField<string>;
  cpuThreads: DetectedField<number>;
  features: string[];
  isFallbackAdapter: boolean;
  deviceClass: DeviceClass;
}

function webglRenderer(): string | null {
  try {
    const canvas = document.createElement("canvas");
    const gl = (canvas.getContext("webgl2") || canvas.getContext("webgl")) as WebGLRenderingContext | null;
    if (!gl) return null;
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    const raw = ext ? (gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) as string) : (gl.getParameter(gl.RENDERER) as string);
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return raw || null;
  } catch {
    return null;
  }
}

/** "ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Max, Unspecified Version)" → "Apple M4 Max" */
export function cleanRendererString(raw: string): string {
  let s = raw;
  const angle = /ANGLE \(([^,]+),\s*(.+?)(?:,\s*[^,]*(?:Version|vs_|D3D|OpenGL)[^)]*)?\)\s*$/i.exec(s);
  if (angle) s = angle[2];
  s = s.replace(/ANGLE Metal Renderer:\s*/i, "");
  s = s.replace(/\s*\(0x[0-9a-f]+\)/gi, "");
  s = s.replace(/Direct3D\d*.*$/i, "").replace(/vs_\d_\d.*$/i, "");
  s = s.replace(/\s+/g, " ").trim().replace(/,$/, "");
  return s;
}

export function classifyDevice(name: string | null): DeviceClass {
  const n = (name ?? "").toLowerCase();
  if (/m4\s*max/.test(n)) return "M4_MAX";
  if (/m3\s*max/.test(n)) return "M3_MAX";
  if (/4090/.test(n)) return "RTX_4090";
  if (/4080/.test(n)) return "RTX_4080";
  if (/7900/.test(n)) return "RX_7900";
  return "OTHER_WEBGPU";
}

function detectBrowser(): { browser: string | null; os: string | null } {
  const ua = navigator.userAgent;
  const uaData = (navigator as Navigator & {
    userAgentData?: { brands: { brand: string; version: string }[]; platform: string };
  }).userAgentData;
  let browser: string | null = null;
  if (uaData?.brands?.length) {
    const b = uaData.brands.find((x) => !/Not.?A.?Brand|Chromium/i.test(x.brand)) ?? uaData.brands[0];
    browser = `${b.brand} ${b.version}`;
  } else if (/Firefox\/(\d+)/.test(ua)) browser = `Firefox ${RegExp.$1}`;
  else if (/Edg\/(\d+)/.test(ua)) browser = `Edge ${RegExp.$1}`;
  else if (/Chrome\/(\d+)/.test(ua)) browser = `Chrome ${RegExp.$1}`;
  else if (/Version\/(\d+).*Safari/.test(ua)) browser = `Safari ${RegExp.$1}`;
  const os = uaData?.platform || (/Mac OS X/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Linux/.test(ua) ? "Linux" : null);
  return { browser, os };
}

const unavailable = <T,>(note?: string): DetectedField<T> => ({ value: null, source: "unavailable", note });

export async function detectDevice(): Promise<DeviceDetection> {
  const { browser, os } = detectBrowser();
  const nav = navigator as Navigator & { deviceMemory?: number };
  const renderer = webglRenderer();
  const rendererName = renderer ? cleanRendererString(renderer) : null;

  const base: DeviceDetection = {
    webgpu: "unsupported",
    gpuName: rendererName ? { value: rendererName, source: "webgl", note: "WebGL renderer string" } : unavailable("Browser masks renderer"),
    vendor: unavailable(),
    architecture: unavailable(),
    maxBufferBytes: unavailable(),
    maxStorageBindingBytes: unavailable(),
    maxWorkgroupInvocations: unavailable(),
    systemMemoryGb: nav.deviceMemory
      ? { value: nav.deviceMemory, source: "navigator", note: "Rounded and capped at 8 GB by the browser" }
      : unavailable("navigator.deviceMemory not exposed"),
    gpuMemory: unavailable("Browsers do not expose VRAM"),
    browser: browser ? { value: browser, source: "navigator" } : unavailable(),
    os: os ? { value: os, source: "navigator" } : unavailable(),
    cpuThreads: navigator.hardwareConcurrency ? { value: navigator.hardwareConcurrency, source: "navigator" } : unavailable(),
    features: [],
    isFallbackAdapter: false,
    deviceClass: classifyDevice(rendererName),
  };

  if (!("gpu" in navigator) || !navigator.gpu) return base;

  try {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!adapter) return { ...base, webgpu: "no-adapter" };
    const info = (adapter as GPUAdapter & { info?: GPUAdapterInfo }).info;
    const description = info?.description?.trim() || null;
    const name = description || rendererName;
    const isFallback = Boolean((info as GPUAdapterInfo & { isFallbackAdapter?: boolean })?.isFallbackAdapter ?? (adapter as GPUAdapter & { isFallbackAdapter?: boolean }).isFallbackAdapter);
    return {
      ...base,
      webgpu: "ready",
      gpuName: description
        ? { value: description, source: "webgpu", note: "GPUAdapterInfo.description" }
        : base.gpuName,
      vendor: info?.vendor ? { value: info.vendor, source: "webgpu" } : unavailable(),
      architecture: info?.architecture ? { value: info.architecture, source: "webgpu" } : unavailable(),
      maxBufferBytes: { value: adapter.limits.maxBufferSize, source: "webgpu", note: "Adapter limit, not VRAM" },
      maxStorageBindingBytes: { value: adapter.limits.maxStorageBufferBindingSize, source: "webgpu" },
      maxWorkgroupInvocations: { value: adapter.limits.maxComputeInvocationsPerWorkgroup, source: "webgpu" },
      features: [...adapter.features].sort(),
      isFallbackAdapter: isFallback,
      deviceClass: classifyDevice(name),
    };
  } catch (e) {
    return { ...base, webgpu: "error", error: e instanceof Error ? e.message : String(e) };
  }
}
