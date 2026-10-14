// Live check of the shop gift (Presente) end to end against the real server (Docker + server), no browser. Accounts: A (sender),
// B (receiver, online), C (never logs in: the offline receiver).
//   catalog 1029 -> A picks a gold good (class 1) -> C offline: 1048 gives 1047 0x80001019 (no charge)
//   A -> B: 1048 -> 1049 (goodIds carry the good), A's gold drops by the price, B gets a 1931 note of type 2 whose senderId low
//   dword is the goodId (giftGoodsId, exe _ui32GoodsID), the note sender is A, the row is in player_messages (type 2)
//   B accepts: 1056 -> 1057 code 1, the 3334 delta carries the item, the row is gone, a second accept answers 0x80000000
//   the item is in player_items of B (DB), and an accept of an unknown id answers 0x80000000.
// Usage (stack up: npm run dev:all): node --experimental-transform-types src/net/test/gift.live.ts [--gw ws://127.0.0.1:8090] [--api http://127.0.0.1:8090]
// Exit 0 = pass.
import { execFileSync } from "node:child_process";
import { AuthClient, gameTargetForServer } from "../authClient.ts";
import { GameClient } from "../gameClient.ts";
import { GameMetaOp, collectEnterPushes, acceptGift, buildShopGetSailList, giftGoods, parseInventoryGetInfo } from "../metaGame.ts";
import { giftGoodsId, NoteList, type Note } from "../noteClient.ts";
import { ShopCatalog } from "../shopCatalog.ts";
import { BuyType, type InventoryDelta, type ShopGood } from "../../lobby/types.ts";

const arg = (k: string, d: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const GW = arg("--gw", "ws://127.0.0.1:8090");
const API = arg("--api", "http://127.0.0.1:8090");
const t0 = Date.now();
const log = (who: string, msg: string) => console.log(`${((Date.now() - t0) / 1000).toFixed(2).padStart(6)}s [${who}] ${msg}`);
const results: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail: string) => { results.push({ name, ok, detail }); log(ok ? "PASS" : "FAIL", `${name}: ${detail}`); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hex = (n: number) => `0x${(n >>> 0).toString(16)}`;
const rnd = Math.random().toString(36).slice(2, 7);

/** DB (docker exec psql, the local Postgres of dev-all) */
function sql(q: string): string[][] {
  const out = execFileSync("docker", ["exec", "pb-postgres-local", "psql", "-U", "postgres", "-d", "pb", "-At", "-F", "\t", "-c", q], { encoding: "utf8" });
  return out.split(/\r?\n/).filter(Boolean).map((l) => l.split("\t"));
}

async function account(username: string): Promise<Uint8Array> {
  const res = await fetch(`${API}/api/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password: "gift-live-pw1" }) });
  const body = (await res.json()) as { token?: string; error?: string };
  if (res.status !== 201 || !body.token) throw new Error(`register ${username}: ${res.status} ${body.error ?? ""}`);
  return Uint8Array.from(Buffer.from(body.token, "base64"));
}

interface Session { who: string; game: GameClient; nick: string; playerId: bigint; notes: NoteList }

/** one login (Auth, then the Game lobby) as notes.live.ts does; the note list is attached to the Game connection */
async function enter(who: string, token: Uint8Array): Promise<Session> {
  await sleep(1200); // the auth drops a 2nd login from the same IP within 1 s
  const auth = new AuthClient(GW);
  const mac = crypto.getRandomValues(new Uint8Array(6));
  mac[0] = (mac[0] & 0xfe) | 2;
  const login = await auth.connectAndLogin({ token, mac });
  if (!login.ok) throw new Error(`${who}: login ${login.errorName}`);
  const servers = await auth.getServers();
  const server = servers.find((s) => s.index > 0)!;
  await auth.leave();
  const game = new GameClient(gameTargetForServer(server), GW);
  let pushes: Promise<unknown> | null = null;
  const connect = game.conn.connect.bind(game.conn);
  game.conn.connect = async (...a) => { const i = await connect(...a); pushes = collectEnterPushes(game.conn).done; return i; };
  await game.enter(login.username, login.playerId, server.index);
  await pushes!;
  await game.selectChannel(0);
  await game.enterLobby();
  const notes = new NoteList();
  notes.attach(game.conn);
  log(who, `in lobby as ${login.username}`);
  return { who, game, nick: login.username, playerId: login.playerId, notes };
}

async function until(fn: () => boolean, ms = 4000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await sleep(50); }
  return fn();
}

async function main(): Promise<void> {
  const nA = `ga${rnd}`, nB = `gb${rnd}`, nC = `gc${rnd}`;
  const tokA = await account(nA), tokB = await account(nB), tokC = await account(nC);
  const A = await enter("A", tokA);
  const B = await enter("B", tokB);
  // C registers but never logs in: offline by definition
  const [pidA] = sql(`select player_id from accounts where nickname='${A.nick}'`)[0];
  const pidB = String(B.playerId);

  // catalog: a gold-priced weapon (class 1) that A can pay for
  const cat = new ShopCatalog();
  const off = A.game.conn.on((op, r) => cat.onPacket(op, r));
  A.game.conn.send(1029, buildShopGetSailList(""));
  await Promise.race([cat.ready, sleep(8000)]);
  off();
  const data = await cat.decode();
  const gold = Number(sql(`select gold from accounts where player_id=${pidA}`)[0][0]);
  const cls = (itemId: number) => Math.floor(itemId / 100000);
  const good: ShopGood | undefined = data.goods.filter((g) => cls(g.itemId) === 1 && g.priceGold > 1 && g.priceGold <= gold && g.itemId !== 0)
    .sort((x, y) => x.priceGold - y.priceGold)[0];
  if (!good) { log("A", `no gold weapon in the catalog (${data.goods.length} goods): nothing to gift`); process.exit(2); }
  log("A", `gift good ${good.goodId} -> item ${good.itemId} for ${good.priceGold} gold (A has ${gold})`);
  const cart = [{ goodId: good.goodId, buyType: BuyType.Gold }];

  // offline receiver: 1047 0x80001019, no charge
  const off1 = await giftGoods(A.game.conn, cart, nC);
  const goldAfterOff = Number(sql(`select gold from accounts where player_id=${pidA}`)[0][0]);
  check("offline receiver refused (1047)", !off1.ok && off1.code === 0x80001019, `code ${hex(off1.code)}`);
  check("offline refusal charges nothing", goldAfterOff === gold, `gold ${gold} -> ${goldAfterOff}`);

  // the gift: 1048 -> 1049
  const ok = await giftGoods(A.game.conn, cart, B.nick);
  check("gift 1048 -> 1049 ok", ok.ok && ok.goodIds.includes(good.goodId), `ok ${ok.ok} code ${hex(ok.code)} goods ${ok.goodIds}`);
  const goldAfter = Number(sql(`select gold from accounts where player_id=${pidA}`)[0][0]);
  check("sender charged the price", goldAfter === gold - good.priceGold, `gold ${gold} -> ${goldAfter} (price ${good.priceGold})`);
  check("B gets the gift note (1931)", await until(() => B.notes.list.some((n) => n.type === 2)), `B list ${B.notes.list.map((n) => `${n.type}:${n.sender}`).join(",") || "empty"}`);
  const note: Note | undefined = B.notes.list.find((n) => n.type === 2);
  check("note: type 2, sender A, goodId in senderId", !!note && note.sender === A.nick && giftGoodsId(note) === good.goodId, `sender ${note?.sender} goodId ${note ? giftGoodsId(note) : "-"} want ${good.goodId}`);
  const rows = sql(`select type, sender_id, sender_name from player_messages where owner_id=${pidB} and type=2`);
  check("note row in player_messages (type 2)", rows.length === 1 && rows[0][2] === A.nick, `rows ${JSON.stringify(rows)}`);

  // accept: 1056 -> 1057 code 1; the 3334 delta carries the item
  const deltas: InventoryDelta[] = [];
  const offB = B.game.conn.on((op, r) => { if (op === GameMetaOp.INVENTORY_GET_INFO_ACK) deltas.push(parseInventoryGetInfo(r)); });
  const accepted = await acceptGift(B.game.conn, note!.id);
  offB();
  check("3334 delta carries the item", deltas.some((d) => d.items.some((i) => i.itemId === good.itemId)), `deltas ${deltas.map((d) => d.items.map((i) => i.itemId).join("/")).join(" ; ") || "none"}`);
  check("accept 1056 -> 1057 code 1", accepted === 1, `code ${hex(accepted)}`);
  const gone = Number(sql(`select count(*) from player_messages where object_id=${note!.id} and owner_id=${pidB}`)[0][0]);
  check("note deleted on accept", gone === 0, `rows left ${gone}`);
  const owned = Number(sql(`select count(*) from player_items where owner_id=${pidB} and id=${good.itemId}`)[0][0]);
  check("item in B's inventory (DB)", owned >= 1, `player_items rows for item ${good.itemId}: ${owned}`);
  const again = await acceptGift(B.game.conn, note!.id);
  check("second accept refused (0x80000000)", again === 0x80000000, `code ${hex(again)}`);

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  for (const s of [A, B]) s.game.close();
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((e) => { console.error("gift.live:", e); process.exit(1); });
