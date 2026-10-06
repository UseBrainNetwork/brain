/** f32 activations ↔ base64, for carrying hidden states through JSON in both Node and the browser. */

export function encodeF32(a: Float32Array): string {
  const bytes = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  let s = "";
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CH)));
  return btoa(s);
}

export function decodeF32(b64: string): Float32Array {
  let bytes: Uint8Array;
  if (typeof Buffer !== "undefined") {
    const b = Buffer.from(b64, "base64");
    bytes = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  } else {
    const s = atob(b64);
    bytes = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  }
  if ((bytes.byteOffset & 3) === 0 && bytes.byteLength % 4 === 0) return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4).slice();
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Float32Array(copy.buffer, 0, Math.floor(copy.byteLength / 4));
}
