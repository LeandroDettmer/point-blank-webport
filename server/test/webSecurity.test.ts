// Web account security: scrypt passwords (legacy bcrypt still verifies and is upgraded), hashed tokens in
// accounts.token (legacy plaintext is migrated on lookup), message bucket and per-IP cap.
import { test } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import { hashPassword, verifyPassword, needsRehash } from "../src/web/accounts/password.ts";
import { storedToken, generateToken } from "../src/web/accounts/token.ts";
import { Bucket, IpCap } from "../src/web/guard.ts";
import { registerAccount, loginAccount } from "../src/web/accounts/accounts.ts";
import type http from "node:http";
import { ensureAccountSchema, isAllowedOrigin, clientIp } from "../src/web/webServer.ts";
import { accountByToken, pool } from "../src/db.ts";

test("scrypt hash verifies, rejects a wrong password and a corrupt row", async () => {
  const h = await hashPassword("s3cret-pw");
  assert.ok(h.startsWith("scrypt$"));
  assert.equal(await verifyPassword("s3cret-pw", h), true);
  assert.equal(await verifyPassword("other", h), false);
  assert.equal(needsRehash(h), false);
  assert.equal(await verifyPassword("x", "scrypt$999999999$8$5$AAAA$AAAA"), false);
  assert.equal(await verifyPassword("x", "garbage"), false);
});

test("legacy bcrypt hash verifies and needs rehash", async () => {
  const b = await bcrypt.hash("old-pw-1", 4);
  assert.equal(await verifyPassword("old-pw-1", b), true);
  assert.equal(await verifyPassword("nope", b), false);
  assert.equal(needsRehash(b), true);
});

test("stored token: 32 chars, stable, not the plaintext", () => {
  const t = generateToken();
  const s = storedToken(t);
  assert.equal(s.length, 32);
  assert.equal(s, storedToken(t));
  assert.notEqual(s, t);
  assert.ok(s.startsWith("h:"));
});

test("Bucket refills, IpCap caps non-loopback only", () => {
  const b = new Bucket(2, 1, 0);
  assert.equal(b.take(1, 0), true);
  assert.equal(b.take(1, 0), true);
  assert.equal(b.take(1, 0), false);
  assert.equal(b.take(1, 1000), true);
  const cap = new IpCap(2);
  assert.equal(cap.acquire("10.0.0.1"), true);
  assert.equal(cap.acquire("10.0.0.1"), true);
  assert.equal(cap.acquire("10.0.0.1"), false);
  cap.release("10.0.0.1");
  assert.equal(cap.acquire("10.0.0.1"), true);
  for (let i = 0; i < 10; i++) assert.equal(cap.acquire("127.0.0.1"), true);
});

test("origin allow-list: vite :8000/:8001 always, PB_WEB_ORIGINS exact only", () => {
  assert.equal(isAllowedOrigin("http://localhost:8000", []), true);
  assert.equal(isAllowedOrigin("http://192.168.0.5:8001", []), true);
  assert.equal(isAllowedOrigin("https://game.example.test", []), false);
  assert.equal(isAllowedOrigin("https://game.example.test", ["https://game.example.test"]), true);
  assert.equal(isAllowedOrigin("https://game.example.test.evil.com", ["https://game.example.test"]), false);
});

test("client IP: socket peer, or the last X-Forwarded-For entry behind a trusted proxy", () => {
  const req = (xff?: string) => ({ headers: xff ? { "x-forwarded-for": xff } : {}, socket: { remoteAddress: "169.254.1.1" } }) as unknown as http.IncomingMessage;
  assert.equal(clientIp(req("1.2.3.4, 5.6.7.8"), false), "169.254.1.1");
  assert.equal(clientIp(req("6.6.6.6, 5.6.7.8"), true), "5.6.7.8"); // the caller-supplied 6.6.6.6 is ignored
  assert.equal(clientIp(req(), true), "169.254.1.1");
});

test("register/login store hashed token + scrypt; plaintext token row migrates (needs Postgres)", async (t) => {
  try { await ensureAccountSchema(); } catch { t.skip("no Postgres"); await pool.end(); return; }
  const user = `t${Date.now().toString(36)}`.slice(0, 16);
  try {
    const reg = await registerAccount(user, "pw-123456");
    const row = (await pool.query("SELECT token FROM accounts WHERE username=$1", [user])).rows[0];
    assert.equal(row.token, storedToken(reg.token));
    assert.ok((await accountByToken(reg.token))?.username === user);
    assert.equal(await accountByToken(row.token), null); // the stored form is not a login credential

    // legacy: plaintext token in accounts, bcrypt in credentials
    await pool.query("UPDATE accounts SET token=$1 WHERE username=$2", [reg.token, user]);
    assert.ok((await accountByToken(reg.token))?.username === user);
    assert.equal((await pool.query("SELECT token FROM accounts WHERE username=$1", [user])).rows[0].token, storedToken(reg.token));

    await pool.query("UPDATE account_api_credentials SET password_hash=$1 WHERE username=$2", [await bcrypt.hash("pw-123456", 4), user]);
    const login = await loginAccount(user, "pw-123456");
    assert.notEqual(login.token, reg.token);
    const cred = (await pool.query("SELECT password_hash FROM account_api_credentials WHERE username=$1", [user])).rows[0].password_hash as string;
    assert.ok(cred.startsWith("scrypt$"));
    assert.ok((await accountByToken(login.token))?.username === user);
    assert.equal(await accountByToken(reg.token), null); // the old token died with the new login
  } finally {
    await pool.query("DELETE FROM accounts WHERE username=$1", [user]);
    await pool.query("DELETE FROM account_api_credentials WHERE username=$1", [user]);
    await pool.end();
  }
});
