// Live acceptance test against the real server (Docker) through the
// web front (server), no browser:
//   login -> 2316/2319 -> 1029 catalog -> 1045 buy gold primary -> 3334 with the itemId -> 6149 equip
//   -> relog: 3082 reflects it -> 2-player battle: RESPAWN with the itemId, 5138 echoes it
//   -> SELECT player_equipments confirms. Uses brand-new account-api accounts.
//   node src/net/test/meta.live.ts [--record] [--gw ws://127.0.0.1:8090] [--api http://127.0.0.1:8090]
// --record rewrites src/net/test/meta-vectors.json (raw S->C payloads + DB snapshot) for meta.test.ts.
import { writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { AuthClient, gameTargetForServer, type LoginResult } from "../authClient.ts";
import { GameClient } from "../gameClient.ts";
import { RoomClient, WIRE_READY } from "../roomClient.ts";
import { PbBattleNet } from "../battle.ts";
import { PacketReader, PacketWriter } from "../packet.ts";
import { toHex } from "../bytes.ts";
import type { PbConnection } from "../connection.ts";
import { fetchAuthMeta } from "../metaAuth.ts";
import {
  GameMetaOp, buildGoodsBuy, buildRespawnBody, buyGoods, changeEquip, collectEnterPushes, equipRequestFromLoadout,
  parseCharaInfo, parseDeleteItem, parseGoodsBuy, parseRespawnAck, unsavedCharas, type EnterPushes,
} from "../metaGame.ts";
import { ShopCatalog } from "../shopCatalog.ts";
import { buildShopGetSailList } from "../metaGame.ts";
import { BuyType, EquipSlot, type ShopGood } from "../../lobby/types.ts";

const arg = (k: string, d: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const GW = arg("--gw", "ws://127.0.0.1:8090");
const API = arg("--api", "http://127.0.0.1:8090");
const RECORD = process.argv.includes("--record");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (who: string, msg: string) => console.log(`${((Date.now() - t0) / 1000).toFixed(2).padStart(6)}s [${who}] ${msg}`);
const checks: { name: string; ok: boolean; detail: string }[] = [];
const blocked: { name: string; detail: string }[] = [];
const block = (name: string, detail: string) => { blocked.push({ name, detail }); log("BLOCKED", `${name}: ${detail}`); };
const check = (name: string, ok: boolean, detail: string) => { checks.push({ name, ok, detail }); log(ok ? "PASS" : "FAIL", `${name}: ${detail}`); };

// ---- DB (docker exec psql; credentials of server/.env.local: user postgres, db pb)
function sql(q: string): string[][] {
  const out = execFileSync("docker", ["exec", "pb-postgres-local", "psql", "-U", "postgres", "-d", "pb", "-At", "-F", "\t", "-c", q], { encoding: "utf8" });
  return out.split(/\r?\n/).filter(Boolean).map((l) => l.split("\t"));
}
function sqlObjects(q: string): Record<string, string>[] {
  const out = execFileSync("docker", ["exec", "pb-postgres-local", "psql", "-U", "postgres", "-d", "pb", "-A", "-F", "\t", "-c", q], { encoding: "utf8" });
  const lines = out.split(/\r?\n/).filter((l) => l && !/^\(\d+ rows?\)$/.test(l));
  const head = lines.shift()?.split("\t") ?? [];
  return lines.map((l) => Object.fromEntries(l.split("\t").map((v, i) => [head[i], v])));
}

// ---- raw payload recorder
interface Vec { conn: string; op: number; hex: string; step: string }
const vectors: Vec[] = [];
const KEEP = new Set([2317, 2319, 1061, 2453, 2331, 2371, 2395, 2369, 3082, 3334, 1047, 1059, 6150, 1039, 1037, 1075, 1042, 1041, 1030, 5138]);
let step = "init";
function record(conn: PbConnection, name: string): void {
  conn.on((op, r) => { if (KEEP.has(op)) vectors.push({ conn: name, op, hex: toHex(r.data), step }); });
}

async function account(username: string): Promise<{ token: Uint8Array; status: number }> {
  const res = await fetch(`${API}/api/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password: "w1-meta-pw1" }) });
  const body = (await res.json()) as { token?: string; error?: string };
  if (res.status !== 201 || !body.token) throw new Error(`account-api register ${username}: ${res.status} ${body.error ?? ""} (need a NEW account)`);
  return { token: Uint8Array.from(Buffer.from(body.token, "base64")), status: res.status };
}

interface Session { game: GameClient; login: LoginResult; pushes: EnterPushes; authMeta?: Awaited<ReturnType<typeof fetchAuthMeta>> }

async function enter(who: string, token: Uint8Array, withMeta: boolean): Promise<Session> {
  const auth = new AuthClient(GW);
  record(auth.conn, `auth-${who}`);
  const mac = crypto.getRandomValues(new Uint8Array(6));
  mac[0] = (mac[0] & 0xfe) | 2;
  const login = await auth.connectAndLogin({ token, mac });
  if (!login.ok) throw new Error(`${who}: login ${login.errorName}`);
  const authMeta = withMeta ? await fetchAuthMeta(auth.conn) : undefined;
  const servers = await auth.getServers();
  const server = servers.find((s) => s.index > 0)!;
  await auth.leave();
  const game = new GameClient(gameTargetForServer(server), GW);
  record(game.conn, `game-${who}`);
  // collectEnterPushes must be armed before USER_ENTER_REQ; GameClient.enter connects first, so hook connect.
  let pushes: Promise<EnterPushes> | null = null;
  const connect = game.conn.connect.bind(game.conn);
  game.conn.connect = async (...a) => { const i = await connect(...a); pushes = collectEnterPushes(game.conn).done; return i; };
  await game.enter(login.username, login.playerId, server.index);
  const p = await pushes!;
  await game.selectChannel(0);
  await game.enterLobby();
  log(who, `in lobby as ${login.username} pid ${login.playerId}`);
  return { game, login, pushes: p, authMeta };
}

async function main(): Promise<void> {
  const suffix = `${Date.now() % 1e7}`;
  const userA = `w1a${suffix}`, userB = `w1b${suffix}`;
  const accA = await account(userA);
  log("A", `account-api register ${userA}: ${accA.status}`);

  // ---- 1. login + Auth meta
  step = "login";
  const A = await enter("A", accA.token, true);
  const pid = A.login.playerId;
  const am = A.authMeta!;
  const dbChars = sql(`select slot, id from player_characters where owner_id=${pid} order by slot`);
  check("2317 nick", am.userInfo.basic?.nickname === A.login.username, `nick=${am.userInfo.basic?.nickname} gold=${am.userInfo.basic?.gold} cash=${am.userInfo.basic?.cash}`);
  check("2319 inventory", (am.inventory?.items.length ?? 0) > 0, `${am.inventory?.items.length} items, basicCount ${am.inventory?.basicCount}`);
  check("§7.4 characters without CREATE_NICK", dbChars.length > 0 && (A.pushes.charaInfo?.charas.length ?? 0) === dbChars.length,
    `player_characters=${dbChars.map((c) => c.join(":")).join(",")} 2453=${A.pushes.charaInfo?.charas.map((c) => `${c.slot}:${c.itemId}`).join(",")}`);
  const authChara = am.charaInfoRaw ? parseCharaInfo(new PacketReader(am.charaInfoRaw)) : null;
  const unsaved = authChara ? unsavedCharas(authChara) : [];
  log("A", `§7.4 Auth 2453 characters whose INSERT failed (stock objectId): ${unsaved.map((c) => `${c.slot}:${c.itemId}`).join(",") || "none"}; seq ${sql("select last_value from player_characters_seq")[0][0]} max ${sql("select max(object_id) from player_characters")[0][0]}`);
  const awards = sql(`select count(*) from player_items where owner_id=${pid}`)[0][0];
  log("A", `§7.4 player_items rows (CREATE_NICK 'award' items would be here): ${awards}`);
  const loadout0 = A.pushes.loadout!;
  const wallet0 = A.pushes.wallet!;
  log("A", `3082 primary ${loadout0.equip[0].itemId} chara ${loadout0.equip[8].itemId} slots ${loadout0.charaSlots}; wallet gold ${wallet0.gold} cash ${wallet0.cash}`);

  // ---- 2. catalog
  step = "catalog";
  const cat = new ShopCatalog();
  const off = A.game.conn.on((op, r) => cat.onPacket(op, r));
  A.game.conn.send(1029, buildShopGetSailList(""));
  await Promise.race([cat.ready, sleep(8000)]);
  off();
  const data = await cat.decode();
  log("A", `catalog: ${data.items.length} items, ${data.goods.length} goods, ${data.repairs.length} repairs, ${data.matching.length} matching, version ${data.version}, sailChanged ${data.sailChanged}`);
  check("catalog decoded", data.goods.length > 0 && data.items.length > 0, `zlib inflate ok (first packed byte 0x${cat.packed(1037)?.[0].toString(16)})`);
  const owned = new Set(am.inventory?.items.map((i) => i.itemId));
  const cls = (itemId: number) => Math.floor(itemId / 100000);
  const deliverable = (g: ShopGood) => g.itemId !== 0 && !owned.has(g.itemId) && cls(g.itemId) !== 6 && cls(g.itemId) !== 36;
  const goldPrimary = data.goods.filter((g) => cls(g.itemId) === 1 && g.priceGold > 0 && g.priceGold <= wallet0.gold && deliverable(g))
    .sort((x, y) => x.priceGold - y.priceGold);
  const hist: Record<string, number> = {};
  for (const g of data.goods) { const k = `class${cls(g.itemId)}${g.priceGold > 0 ? "+gold" : ""}${g.priceCash > 0 ? "+cash" : ""}`; hist[k] = (hist[k] ?? 0) + 1; }
  const useGold = goldPrimary.length > 0;
  if (!useGold) block("1045 gold primary", `packed catalog has no gold-priced primary: ${JSON.stringify(hist)} (server: system_shop load aborted, 'Field not found in row: variant_code_list'; db/init/001_init.sql not loaded)`);
  const price = (g: ShopGood) => (useGold ? g.priceGold : g.priceCash);
  const pool = useGold ? goldPrimary : data.goods.filter((g) => g.priceCash > 0 && g.priceCash <= wallet0.cash && deliverable(g)).sort((x, y) => x.priceCash - y.priceCash);
  if (!pool.length) throw new Error(`nothing buyable: ${JSON.stringify(hist)}`);
  const good = pool[0];
  const budget = useGold ? wallet0.gold : wallet0.cash;
  const extra = data.goods.find((g) => deliverable(g) && g.itemId !== good.itemId && price(g) > 0 && price(g) + price(good) <= budget);
  const buyType = useGold ? BuyType.Gold : BuyType.Cash;
  log("A", `buying (${useGold ? "gold" : "cash"}) good ${good.goodId} -> item ${good.itemId} x${good.count} for ${price(good)}${extra ? ` + good ${extra.goodId} -> item ${extra.itemId} for ${price(extra)} (to delete)` : ""}`);

  // failure vector: an unknown good
  step = "buy-fail";
  const failAck = A.game.conn.waitFor(GameMetaOp.SHOP_GOODS_BUY_ACK);
  A.game.conn.send(GameMetaOp.SHOP_GOODS_BUY_REQ, buildGoodsBuy([{ goodId: 99, buyType: BuyType.Gold }]));
  const fail = parseGoodsBuy(await failAck, [{ goodId: 99, buyType: BuyType.Gold }]);
  check("1047 fail branch", !fail.ok && fail.code === 0x80001017, `code 0x${fail.code.toString(16)} gold ${fail.gold}`);

  // ---- 3. buy
  step = "buy";
  const cart = [{ goodId: good.goodId, buyType }, ...(extra ? [{ goodId: extra.goodId, buyType }] : [])];
  const { result, deltas } = await buyGoods(A.game.conn, cart);
  const bought = deltas.flatMap((d) => d.items).find((i) => i.itemId === good.itemId);
  const spent = price(good) + (extra ? price(extra) : 0);
  check("1047 buy ok", result.ok && result.goodIds.includes(good.goodId), `goods ${result.goodIds} gold ${wallet0.gold} -> ${result.gold} cash ${wallet0.cash} -> ${result.cash} time ${result.time}`);
  check(`${useGold ? "gold" : "cash"} charged`, (useGold ? result.gold : result.cash) === budget - spent, `expected ${budget - spent}`);
  check("3334 carries itemId", !!bought, `${deltas.length} deltas: ${deltas.map((d) => d.items.map((i) => `${i.objectId}:${i.itemId}:e${i.equip}:c${i.count}`).join(",") + ` t${d.changeType} total ${d.inventoryTotal}`).join(" | ")}`);
  const [dbGold, dbCash] = sql(`select gold, cash from accounts where player_id=${pid}`)[0].map(Number);
  check("accounts gold/cash", dbGold === result.gold && dbCash === result.cash, `db gold ${dbGold} cash ${dbCash}`);
  const dbItem = sql(`select object_id, id, count, equip from player_items where owner_id=${pid} and id=${good.itemId}`);
  check("player_items row", dbItem.length === 1 && Number(dbItem[0][0]) === bought?.objectId, `${dbItem.map((r) => r.join(":")).join(",")}`);

  // ---- 4. delete the extra good (1055 -> 1059)
  if (extra) {
    step = "delete";
    const ex = deltas.flatMap((d) => d.items).find((i) => i.itemId === extra.itemId);
    if (ex) {
      const delAck = A.game.conn.waitFor(GameMetaOp.SHOP_DELETE_ITEM_ACK);
      A.game.conn.send(1055, new PacketWriter().writeD(ex.objectId));
      const del = parseDeleteItem(await delAck);
      const left = sql(`select count(*) from player_items where owner_id=${pid} and object_id=${ex.objectId}`)[0][0];
      check("1059 delete", del.ok && del.objectId === ex.objectId && left === "0", `code ${del.code} objId ${del.objectId} rows left ${left}`);
    }
  }

  // ---- 5. equip (6149 -> 6150). Target: the bought primary, else a basic primary from 2319 not equipped.
  step = "equip";
  const target = useGold && bought ? bought
    : am.inventory!.items.find((i) => cls(i.itemId) === 1 && i.itemId !== loadout0.equip[EquipSlot.Primary].itemId)!;
  if (!useGold) log("A", `equip target (fallback, basic from 2319): ${target.objectId}:${target.itemId}`);
  const err = await changeEquip(A.game.conn, equipRequestFromLoadout(loadout0, { [EquipSlot.Primary]: { itemId: target.itemId, objectId: target.objectId } }, A.pushes.charaInfo));
  check("6150", err === 0, `err ${err}`);
  await sleep(300);
  const eq1 = sqlObjects(`select * from player_equipments where owner_id=${pid}`)[0];
  check("player_equipments after 6149", Number(eq1.weapon_primary) === target.itemId, `weapon_primary=${eq1.weapon_primary} chara_red=${eq1.chara_red_side} chara_blue=${eq1.chara_blue_side}`);

  // ---- 6. relog: 3082 reflects the new primary (6149 itself pushes no 3082)
  step = "relog";
  A.game.close();
  await sleep(1500);
  const A2 = await enter("A", accA.token, false);
  check("3082 after relog", A2.pushes.loadout?.equip[EquipSlot.Primary].itemId === target.itemId,
    `primary ${A2.pushes.loadout?.equip[0].itemId} objId ${A2.pushes.loadout?.equip[0].objectId} (target objId ${target.objectId})`);

  // ---- 7. battle + RESPAWN with the itemId
  step = "battle";
  const accB = await account(userB);
  await sleep(1500);
  const B = await enter("B", accB.token, false);
  const roomA = new RoomClient(A2.game), roomB = new RoomClient(B.game);
  const room = await roomA.create({ name: `w1 meta ${suffix.slice(-4)}`, slots: 8, killTime: 0x60 });
  const bSlot = await roomB.join(room.roomId);
  if (bSlot % 2 === 0) throw new Error("B on the leader's team");
  const bReady = new Promise<void>((res) => { roomA.onChange = () => { if (roomA.slots[bSlot].state === WIRE_READY) res(); }; });
  roomB.ready();
  await bReady;
  roomA.onChange = null;
  const bStart = new Promise<void>((res) => { roomB.onStartGame = res; });
  await roomA.start();
  await bStart;
  await roomA.loadingStart();
  await roomB.loadingStart();
  const epA = await roomA.preStart();
  const epB = await roomB.preStart();
  const roster = [{ slot: epA.slot, name: "A", team: 0 as const }, { slot: epB.slot, name: "B", team: 1 as const }];
  const nets: PbBattleNet[] = [];
  for (const [rc, ep, p] of [[roomA, epA, A2], [roomB, epB, B]] as const) {
    const n = new PbBattleNet({ session: { uniqueRoomId: ep.uniqueRoomId, roomSeed: ep.roomSeed, slot: ep.slot, accountId: Number(p.login.playerId & 0xffn), signalTicket: ep.signalTicket }, roster, serverUrl: GW, room: rc });
    await n.connect();
    nets.push(n);
  }
  const battle = Promise.all([new Promise<void>((r) => { roomA.onBattleStart = r; }), new Promise<void>((r) => { roomB.onBattleStart = r; })]);
  roomA.startBattle();
  roomB.startBattle();
  await Promise.race([battle, sleep(12000).then(() => { throw new Error("STARTBATTLE timeout"); })]);
  log("A+B", "STARTBATTLE");
  step = "respawn";
  const flag = (roomA.room?.weaponsFlag ?? 0x1ff) & 0xf;
  const respAck = new Promise<ReturnType<typeof parseRespawnAck>>((res, rej) => {
    const t = setTimeout(() => rej(new Error("no 5138 for A")), 5000);
    const o = A2.game.conn.on((op, r) => {
      if (op !== GameMetaOp.BATTLE_RESPAWN_ACK) return;
      const a = parseRespawnAck(r);
      if (a.slot !== epA.slot) return;
      clearTimeout(t); o(); res(a);
    });
  });
  A2.game.conn.send(GameMetaOp.BATTLE_RESPAWN_REQ, buildRespawnBody(A2.pushes.loadout!.equip, flag, A2.pushes.loadout!.accessory));
  const ra = await respAck;
  check("RESPAWN 5138 primary", ra.weapons.primary === target.itemId, `slot ${ra.slot} weapons ${JSON.stringify(ra.weapons)}`);
  //: what the server does with a zero RESPAWN (B, default loadout, via RoomClient.respawn)
  const zb = new Promise<ReturnType<typeof parseRespawnAck>>((res) => {
    const o = B.game.conn.on((op, r) => { if (op === GameMetaOp.BATTLE_RESPAWN_ACK) { const a = parseRespawnAck(r); if (a.slot === epB.slot) { o(); res(a); } } });
  });
  await roomB.respawn();
  const zbAck = await Promise.race([zb, sleep(3000).then(() => null)]);
  const eqB = sqlObjects(`select weapon_primary, weapon_secondary, weapon_melee, weapon_explosive, weapon_special from player_equipments where owner_id=${B.login.playerId}`)[0];
  log("B", `§8 zero RESPAWN -> 5138 weapons ${JSON.stringify(zbAck?.weapons)} (DB ${JSON.stringify(eqB)})`);

  // ---- 8. DB confirms
  step = "db";
  const eq2 = sqlObjects(`select * from player_equipments where owner_id=${pid}`)[0];
  const item = sql(`select object_id, id, count, equip from player_items where owner_id=${pid} and id=${target.itemId}`);
  check("SELECT player_equipments", Number(eq2.weapon_primary) === target.itemId, `weapon_primary=${eq2.weapon_primary}; player_items ${item.map((r) => r.join(":")).join(",")}`);

  for (const n of nets) n.dispose();
  for (const rc of [roomA, roomB]) { await rc.leave().catch(() => {}); rc.dispose(); }
  A2.game.close();
  B.game.close();

  if (RECORD) {
    const out = fileURLToPath(new URL("./meta-vectors.json", import.meta.url));
    const db = {
      playerId: String(pid),
      account: sqlObjects(`select player_id, username, nickname, gold, cash, tags, rank, experience from accounts where player_id=${pid}`)[0],
      equipments: eq2,
      characters: sqlObjects(`select object_id, id, slot from player_characters where owner_id=${pid} order by slot`),
      items: sqlObjects(`select object_id, id, count, equip from player_items where owner_id=${pid} order by object_id`),
      bought: { currency: useGold ? "gold" : "cash", goodId: good.goodId, itemId: good.itemId, count: good.count, price: price(good), objectId: bought?.objectId ?? 0, extraGoodId: extra?.goodId ?? null, extraItemId: extra?.itemId ?? null, extraPrice: extra ? price(extra) : 0, failGoodId: 99 },
      equipTarget: target,
      wallet0,
    };
    writeFileSync(out, JSON.stringify({ recorded: new Date().toISOString(), gateway: GW, note: "hex = full S->C payload (opcode + body + 2 framing zeros)", db, vectors }, null, 1));
    log("rec", `${vectors.length} payloads -> ${out}`);
  }
  const failed = checks.filter((c) => !c.ok);
  if (failed.length) console.log(`\nRESULT: FAIL — ${failed.map((c) => c.name).join(", ")}`);
  else if (blocked.length) console.log(`\nRESULT: PASS ${checks.length} checks, BLOCKED: ${blocked.map((x) => x.name).join(", ")} (server-side, see log)`);
  else console.log(`\nRESULT: PASS — ${checks.length} checks`);
  process.exit(failed.length ? 1 : blocked.length ? 2 : 0);
}

main().catch((e) => {
  console.error("RESULT: FAIL —", e instanceof Error ? e.stack : e);
  process.exit(1);
});
