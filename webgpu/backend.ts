import {
  hashMatmulRows,
  hashMixBlocks,
  matmulInputs,
  type WorkloadResult,
  type WorkloadSpec,
} from "@/network/workloads";
import { MATMUL_WGSL, MIX_WGSL } from "./kernels";

/**
 * A ComputeBackend executes a WorkloadSpec and returns a verifiable result.
 *
 * Today: two integer kernels. The same interface is where distributed tensor ops,
 * model-layer execution (e.g. a transformer block over a cached shard) and
 * WebRTC-fed activations plug in later — see NEXT_STEPS.md.
 */
export interface ComputeBackend {
  readonly name: string;
  execute(spec: WorkloadSpec): Promise<{ result: WorkloadResult; gpuMs: number }>;
  dispose(): void;
}

export class WebGPUBackend implements ComputeBackend {
  readonly name = "webgpu";
  private pipelines = new Map<string, GPUComputePipeline>();
  private constructor(private device: GPUDevice) {}

  static async create(): Promise<WebGPUBackend> {
    if (!navigator.gpu) throw new Error("WebGPU unavailable");
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!adapter) throw new Error("No GPU adapter");
    const device = await adapter.requestDevice({
      requiredLimits: {
        maxStorageBufferBindingSize: Math.min(adapter.limits.maxStorageBufferBindingSize, 256 * 1024 * 1024),
        maxBufferSize: Math.min(adapter.limits.maxBufferSize, 256 * 1024 * 1024),
      },
    });
    const backend = new WebGPUBackend(device);
    // Compile ahead of time so shader compilation never lands inside a timed challenge.
    backend.pipeline("matmul_u32");
    backend.pipeline("mix_u32");
    return backend;
  }

  private pipeline(kernel: WorkloadSpec["kernel"]): GPUComputePipeline {
    let p = this.pipelines.get(kernel);
    if (!p) {
      const module = this.device.createShaderModule({ code: kernel === "matmul_u32" ? MATMUL_WGSL : MIX_WGSL });
      p = this.device.createComputePipeline({ layout: "auto", compute: { module, entryPoint: "main" } });
      this.pipelines.set(kernel, p);
    }
    return p;
  }

  async warmup(): Promise<void> {
    await this.execute({ kernel: "mix_u32", seed: 1, rounds: 64, threads: 65536, blockSize: 1024 });
    await this.execute({ kernel: "matmul_u32", m: 32, n: 32, k: 32, seedA: 1, seedB: 2 });
  }

  async execute(spec: WorkloadSpec): Promise<{ result: WorkloadResult; gpuMs: number }> {
    if (spec.kernel === "llm_stage") throw new Error("llm_stage runs through webgpu/llm.ts, not the hash backend");
    return spec.kernel === "matmul_u32" ? this.matmul(spec) : this.mix(spec);
  }

  private storage(data: Uint32Array<ArrayBuffer>, writable = false): GPUBuffer {
    const buf = this.device.createBuffer({
      size: Math.max(16, data.byteLength),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | (writable ? GPUBufferUsage.COPY_SRC : 0),
    });
    this.device.queue.writeBuffer(buf, 0, data);
    return buf;
  }

  private uniform(values: number[]): GPUBuffer {
    const buf = this.device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(buf, 0, new Uint32Array(values));
    return buf;
  }

  private async run(
    kernel: WorkloadSpec["kernel"],
    buffers: GPUBuffer[],
    output: GPUBuffer,
    outBytes: number,
    workgroups: [number, number],
  ): Promise<{ data: Uint32Array; gpuMs: number }> {
    const pipeline = this.pipeline(kernel);
    const bindGroup = this.device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: buffers.map((buffer, binding) => ({ binding, resource: { buffer } })),
    });
    const readback = this.device.createBuffer({ size: outBytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = this.device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(workgroups[0], workgroups[1]);
    pass.end();
    enc.copyBufferToBuffer(output, 0, readback, 0, outBytes);

    const t0 = performance.now();
    this.device.queue.submit([enc.finish()]);
    await this.device.queue.onSubmittedWorkDone();
    const gpuMs = performance.now() - t0;

    await readback.mapAsync(GPUMapMode.READ);
    const data = new Uint32Array(readback.getMappedRange().slice(0));
    readback.unmap();
    readback.destroy();
    buffers.forEach((b) => b.destroy());
    return { data, gpuMs };
  }

  private async matmul(spec: Extract<WorkloadSpec, { kernel: "matmul_u32" }>) {
    const { a, b } = matmulInputs(spec);
    const outBytes = spec.m * spec.n * 4;
    const c = this.device.createBuffer({
      size: Math.max(16, outBytes),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    const { data, gpuMs } = await this.run(
      "matmul_u32",
      [this.storage(a), this.storage(b), c, this.uniform([spec.m, spec.n, spec.k, 0])],
      c,
      outBytes,
      [Math.ceil(spec.n / 8), Math.ceil(spec.m / 8)],
    );
    return { result: { kernel: spec.kernel, hashes: hashMatmulRows(data, spec.m, spec.n) }, gpuMs };
  }

  private async mix(spec: Extract<WorkloadSpec, { kernel: "mix_u32" }>) {
    const outBytes = spec.threads * 4;
    const out = this.device.createBuffer({
      size: Math.max(16, outBytes),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    const groups = Math.ceil(spec.threads / 256);
    const wx = Math.min(groups, 65535);
    const wy = Math.ceil(groups / 65535);
    const { data, gpuMs } = await this.run(
      "mix_u32",
      [out, this.uniform([spec.seed, spec.rounds, spec.threads, 0])],
      out,
      outBytes,
      [wx, wy],
    );
    return { result: { kernel: spec.kernel, hashes: hashMixBlocks(data, spec.blockSize) }, gpuMs };
  }

  dispose() {
    this.device.destroy();
  }
}
