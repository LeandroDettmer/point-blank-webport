// Port of server/Plugin.Core/Utility/cmess.cs (CMessCipher + PacketFraming + session seed LCG).
// This is the cipher the PB client uses for client->server TCP packets on Auth and Game
// (both servers call CMessCipher.Decrypt(ClientKey, ..., MODE_AUTH)). Server->client is plaintext.
// CryptoSyncer (AES-CTR) is NOT on this path.

export const MODE_AUTH = 1;
export const MODE_GAME = 2;

function bitsAt(reg: Uint8Array, bitPos: number): number {
  const byteIdx = (bitPos >> 3) & 7;
  const bitOff = bitPos & 7;
  if (bitOff !== 0) {
    const lo = ((reg[byteIdx] & (0xff >> bitOff)) << bitOff) & 0xff;
    const hi = reg[(byteIdx + 1) & 7] >> (8 - bitOff);
    return (lo + hi) & 0xff;
  }
  return reg[byteIdx];
}

function updateState(k0: Uint8Array, k1: Uint8Array, c: number): void {
  k0[0] ^= c; k0[2] ^= c; k0[4] ^= c; k0[6] ^= c;
  k1[1] ^= c; k1[3] ^= c; k1[5] ^= c; k1[7] ^= c;
}

function deriveInitialState(r0: number, r1: number, r2: number, mode: number) {
  let initPos0: number, r2adj: number, step: number;
  switch (mode) {
    case MODE_AUTH:
      initPos0 = (r2 >> 4) + r0; r2adj = r2 & 0x0f; step = 8; break;
    case MODE_GAME:
      initPos0 = (r2 & 0x0f) + r0; r2adj = r2 >> 4; step = 14; break;
    default:
      initPos0 = r2 + r0; r2adj = r2; step = 12; break;
  }
  return { initPos0, initPos1: r2adj + r1, step };
}

class Keystream {
  private k0: Uint8Array;
  private k1: Uint8Array;
  private v18 = 0;
  private runXor = 0;
  private p0: number;
  private p1: number;
  private step: number;

  constructor(key: Uint8Array, r0: number, r1: number, r2: number, mode: number) {
    if (key.length < 16) throw new Error("CMess key must be 16 bytes");
    this.k0 = key.slice(0, 8);
    this.k1 = key.slice(8, 16);
    const s = deriveInitialState(r0, r1, r2, mode);
    this.p0 = s.initPos0; this.p1 = s.initPos1; this.step = s.step;
  }

  next(): number {
    const s0 = bitsAt(this.k0, this.v18 + this.p0);
    const s1 = bitsAt(this.k1, this.v18 + this.p1);
    this.runXor = (this.runXor ^ s0 ^ s1) & 0xff;
    this.v18 = this.runXor + this.v18 + this.step;
    return this.runXor;
  }

  feed(cipherByte: number): void {
    updateState(this.k0, this.k1, cipherByte);
  }
}

export interface CMessRandom { r0: number; r1: number; r2: number }

function randomHeader(): CMessRandom {
  const b = new Uint8Array(3);
  crypto.getRandomValues(b);
  return { r0: b[0] % 64, r1: b[1] % 64, r2: b[2] };
}

/** CMessCipher.Encrypt. Output = [r0, r1, r2, padLen, enc(data), enc(pad)]. */
export function cmessEncrypt(key: Uint8Array, src: Uint8Array, mode: number, rnd: CMessRandom = randomHeader()): Uint8Array {
  const { r0, r1, r2 } = rnd;
  const padLen = ((2 - src.length) & 7) + 2;
  const ks = new Keystream(key, r0, r1, r2, mode);
  const dst = new Uint8Array(4 + src.length + padLen);
  dst[0] = r0; dst[1] = r1; dst[2] = r2; dst[3] = padLen;
  let o = 4;
  for (let i = 0; i < src.length; i++) {
    const c = (ks.next() ^ src[i]) & 0xff;
    dst[o++] = c;
    ks.feed(c);
  }
  for (let i = 0; i < padLen; i++) {
    const c = (padLen ^ ks.next()) & 0xff;
    dst[o++] = c;
    ks.feed(c);
  }
  return dst;
}

/** CMessCipher.Decrypt. Returns null when the header/pad check fails (server would drop the socket). */
export function cmessDecrypt(key: Uint8Array, ct: Uint8Array, mode: number): Uint8Array | null {
  if (ct.length < 4) return null;
  const padLen = ct[3];
  if (padLen < 2 || padLen > 9) return null;
  const dataLen = ct.length - 4 - padLen;
  if (dataLen < 0) return null;
  const ks = new Keystream(key, ct[0], ct[1], ct[2], mode);
  const plain = new Uint8Array(dataLen);
  let i = 4;
  for (let j = 0; j < dataLen; j++, i++) {
    plain[j] = (ks.next() ^ ct[i]) & 0xff;
    ks.feed(ct[i]);
  }
  const pad: number[] = [];
  for (let j = 0; j < padLen; j++, i++) {
    pad.push((ks.next() ^ ct[i]) & 0xff);
    ks.feed(ct[i]);
  }
  return pad[0] === padLen && pad[1] === padLen ? plain : null;
}

// ---- PacketFraming ----------------------------------------------------------

export const ENCRYPTED_FLAG = 0x8000;

/** Client->server frame: [u16 len|0x8000][cmess][1 trailer byte]. Server WireLength = 3 + len. */
export function buildEncryptedFrame(cmess: Uint8Array): Uint8Array {
  if (cmess.length > 0x7fff) throw new Error("CMess payload too large");
  const hw = cmess.length | ENCRYPTED_FLAG;
  const frame = new Uint8Array(3 + cmess.length);
  frame[0] = hw & 0xff;
  frame[1] = hw >> 8;
  frame.set(cmess, 2);
  return frame;
}

/** AuthClient/GameClient.GetNextSessionSeed (MSVC rand LCG, C# int wraparound). */
export function nextSessionSeed(seed: number): number {
  return (((Math.imul(seed, 214013) + 2531011) | 0) >> 16) & 0x7fff;
}

/**
 * Server->client stream reassembler. Server writes [u16 hw = N+2][N payload bytes][5 zero bytes],
 * i.e. wire length = (hw & 0x7fff) + 5 (plain) or + 3 (encrypted, never seen from server).
 * The emitted payload is the `hw & 0x7fff` bytes after the header: opcode first, possibly
 * followed by trailing zeros. Zero-length frames (hw = 0) are swallowed.
 */
export class FrameDecoder {
  private pending = new Uint8Array(0);

  push(chunk: Uint8Array): { payload: Uint8Array; encrypted: boolean }[] {
    const buf = new Uint8Array(this.pending.length + chunk.length);
    buf.set(this.pending, 0);
    buf.set(chunk, this.pending.length);
    const out: { payload: Uint8Array; encrypted: boolean }[] = [];
    let off = 0;
    while (off + 2 <= buf.length) {
      const hw = buf[off] | (buf[off + 1] << 8);
      const encrypted = (hw & ENCRYPTED_FLAG) !== 0;
      const pl = hw & 0x7fff;
      const wire = encrypted ? 3 + pl : 5 + pl;
      if (off + wire > buf.length) break;
      if (pl >= 2) out.push({ payload: buf.slice(off + 2, off + 2 + pl), encrypted });
      off += wire;
    }
    this.pending = buf.slice(off);
    return out;
  }
}
