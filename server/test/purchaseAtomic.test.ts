// every gold / cash / tags change is one conditional UPDATE by delta (dao.addMoney), never the absolute
// balance of an in-memory copy. The SQL shape runs anywhere (pool.query mocked); the race needs the local Postgres (docker
// pb-postgres-local) and is skipped without it: it writes one throwaway accounts row and removes it.
//   node --test test/purchaseAtomic.test.ts
import { test, after, mock } from "node:test";
import assert from "node:assert/strict";
import { pool } from "../src/db.ts";
import { addMoney } from "../src/shared/dao.ts";

after(async () => { await pool.end(); });

const wallet = (playerId: bigint, gold: number, cash = 0, tags = 0) => ({ playerId, gold, cash, tags });

test("addMoney: a delta with the debit condition in the WHERE, never an absolute balance; a refusal reads the row back", async () => {
  const seen: { sql: string; args: unknown[] }[] = [];
  const q = mock.method(pool, "query", async (sql: string, args: unknown[] = []) => {
    seen.push({ sql, args });
    return /^SELECT/.test(sql.trim()) ? { rows: [{ gold: 40, cash: 7, tags: 1 }] } : { rows: [] }; // the UPDATE matched nothing
  });
  try {
    const w = wallet(5n, 1000, 7, 1); // stale copy: the row only holds 40 gold
    assert.equal(await addMoney(w, -100), false);
    assert.match(seen[0].sql, /SET gold = gold \+ \$1::int, cash = cash \+ \$2::int, tags = tags \+ \$3::int/);
    assert.match(seen[0].sql, /gold >= -\$1::int/);
    assert.match(seen[0].sql, /RETURNING gold, cash, tags/);
    assert.deepEqual(seen[0].args, [-100, 0, 0, "5"], "only the delta goes to the database");
    assert.deepEqual(w, wallet(5n, 40, 7, 1), "the copy now shows the row");
    seen.length = 0;
    assert.equal(await addMoney(w, 0, 0, 0), true);
    assert.equal(seen.length, 0, "nothing to change: no query");
  } finally { q.mock.restore(); }
});

test("two sessions spend the same exact balance at once: one debit passes, the other is refused, nothing goes negative (needs Postgres)", async (t) => {
  let pid: bigint;
  try {
    const user = `ga${Date.now().toString(36)}`.slice(0, 16);
    pid = BigInt((await pool.query(
      `INSERT INTO accounts (username, password, nickname, email, token, gold, cash, access_level) VALUES ($1, 'x', $1, $2, '', 1000, 500, 0) RETURNING player_id`,
      [user, `${user}@test.local`])).rows[0].player_id);
  } catch { t.skip("no Postgres"); return; }
  try {
    // two Game sessions of one account (the oldhole) or two packets: separate copies that both see 1000 gold
    for (let round = 0; round < 10; round++) {
      await pool.query("UPDATE accounts SET gold = 1000, cash = 500 WHERE player_id = $1", [String(pid)]);
      const a = wallet(pid, 1000, 500), b = wallet(pid, 1000, 500);
      const ok = await Promise.all([addMoney(a, -1000), addMoney(b, -1000)]);
      assert.equal(ok.filter(Boolean).length, 1, `round ${round}: exactly one purchase passes`);
      const row = (await pool.query("SELECT gold, cash FROM accounts WHERE player_id = $1", [String(pid)])).rows[0];
      assert.deepEqual([row.gold, row.cash], [0, 500]);
      assert.deepEqual([a.gold, b.gold], [0, 0], "both copies read the row back");
    }
    // a reward credited while a purchase debits (battle end vs shop): both land, whatever the order
    await pool.query("UPDATE accounts SET gold = 1000, cash = 500 WHERE player_id = $1", [String(pid)]);
    const shop = wallet(pid, 1000, 500), battle = wallet(pid, 1000, 500);
    assert.deepEqual(await Promise.all([addMoney(shop, -600, -500), addMoney(battle, 350, 20)]), [true, true]);
    const row = (await pool.query("SELECT gold, cash FROM accounts WHERE player_id = $1", [String(pid)])).rows[0];
    assert.deepEqual([row.gold, row.cash], [750, 20]);
    assert.equal(await addMoney(shop, 0, -21), false, "cash 20 does not pay 21");
    assert.equal(shop.cash, 20);
  } finally {
    await pool.query("DELETE FROM accounts WHERE player_id = $1", [String(pid)]);
  }
});
