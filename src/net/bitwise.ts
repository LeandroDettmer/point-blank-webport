// Port of Plugin.Core/Utility/Bitwise.cs Encrypt/Decrypt (whole-buffer rotate by `shift` bits).
// Used by the Match (UDP) side; shift = (SessionId + Bitwise.CRYPTO[0]) % 7 + 1.

export const CRYPTO = [29890, 32759, 1360] as const;

export function sessionShift(sessionId: number): number {
  return ((sessionId + CRYPTO[0]) % 7) + 1;
}

export function bitwiseEncrypt(data: Uint8Array, shift: number): Uint8Array {
  if (data.length === 0) return new Uint8Array(0);
  const r = data.slice();
  const first = r[0];
  for (let i = 0; i < r.length - 1; i++) {
    r[i] = ((r[i + 1] >> (8 - shift)) | (r[i] << shift)) & 0xff;
  }
  r[r.length - 1] = ((first >> (8 - shift)) | (r[r.length - 1] << shift)) & 0xff;
  return r;
}

export function bitwiseDecrypt(data: Uint8Array, shift: number): Uint8Array {
  if (data.length === 0) return new Uint8Array(0);
  const r = data.slice();
  const last = r[r.length - 1];
  for (let i = r.length - 1; i > 0; i--) {
    r[i] = ((r[i - 1] << (8 - shift)) | (r[i] >> shift)) & 0xff;
  }
  r[0] = ((last << (8 - shift)) | (r[0] >> shift)) & 0xff;
  return r;
}
