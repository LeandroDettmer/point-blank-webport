// Live E2E of a bought character: buy (6145 -> 3334 -> 6146) -> equip on the red side (6149 -> 6150 with the
// 6146 slot) -> relog (3082 equip[8] + 2453) -> battle RESPAWN (5138 chara). Runs the real MetaSession/PlayerStore.
//   node src/net/test/chara.live.ts [--gw ws://127.0.0.1:8090] [--api http://127.0.0.1:8090] [--item 601124]
// Needs Postgres and server running. Exit 0 = pass.
import { execFileSync } from "node:child_process";
import { AuthClient, gameTargetForServer, type LoginResult } from "../authClient.ts";
import { GameClient } from "../gameClient.ts";
import { RoomClient, WIRE_READY } from "../roomClient.ts";
import { PbBattleNet } from "../battle.ts";
import { fetchAuthMeta } from "../metaAuth.ts";
import { GameMetaOp, buildRespawnBody, collectEnterPushes, parseCreateChara, parseRespawnAck, type CreateCharaAck, type EnterPushes } from "../metaGame.ts";
import { MetaSession, Side } from "../../lobby/state/MetaSession.ts";
import { itemClass, ItemClass } from "../../lobby/state/itemInfo.ts";
import { setItemNameTable } from "../../lobby/state/itemNames.ts";
import { BuyType, EquipSlot, type ShopGood } from "../../lobby/types.ts";
import { readFileSync } from "node:fs";

const arg = (k: string, d: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const GW = arg("--gw", "ws://127.0.0.1:8090");
const API = arg("--api", "http://127.0.0.1:8090");
const WANT = Number(arg("--item", "601124")); // Rica_Zombie
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (who: string, msg: string) => console.log(`${((Date.now() - t0) / 1000).toFixed(2).padStart(6)}s [${who}] ${msg}`);
const checks: { name: string; ok: boolean }[] = [];
const check = (name: string, ok: boolean, detail: string) => { checks.push({ name, ok }); log(ok ? "PASS" : "FAIL", `${name}: ${detail}`); };

function sql(q: string): string[][] {
  const out = execFileSync("docker", ["exec", "pb-postgres-local", "psql", "-U", "postgres", "-d", "pb", "-At", "-F", "\t", "-c", q], { encoding: "utf8" });
  return out.split(/\r?\n/).filter(Boolean).map((l) => l.split("\t"));
}

async function account(username: string): Promise<Uint8Array> {
  const res = await fetch(`${API}/api/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password: "w1-chara-pw1" }) });
  const body = (await res.json()) as { token?: string; error?: string };
  if (res.status !== 201 || !body.token) throw new Error(`account-api register ${username}: ${res.status} ${body.error ?? ""}`);
  return Uint8Array.from(Buffer.from(body.token, "base64"));
}

interface Session { game: GameClient; login: LoginResult; pushes: EnterPushes; meta: MetaSession }

async function enter(who: string, token: Uint8Array): Promise<Session> {
  const auth = new AuthClient(GW);
  const mac = crypto.getRandomValues(new Uint8Array(6));
  mac[0] = (mac[0] & 0xfe) | 2;
  const login = await auth.connectAndLogin({ token, mac });
  if (!login.ok) throw new Error(`${who}: login ${login.errorName}`);
  const am = await fetchAuthMeta(auth.conn);
  const server = (await auth.getServers()).find((s) => s.index > 0)!;
  await auth.leave();
  const game = new GameClient(gameTargetForServer(server), GW);
  let pushes: Promise<EnterPushes> | null = null;
  const connect = game.conn.connect.bind(game.conn);
  game.conn.connect = async (...a) => { const i = await connect(...a); pushes = collectEnterPushes(game.conn).done; return i; };
  await game.enter(login.username, login.playerId, server.index);
  const p = await pushes!;
  await game.selectChannel(0);
  await game.enterLobby();
  const meta = new MetaSession();
  meta.player.dispatch({ type: "authMeta", userInfo: am.userInfo, inventory: am.inventory, wallet: null });
  meta.player.dispatch({ type: "enter", pushes: p });
  meta.attach(game.conn);
  log(who, `in lobby as ${login.username} pid ${login.playerId}`);
  return { game, login, pushes: p, meta };
}

async function main(): Promise<void> {
  setItemNameTable(JSON.parse(readFileSync(new URL("../../lobby/state/data/itemNames.json", import.meta.url), "utf8")));
  const suffix = `${Date.now() % 1e7}`;
  const tokA = await account(`w1c${suffix}`);
  const A = await enter("A", tokA);
  const pid = A.login.playerId;
  const w0 = A.pushes.wallet!;
  log("A", `2453 ${A.pushes.charaInfo?.charas.map((c) => `${c.slot}:${c.itemId}`).join(",")} 3082 chara ${A.pushes.loadout?.equip[8].itemId} slots ${A.pushes.loadout?.charaSlots}; gold ${w0.gold} cash ${w0.cash}`);

  // ---- 1. catalog, pick a red character good the account can pay
  await A.meta.loadShop();
  const goods = A.meta.shop.data?.goods ?? [];
  const owned = new Set(A.meta.player.items().map((i) => i.itemId));
  const payable = (g: ShopGood) => (g.priceGold > 0 && g.priceGold <= w0.gold) || (g.priceCash > 0 && g.priceCash <= w0.cash);
  const red = goods.filter((g) => itemClass(g.itemId) === ItemClass.Character && String(g.itemId).startsWith("601") && !owned.has(g.itemId) && payable(g));
  const good = red.find((g) => g.itemId === WANT) ?? red.sort((a, b) => a.priceGold - b.priceGold)[0];
  if (!good) throw new Error(`no payable red character good (${goods.length} goods)`);
  const buyType = good.priceGold > 0 && good.priceGold <= w0.gold ? BuyType.Gold : BuyType.Cash;
  log("A", `buying good ${good.goodId} -> chara ${good.itemId} (${buyType === BuyType.Gold ? `${good.priceGold} gold` : `${good.priceCash} cash`}, count ${good.count})`);

  // ---- 2. buy: MetaSession routes a new character to 6145
  let ack: CreateCharaAck | null = null;
  const offAck = A.game.conn.on((op, r) => { if (op === GameMetaOp.CHAR_CREATE_CHARA_ACK) ack = parseCreateChara(r); });
  let sent1045 = false;
  const offSend = ((send) => { A.game.conn.send = (op, b) => { if (op === GameMetaOp.SHOP_GOODS_BUY_REQ) sent1045 = true; return send(op, b); }; return () => { A.game.conn.send = send; }; })(A.game.conn.send.bind(A.game.conn));
  const res = await A.meta.buy([{ goodId: good.goodId, buyType }]);
  offAck(); offSend();
  const a = ack as CreateCharaAck | null;
  check("6145 used (no 1045)", !sent1045 && !!a, `6146 err ${a?.error} kind ${a?.kind} slot ${a?.slot} item ${a?.itemId}:${a?.objectId} gold ${res.gold} cash ${res.cash}`);
  const slot = A.meta.player.charaSlotOf(good.itemId);
  check("PlayerStore slot from 6146", slot !== null && slot === a?.slot, `charaInfo ${A.meta.player.state.charaInfo?.charas.map((c) => `${c.slot}:${c.itemId}`).join(",")}`);
  await sleep(300);
  const dbc = sql(`select slot, object_id from player_characters where owner_id=${pid} and id=${good.itemId}`);
  // Server bug, not the client: CreatePlayerCharacter INSERTs object_id = the player_items objectId, a different sequence,
  // so it collides with another account's player_characters row (23505). The character then lives in memory only and
  // USER_ENTER recreates it from the inventory at the same slot (Characters.Count), which is what the checks below use.
  if (dbc.length === 1 && Number(dbc[0][0]) === slot) log("A", `player_characters row ${dbc[0].join(":")}`);
  else log("SERVER", `player_characters has no row for ${good.itemId} (INSERT object_id=${a?.objectId} collides: ${sql(`select owner_id, id from player_characters where object_id=${a?.objectId ?? 0}`).map((r) => r.join(":")).join(",") || "?"})`);
  const item = A.meta.player.items().find((i) => i.itemId === good.itemId);
  check("3334 item in inventory", !!item, `${item?.objectId}:${item?.itemId} equip ${item?.equip} count ${item?.count}`);

  // ---- 3. equip on the red side (Durable -> 1050 first, then 6149 with the new slot)
  await A.meta.equip(item!, Side.Red);
  await sleep(300);
  const eq = sql(`select chara_red_side, chara_blue_side from player_equipments where owner_id=${pid}`)[0];
  check("6149 -> chara_red_side", Number(eq[0]) === good.itemId, `red ${eq[0]} blue ${eq[1]}; loadout ${A.meta.player.state.loadout?.equip[8].itemId} slots ${A.meta.player.state.loadout?.charaSlots} (${A.meta.player.state.loadoutSource})`);
  check("teamCharas().red", A.meta.player.teamCharas().red === good.itemId, JSON.stringify(A.meta.player.teamCharas()));

  // ---- 4. relog: 3082 shows it
  A.meta.detach();
  A.game.close();
  await sleep(1500);
  const A2 = await enter("A", tokA);
  const lo = A2.pushes.loadout!;
  check("3082 after relog", lo.equip[EquipSlot.Chara].itemId === good.itemId && lo.charaSlots[0] === slot, `equip[8] ${lo.equip[8].itemId} slots ${lo.charaSlots}; 2453 ${A2.pushes.charaInfo?.charas.map((c) => `${c.slot}:${c.itemId}`).join(",")}`);

  // ---- 5. battle: RESPAWN with the character
  const tokB = await account(`w1d${suffix}`);
  await sleep(1500);
  const B = await enter("B", tokB);
  const roomA = new RoomClient(A2.game), roomB = new RoomClient(B.game);
  const room = await roomA.create({ name: `w1 chara ${suffix.slice(-4)}`, slots: 8, killTime: 0x60 });
  const bSlot = await roomB.join(room.roomId);
  const bReady = new Promise<void>((r) => { roomA.onChange = () => { if (roomA.slots[bSlot].state === WIRE_READY) r(); }; });
  roomB.ready();
  await bReady;
  roomA.onChange = null;
  const bStart = new Promise<void>((r) => { roomB.onStartGame = r; });
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
  const flag = (roomA.room?.weaponsFlag ?? 0x1ff) & 0xf;
  const respAck = new Promise<ReturnType<typeof parseRespawnAck>>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("no 5138 for A")), 5000);
    const o = A2.game.conn.on((op, r) => {
      if (op !== GameMetaOp.BATTLE_RESPAWN_ACK) return;
      const x = parseRespawnAck(r);
      if (x.slot !== epA.slot) return;
      clearTimeout(t); o(); resolve(x);
    });
  });
  A2.game.conn.send(GameMetaOp.BATTLE_RESPAWN_REQ, buildRespawnBody(A2.meta.player.equipPairs(), flag, lo.accessory));
  const ra = await respAck;
  check("RESPAWN 5138 chara", ra.chara === good.itemId, `slot ${ra.slot} chara ${ra.chara} primary ${ra.weapons.primary}`);

  for (const n of nets) n.dispose();
  for (const rc of [roomA, roomB]) { await rc.leave().catch(() => {}); rc.dispose(); }
  A2.game.close();
  B.game.close();
  const failed = checks.filter((c) => !c.ok);
  console.log(failed.length ? `\nRESULT: FAIL — ${failed.map((c) => c.name).join(", ")}` : `\nRESULT: PASS — ${checks.length} checks`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error("RESULT: FAIL —", e instanceof Error ? e.stack : e);
  process.exit(1);
});
