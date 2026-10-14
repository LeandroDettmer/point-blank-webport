// Little-endian packet reader/writer mirroring Plugin.Core BaseServerPacket / BaseClientPacket
// (BinaryWriter/BinaryReader semantics). Field letters follow the C# names:
// C=u8 H=u16 D=u32/i32 Q=u64/i64 T=f32 F=f64 B=bytes S=utf8 fixed U=utf16le fixed.

const utf8 = new TextEncoder();
const utf8d = new TextDecoder("utf-8");
const utf16d = new TextDecoder("utf-16le");

export class PacketWriter {
  private buf: Uint8Array;
  private view: DataView;
  length = 0;

  constructor(initial = 64) {
    this.buf = new Uint8Array(initial);
    this.view = new DataView(this.buf.buffer);
  }

  private ensure(n: number): void {
    if (this.length + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.length + n) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.length));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }

  writeC(v: number): this {
    this.ensure(1);
    this.view.setUint8(this.length, v & 0xff);
    this.length += 1;
    return this;
  }

  writeH(v: number): this {
    this.ensure(2);
    this.view.setUint16(this.length, v & 0xffff, true);
    this.length += 2;
    return this;
  }

  writeD(v: number): this {
    this.ensure(4);
    this.view.setUint32(this.length, v >>> 0, true);
    this.length += 4;
    return this;
  }

  writeQ(v: bigint): this {
    this.ensure(8);
    this.view.setBigUint64(this.length, BigInt.asUintN(64, v), true);
    this.length += 8;
    return this;
  }

  writeT(v: number): this {
    this.ensure(4);
    this.view.setFloat32(this.length, v, true);
    this.length += 4;
    return this;
  }

  writeB(bytes: Uint8Array | number[]): this {
    const b = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
    this.ensure(b.length);
    this.buf.set(b, this.length);
    this.length += b.length;
    return this;
  }

  zeros(n: number): this {
    this.ensure(n);
    this.buf.fill(0, this.length, this.length + n);
    this.length += n;
    return this;
  }

  /** UTF-8 bytes, zero padded to `count` (C# WriteS). */
  writeS(text: string, count: number): this {
    const b = utf8.encode(text);
    this.writeB(b.subarray(0, count));
    return this.zeros(Math.max(0, count - b.length));
  }

  /** UTF-16LE bytes, zero padded to `count` bytes (C# WriteU). */
  writeU(text: string, count: number): this {
    const out = new Uint8Array(count);
    for (let i = 0; i < text.length && i * 2 + 1 < count; i++) {
      const c = text.charCodeAt(i);
      out[i * 2] = c & 0xff;
      out[i * 2 + 1] = c >> 8;
    }
    return this.writeB(out);
  }

  toBytes(): Uint8Array {
    return this.buf.slice(0, this.length);
  }
}

export class PacketReader {
  readonly data: Uint8Array;
  private view: DataView;
  pos: number;

  constructor(data: Uint8Array, offset = 0) {
    this.data = data;
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    this.pos = offset;
  }

  get remaining(): number {
    return this.data.length - this.pos;
  }

  private need(n: number): void {
    if (this.pos + n > this.data.length) {
      throw new RangeError(`PacketReader: need ${n} bytes at ${this.pos}, have ${this.remaining}`);
    }
  }

  readC(): number {
    this.need(1);
    return this.view.getUint8(this.pos++);
  }

  readH(): number {
    this.need(2);
    const v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }

  readD(): number {
    this.need(4);
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }

  readSignedD(): number {
    this.need(4);
    const v = this.view.getInt32(this.pos, true);
    this.pos += 4;
    return v;
  }

  readT(): number {
    this.need(4);
    const v = this.view.getFloat32(this.pos, true);
    this.pos += 4;
    return v;
  }

  readQ(): bigint {
    this.need(8);
    const v = this.view.getBigInt64(this.pos, true);
    this.pos += 8;
    return v;
  }

  readB(n: number): Uint8Array {
    this.need(n);
    const v = this.data.slice(this.pos, this.pos + n);
    this.pos += n;
    return v;
  }

  skip(n: number): this {
    this.need(n);
    this.pos += n;
    return this;
  }

  /** Fixed-size UTF-8 string, trimmed at first NUL (C# ReadS). */
  readS(n: number): string {
    const b = this.readB(n);
    const z = b.indexOf(0);
    return utf8d.decode(z >= 0 ? b.subarray(0, z) : b);
  }

  /** Fixed-size UTF-16LE string (n bytes), trimmed at first NUL char (C# ReadU). */
  readU(n: number): string {
    const s = utf16d.decode(this.readB(n));
    const z = s.indexOf("\0");
    return z >= 0 ? s.slice(0, z) : s;
  }
}
