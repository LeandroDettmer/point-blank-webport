// Run: npm run test:net  (node --test, native TS type stripping)
// vectors.json was produced by compiling the server's C# sources verbatim
// (cmess.cs CMessCipher.Encrypt, CryptoSyncer.ProcessData_AES_CTR (not ported: off the client path), Bitwise.Encrypt/Decrypt,
// GetNextSessionSeed) with Roslyn csc; "Test vectors".
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { cmessDecrypt, cmessEncrypt, nextSessionSeed, FrameDecoder, buildEncryptedFrame, MODE_AUTH } from "../cmess.ts";
import { bitwiseDecrypt, bitwiseEncrypt } from "../bitwise.ts";
import { fromHex, toHex } from "../bytes.ts";

interface Vectors {
  cmess: { mode: number; key: string; pt: string; ct: string }[];
  aesctr: { pt: string; ct: string }[];
  bitwise: { shift: number; pt: string; ct: string; dec: string }[];
  seeds: { seed: number; next: number[] }[];
}
const V: Vectors = JSON.parse(readFileSync(new URL("./vectors.json", import.meta.url), "utf8"));

test("CMess encrypt matches C# byte-for-byte (same r0/r1/r2)", () => {
  for (const v of V.cmess) {
    const ct = fromHex(v.ct);
    const out = cmessEncrypt(fromHex(v.key), fromHex(v.pt), v.mode, { r0: ct[0], r1: ct[1], r2: ct[2] });
    assert.equal(toHex(out), v.ct, `mode ${v.mode} len ${v.pt.length / 2}`);
  }
});

test("CMess decrypt recovers C# plaintext and validates pad", () => {
  for (const v of V.cmess) {
    const pt = cmessDecrypt(fromHex(v.key), fromHex(v.ct), v.mode);
    assert.ok(pt, "pad check");
    assert.equal(toHex(pt!), v.pt);
    const bad = fromHex(v.ct);
    bad[4 + v.pt.length / 2] ^= 0x55; // first pad byte (C# checks pad[0], pad[1])
    assert.equal(cmessDecrypt(fromHex(v.key), bad, v.mode), null);
  }
});

test("CMess random round trip", () => {
  const key = crypto.getRandomValues(new Uint8Array(16));
  for (let n = 0; n < 300; n += 7) {
    const pt = crypto.getRandomValues(new Uint8Array(n));
    assert.equal(toHex(cmessDecrypt(key, cmessEncrypt(key, pt, MODE_AUTH), MODE_AUTH)!), toHex(pt));
  }
});

test("Bitwise shift cipher matches C#", () => {
  for (const v of V.bitwise) {
    assert.equal(toHex(bitwiseEncrypt(fromHex(v.pt), v.shift)), v.ct);
    assert.equal(toHex(bitwiseDecrypt(fromHex(v.ct), v.shift)), v.dec);
    assert.equal(v.dec, v.pt);
  }
});

test("session seed LCG matches C# (int overflow)", () => {
  for (const v of V.seeds) {
    let s = v.seed;
    const got = v.next.map(() => (s = nextSessionSeed(s)));
    assert.deepEqual(got, v.next);
  }
});

test("FrameDecoder handles server framing split across chunks", () => {
  // Server SendPacket: [u16 N+2][N bytes][5 zero bytes]
  const mk = (payload: number[]) => [(payload.length + 2) & 0xff, (payload.length + 2) >> 8, ...payload, 0, 0, 0, 0, 0];
  const stream = Uint8Array.from([...mk([0x02, 0x09, 1, 2, 3]), ...mk([0x1d, 0x09])]);
  const dec = new FrameDecoder();
  const a = dec.push(stream.subarray(0, 4));
  const b = dec.push(stream.subarray(4, 13));
  const c = dec.push(stream.subarray(13));
  const all = [...a, ...b, ...c];
  assert.equal(all.length, 2);
  assert.equal(toHex(all[0].payload.subarray(0, 5)), "0209010203");
  assert.equal(all[1].payload[0] | (all[1].payload[1] << 8), 2333);
});

test("encrypted frame header + trailer", () => {
  const f = buildEncryptedFrame(new Uint8Array(10));
  assert.equal(f.length, 13);
  assert.equal(f[0] | (f[1] << 8), 0x8000 | 10);
});
