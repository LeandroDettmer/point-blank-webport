// Web account passwords: scrypt from node:crypto (no dependency), `scrypt$N$r$p$salt$hash` (base64url).
// Hashes made before this module are bcrypt ($2a/$2b): they still verify (bcryptjs, legacy only) and are
// replaced by scrypt at the next good login (needsRehash).
import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";
import bcrypt from "bcryptjs";

/** OWASP equivalent of N=2^17,r=8,p=1: N=2^14, r=8, p=5 (16 MiB per hash). */
const SCRYPT: ScryptOptions = { N: 16384, r: 8, p: 5, maxmem: 64 * 1024 * 1024 };
const KEYLEN = 32;

const scryptAsync = (pw: string, salt: Buffer, len: number, o: ScryptOptions): Promise<Buffer> =>
  new Promise((ok, fail) => scrypt(pw, salt, len, o, (e, k) => (e ? fail(e) : ok(k))));

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(pw.normalize("NFKC"), salt, KEYLEN, SCRYPT);
  return ["scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString("base64url"), key.toString("base64url")].join("$");
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  if (stored.startsWith("$2")) return bcrypt.compare(pw, stored); // legacy
  const [alg, n, r, p, salt, hash] = stored.split("$");
  if (alg !== "scrypt" || !salt || !hash) return false;
  // never trust stored parameters blindly: a corrupt row must not ask for gigabytes (maxmem caps N*r too)
  if (!(Number(n) >= 1024 && Number(n) <= 1 << 20 && Number(r) >= 1 && Number(r) <= 32 && Number(p) >= 1 && Number(p) <= 16)) return false;
  const want = Buffer.from(hash, "base64url");
  const got = await scryptAsync(pw.normalize("NFKC"), Buffer.from(salt, "base64url"), want.length,
    { N: Number(n), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem });
  return got.length === want.length && timingSafeEqual(got, want);
}

/** legacy bcrypt, or scrypt with other parameters than the current ones */
export function needsRehash(stored: string): boolean {
  const [alg, n, r, p] = stored.split("$");
  return alg !== "scrypt" || Number(n) !== SCRYPT.N || Number(r) !== SCRYPT.r || Number(p) !== SCRYPT.p;
}
