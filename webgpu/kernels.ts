/**
 * WGSL compute kernels. Each kernel has a bit-exact CPU twin in network/workloads.ts.
 * u32 arithmetic in WGSL wraps on overflow, matching Math.imul / >>> 0 in JS.
 */

export const MATMUL_WGSL = /* wgsl */ `
struct Dims { m: u32, n: u32, k: u32, pad: u32 };
@group(0) @binding(0) var<storage, read> a: array<u32>;
@group(0) @binding(1) var<storage, read> b: array<u32>;
@group(0) @binding(2) var<storage, read_write> c: array<u32>;
@group(0) @binding(3) var<uniform> d: Dims;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  let row = g.y;
  let col = g.x;
  if (row >= d.m || col >= d.n) { return; }
  var acc: u32 = 0u;
  let base = row * d.k;
  for (var i: u32 = 0u; i < d.k; i = i + 1u) {
    acc = acc + a[base + i] * b[i * d.n + col];
  }
  c[row * d.n + col] = acc;
}
`;

export const MIX_WGSL = /* wgsl */ `
struct Params { seed: u32, rounds: u32, threads: u32, pad: u32 };
@group(0) @binding(0) var<storage, read_write> out: array<u32>;
@group(0) @binding(1) var<uniform> p: Params;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  let i = g.x + g.y * 65535u * 256u;
  if (i >= p.threads) { return; }
  var x: u32 = p.seed ^ (i * 0x85ebca6bu);
  for (var r: u32 = 0u; r < p.rounds; r = r + 1u) {
    x = x ^ (x << 13u);
    x = x ^ (x >> 17u);
    x = x ^ (x << 5u);
    x = x * 0x9e3779b1u + i;
  }
  out[i] = x;
}
`;
