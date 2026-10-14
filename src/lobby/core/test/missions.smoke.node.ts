// Node-only smoke test of the Perfil / Missão tab: the mission client (net/missionClient.ts: 2355 / 2359 / 2361 pushes, 2360 / 2364 /
// 2366 requests), the card data (missionData.ts, missions.ts notices /
// prize / stepPrize), rules / task texts (missionLogic.ts) and the controller flow (INFO button -> Missão tab
// -> pick a set -> Comprar -> confirm -> 2364 -> state; card click -> 2360; Excluir -> confirm -> 2366). No browser, no server. Run:
//   node --experimental-transform-types --no-warnings src/lobby/core/test/missions.smoke.node.ts
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { fileURLToPath } from "node:url";

// the controller pulls the whole game (an extensionless import in game/reportPopup.ts): see resolve-ts.mjs
register("./resolve-ts.mjs", import.meta.url);

const PUBLIC = fileURLToPath(new URL("../../../../public", import.meta.url));
const g = globalThis as Record<string, unknown>;
g.window = globalThis;
g.location = { search: "", hash: "", hostname: "127.0.0.1", protocol: "http:", host: "127.0.0.1:8000" };
const store = new Map<string, string>();
g.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } };
const realFetch = globalThis.fetch;
g.fetch = (u: string | URL) => {
  const s = String(u);
  if (s.startsWith("/")) {
    try { return Promise.resolve(new Response(readFileSync(PUBLIC + s.split("?")[0]), { status: 200 })); }
    catch { return Promise.resolve(new Response("", { status: 404 })); }
  }
  return realFetch(u);
};

const { PacketReader, PacketWriter } = await import("../../../net/packet.ts");
const { MissionClient, MissionOp, MissionErr, questingFrom, emptyMissionState, cardDone, taskDone } = await import("../../../net/missionClient.ts");
const { Lobby2017 } = await import("../controller.ts");
const { EMPTY_CHROME } = await import("../model.ts");
const { notices, prize, stepPrize } = await import("../missions.ts");
const { loadIconIndex, iconOf } = await import("../../screens/icons.ts");
const { MISSION_SETS } = await import("../missionData.ts");
const L = await import("../missionLogic.ts");
const { hasHangul } = await import("../../screens/strings.ts");
const { setItemNameTable, itemName } = await import("../../state/itemNames.ts");

setItemNameTable(JSON.parse(readFileSync(new URL("../../state/data/itemNames.json", import.meta.url), "utf8")));
let fails = 0;
const check = (name: string, ok: boolean, detail = "") => { if (!ok) fails++; console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`); };

// ---- a fake Game connection: records requests, answers like server socialHandlers.ts
type Reader = InstanceType<typeof PacketReader>;
type Listener = (op: number, r: Reader) => void;
class FakeConn {
  listeners = new Set<Listener>();
  sent: { op: number; body: Uint8Array }[] = [];
  waiters: { op: number; resolve: (r: Reader) => void }[] = [];
  answers = new Map<number, Uint8Array[]>();
  on(fn: Listener) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  waitFor(op: number) { return new Promise<Reader>((resolve) => this.waiters.push({ op, resolve })); }
  send(op: number, body?: InstanceType<typeof PacketWriter> | Uint8Array) {
    this.sent.push({ op, body: body instanceof Uint8Array ? body : body ? body.toBytes() : new Uint8Array() });
    for (const b of this.answers.get(op) ?? []) queueMicrotask(() => this.push(b));
  }
  push(packet: Uint8Array) {
    const op = packet[0] | (packet[1] << 8);
    for (const f of [...this.listeners]) f(op, new PacketReader(packet, 2));
    const w = this.waiters.filter((x) => x.op === op);
    this.waiters = this.waiters.filter((x) => x.op !== op);
    for (const x of w) x.resolve(new PacketReader(packet, 2));
  }
}

/** auth/metaPackets.ts questingInfo: C active, 4 C card, 4 x 10 H flags, 4 C set */
interface Slot { set: number; card?: number; flags?: number[] }
function questing(active: number, slots: Slot[]): Uint8Array {
  const w = new PacketWriter(89).writeC(active);
  for (let i = 0; i < 4; i++) w.writeC(slots[i]?.card ?? 0);
  for (let i = 0; i < 4; i++) for (let c = 0; c < 10; c++) w.writeH(slots[i]?.flags?.[c] ?? 0);
  for (let i = 0; i < 4; i++) w.writeC(slots[i]?.set ?? 0);
  return w.toBytes();
}
const info2355 = (active: number, slots: Slot[]) => new PacketWriter(96).writeH(2355).writeC(active).writeB(questing(active, slots)).toBytes();
const change2359 = (task: number, done: boolean, n: number) => new PacketWriter(4).writeH(2359).writeC(task + (done ? 240 : 0)).writeC(n).toBytes();
const prize2361 = (flag: number, type: number, gold: number) => {
  const w = new PacketWriter(40).writeH(2361).writeD(flag).writeC(type);
  if (flag & 1) w.writeD(5000).writeD(0).writeD(gold).writeD(3).writeD(1).writeD(0).writeD(1);
  return w.toBytes();
};
const buy2365 = (err: number, gold = 0, active = 0, slots: Slot[] = [], cash = 0) => {
  const w = new PacketWriter(110).writeH(2365).writeD(err);
  if (err === 0) w.writeD(gold).writeC(active).writeB(questing(active, slots)).writeD(cash);
  return w.toBytes();
};
const del2367 = (err: number, active = 0, slots: Slot[] = []) => {
  const w = new PacketWriter(96).writeH(2367).writeD(err);
  if (err === 0) w.writeB(questing(active, slots));
  return w.toBytes();
};

// ---- client: parser 2355, progress 2359, prize 2361, requests
{
  const block = questing(1, [{ set: 5, card: 2, flags: [0xffff, 0xffff, 0x00f0] }, { set: 7, card: 0 }, { set: 0, card: 0 }, { set: 13, card: 4 }]);
  check("questing block is 89 bytes", block.length === 89);
  const st = questingFrom(block);
  check("2317 / 2355 block: active slot, sets, cards, flags", st.known && st.active === 1 && st.slots.map((s) => s.setId).join() === "5,7,0,13" && st.slots[0].card === 2 && st.slots[3].card === 4 && st.slots[0].flags[2] === 0xf0);
  check("flags: card 0 done, card 2 task 1 done, task 0 not", cardDone(st.slots[0], 0) && taskDone(st.slots[0], 2, 1) && !taskDone(st.slots[0], 2, 0) && !cardDone(st.slots[0], 2));

  const conn = new FakeConn();
  const mc = new MissionClient(conn);
  let ticks = 0;
  mc.subscribe(() => ticks++);
  check("state starts unknown", !mc.state.known && mc.state.slots.every((s) => !s.setId));
  mc.seed(block);
  check("seed from the Auth 2317 block", mc.state.known && mc.state.active === 1 && ticks === 1);
  conn.push(info2355(0, [{ set: 5, card: 2, flags: [0xffff, 0xffff, 0x00f0] }, { set: 7 }]));
  check("2355 push replaces the state (C active + block)", mc.state.active === 0 && mc.state.slots[1].setId === 7 && mc.state.slots[3].setId === 0 && ticks === 2);
  mc.seed(block);
  check("seed after a 2355 is ignored", mc.state.active === 0);

  conn.push(change2359(0, false, 1));
  check("2359 (task 0, 1): count of the active card's task", mc.state.counts[0].get(2 * 4 + 0) === 1 && !taskDone(mc.state.slots[0], 2, 0));
  conn.push(change2359(0, true, 3));
  check("2359 (task 0 + 240, 3): task complete flag set", taskDone(mc.state.slots[0], 2, 0) && mc.state.slots[0].flags[2] === 0x00ff && mc.state.counts[0].get(8) === 3);

  mc.setActive(1, 4);
  const s2360 = conn.sent.at(-1)!;
  check("2360 [slot 1, card 4, H flags of card 4] (no ack)", s2360.op === MissionOp.ACTIVE_REQ && s2360.body.join() === "1,4,0,0" && mc.state.active === 1 && mc.state.slots[1].card === 4);
  mc.setActive(0, 0);
  check("2360 of a finished card carries 0xffff", conn.sent.at(-1)!.body.join() === "0,0,255,255");

  conn.push(prize2361(1, 1, 7777));
  check("2361 (1, 1): card prize parsed (gold, badges) + the finished set / card", mc.prize?.type === 1 && mc.prize.gold === 7777 && mc.prize.ribbon === 3 && mc.prize.master === 1 && mc.state.slots[0].setId === 5 && mc.prize.setId === 5 && mc.prize.card === 0);
  mc.prize = null;
  conn.push(prize2361(273, 4, 9000));
  check("2361 (273, 4): set done, slot emptied, active = first owned", (mc.prize as { type: number } | null)?.type === 4 && mc.state.slots[0].setId === 0 && mc.state.active === 1);

  conn.answers.set(MissionOp.BUY_REQ, [buy2365(0, 1234, 2, [{ set: 0 }, { set: 7 }, { set: 6 }], 55)]);
  const bought = await mc.buy(6);
  check("buy(6): 2364 [6, 0], 2365 ok applies block and wallet", bought.ok && bought.gold === 1234 && bought.cash === 55 && conn.sent.at(-1)!.op === 2364 && conn.sent.at(-1)!.body.join() === "6,0" && mc.state.slots[2].setId === 6 && mc.state.active === 2);
  conn.answers.set(MissionOp.BUY_REQ, [buy2365(MissionErr.NO_POINT)]);
  const poor = await mc.buy(9);
  check("buy refused: error code, state kept", !poor.ok && poor.err === MissionErr.NO_POINT && mc.state.slots[2].setId === 6);
  conn.answers.set(MissionOp.DELETE_REQ, [del2367(0, 1, [{ set: 0 }, { set: 7 }])]);
  const del = await mc.remove(2);
  check("remove(2): 2366 [2], 2367 block applied", del.ok && conn.sent.at(-1)!.op === 2366 && conn.sent.at(-1)!.body.join() === "2" && mc.state.slots[2].setId === 0);
  conn.answers.set(MissionOp.DELETE_REQ, [del2367(MissionErr.DELETE_NETWORK)]);
  check("remove refused: error code", (await mc.remove(1)).err === MissionErr.DELETE_NETWORK && mc.state.slots[1].setId === 7);
  mc.dispose();
  check("dispose detaches the listener", conn.listeners.size === 0);
}

// ---- data + rules + texts (pt-BR string table, as the lobby loads it)
await (await import("../../ui/i18n.ts")).loadStrings();
{
  const ids = MISSION_SETS.map((s) => s.id).join();
  check("16 card sets (CardSetId 1-3, 5-17)", ids === "1,2,3,5,6,7,8,9,10,11,12,13,14,15,16,17");
  check("each set: 10 cards x 4 tasks, a card row template, Quest.pef price", MISSION_SETS.every((s) => s.cards.length === 10 && s.cards.every((c) => c.tasks.length === 4) && /^ButtonImageSet_Item_Card\d+_hs$|^Event_Mission_Card$/.test(s.tpl)) && L.missionSet(5)!.price === 5000 && L.missionSet(12)!.price === 14000);
  check("set names from the Cross Quest_Brazil CardSetName (missionData.ts)", L.setName(L.missionSet(5)!) === "Missão de Assalto" && L.setName(L.missionSet(17)!) === "Missão: Sobreviventes - Nível 2" && L.setName(L.missionSet(13)!) === "Cartas de Missão: Dezembro");
  check("questType 1 exp x10: Infiltration cards sum to TotalExp 2050", L.missionSet(7)!.questType === 1 && L.missionSet(7)!.cards.reduce((a, c) => a + c.exp, 0) === 2050);
  // PBCross strings (2017/3.123 in parentheses): STR_HEADER_DO_WIN "Vença uma partida!" ("Vencer!"), WEAPON_ACCM_ETC13 "" ("(Cumulativa) "),
  // WEAPON_ACCM_ETC6 "Usar e" ("Usar e "), count line ETC9 / ETC12 " %d/%d vezes" (" %d/%dvezes")
  check("action table: 56 STR_HEADER keys (exe 0x800460), KILL = Conseguir Kill", L.ACTION_KEYS.length === 56 && L.actionName(15) === "Conseguir Kill" && L.actionName(13) === "Vença uma partida!" && L.actionName(55) === "Derrote os Humanos.");
  const nameOf = (id: number) => itemName(id).name;
  const assault = L.missionSet(5)!.cards[0].tasks;
  const t0 = L.taskText(assault[0], 0, { nameOf });
  check("Weapon_Accm text: (Rifle) Conseguir Kill / 0/1 vezes", t0 === "(Rifle)  Conseguir Kill\n 0/1 vezes", JSON.stringify(t0));
  const kwc = L.taskText(assault[1], 1, { nameOf });
  check("class kill (type 40): 'Usar e' + Derrotar inimigo portando arma especificada", kwc.startsWith("(Rifle) Usar e Derrotar inimigo portando arma especificada") && kwc.endsWith(" 1/1 vezes"), JSON.stringify(kwc));
  const cont = L.taskText(L.missionSet(1)!.cards[1].tasks[0], 0, { nameOf });
  check("Weapon_Cont text (reqType 3): (Em 1 Round) ... Conseguir Kill 0/2", cont === "(Em 1 Round) Conseguir Kill\n 0/2 vezes", JSON.stringify(cont));
  const team = L.taskText([1, 13, 0, 1, 0, 0], 0, { nameOf });
  check("Accm_Team text (reqType 1): (Em 1 Round) Vença uma partida!", team === "(Em 1 Round) Vença uma partida!\n 0/1 vezes", JSON.stringify(team));
  const grenade = L.taskText([2, 43, 0, 3, 7, 1], 0, { nameOf });
  check("weapon number -> the weapon's name, not the class", grenade.startsWith("(") && !grenade.includes(`(${L.weaponClassName(7)})`) && !grenade.includes("Unknown"), JSON.stringify(grenade));

  // every task of every card: a text with the action, no placeholder, no Hangul / template leftovers
  const bad: string[] = [];
  for (const s of MISSION_SETS) s.cards.forEach((c, ci) => c.tasks.forEach((t, ti) => {
    const txt = L.taskText(t, 0, { nameOf });
    if (!L.actionName(t[1]) || !txt.includes(L.actionName(t[1])) || /%[ds]|Non String|Unknown|DESCONHECIDO/.test(txt) || hasHangul(txt) || !/\d+\/\d+ vezes$/.test(txt)) bad.push(`${s.id}.${ci}.${ti}:${JSON.stringify(txt)}`);
  }));
  check("640 task texts: action named, weapons named, count line, no leftovers", bad.length === 0, bad.slice(0, 4).join(" "));
  const prizes: string[] = [];
  for (const s of MISSION_SETS) for (const c of s.cards) if (c.badge && (L.badgeType(c.badge) < 0 || !L.badgeName(L.badgeType(c.badge)))) prizes.push(`${s.id}:${c.badge}`);
  check("card badges 1-116 map to Broche / Insígnia / Medalha (exe 0x7e1980)", prizes.length === 0 && L.badgeType(1) === 0 && L.badgeType(51) === 1 && L.badgeType(101) === 2 && L.badgeType(0) === -1, prizes.join(" "));

  // limit 3: three bought sets block the 4th; the event set does not count
  const st = (sets: number[]) => questingFrom(questing(0, sets.map((set) => ({ set }))));
  check("limit: 3 bought sets -> 'limit', the possible count reads 3 / 3", L.buyBlock(st([5, 6, 7]), 8, 50) === "limit" && L.possibleText(st([5, 6, 7])) === "3 / 3");
  check("limit: event + 2 bought -> can buy a 3rd", L.buyBlock(st([13, 5, 6]), 8, 50) === null && L.boughtCount(st([13, 5, 6])) === 2);
  check("duplicate / free / rank blocks (exe 0x955630: Commissioned rank 5, Company 17, Field 31)", L.buyBlock(st([5]), 5, 50) === "duplicate" && L.buyBlock(st([]), 1, 50) === "free" && L.buyBlock(st([]), 13, 50) === "free"
    && L.buyBlock(st([]), 10, 4) === "rank" && L.buyBlock(st([]), 10, 5) === null && L.buyBlock(st([]), 11, 16) === "rank" && L.buyBlock(st([]), 12, 30) === "rank" && !!L.rankBlockText(L.rankBlock(12, 1)!));
  const s5 = st([5]).slots[0];
  check("card alpha (0x9552b0): owned open 165, not owned 51; tutorial opens card by card", L.cardAlpha(L.missionSet(5)!, s5, 3) === 165 && L.cardAlpha(L.missionSet(6)!, s5, 0) === 51
    && L.cardAlpha(L.missionSet(1)!, st([1]).slots[0], 0) === 165 && L.cardAlpha(L.missionSet(1)!, st([1]).slots[0], 1) === 51);
}

// ---- controller: INFO button -> profile -> Missão tab -> set -> Comprar -> 2364; card -> 2360; Excluir -> 2366
{
  const conn = new FakeConn();
  const ctl = new Lobby2017({
    serverUrl: "", username: "tester", token: new Uint8Array(),
    render: () => {}, onBattle() {}, onExit() {}, onLocalPlay() {},
  });
  const c = ctl as unknown as Record<string, unknown>;
  const modal = () => (ctl as unknown as { modal(): string[] | null }).modal();
  let wallet = { gold: 9000, cash: 10, tags: 0 };
  c.session = {
    notifyScreen() {}, shop: {}, lobby: new Proxy({}, { get: () => () => [] }),
    player: { state: { get wallet() { return wallet; } }, dispatch(e: { type: string; wallet: typeof wallet }) { if (e.type === "wallet") wallet = e.wallet; return []; } },
  };
  c.stopPolling = () => {};
  (ctl as unknown as { chrome(): unknown }).chrome = () => ({ ...EMPTY_CHROME, page: "profile", rank: 10 });
  const { TitleClient } = await import("../../../net/titleClient.ts");
  ctl.titles = new TitleClient(conn);
  const mc = (ctl.missions = new MissionClient(conn));
  mc.subscribe(() => (c.onMissionPush as () => void).call(ctl));
  mc.seed(questing(0, [{ set: 5, card: 0 }]));
  ctl.page = "lobby";
  ctl.loadingRooms = false; // the room list is in: no loading curtain over the lobby

  ctl.click("myinfo", "i3UIButton");
  check("INFO button opens the profile page on the Título tab", (ctl.page as string) === "profile" && ctl.profileTab === "designation");
  ctl.click("profile", "i3UIButton_MIM");
  check("Missão tab: the active set (5) picked", ctl.profileTab === "mission" && ctl.mission.sel === 5);

  ctl.click("hit", "mcard:3");
  check("card click sends 2360 [0, 3, flags]", conn.sent.at(-1)?.op === 2360 && conn.sent.at(-1)!.body.join() === "0,3,0,0" && mc.state.slots[0].card === 3);

  ctl.listSelect("msets", L.tabSets(mc.state, 0).indexOf(9));
  check("list pick of a set not owned: no request", ctl.mission.sel === 9 && conn.sent.at(-1)?.op === 2360);
  ctl.click("missioncard", "i3UIButton4_MIM");
  check("Comprar opens the BuyNow popup", ctl.mission.popup?.kind === "buy" && modal()?.join() === "mbuy");
  conn.answers.set(2364, [buy2365(0, 3200, 1, [{ set: 5 }, { set: 9 }], 10)]);
  ctl.click("mbuy", "i3UIButtonComposed310");
  await new Promise((r) => setTimeout(r, 10));
  check("confirm sends 2364 [9, 0]; the set lands in slot 1, wallet updated, success message", conn.sent.at(-1)?.op === 2364 && conn.sent.at(-1)!.body.join() === "9,0" && mc.state.slots[1].setId === 9 && wallet.gold === 3200 && ctl.msg?.text === L.MS.buyOk && !ctl.mission.popup && !ctl.mission.busy);
  ctl.click("popup", "btnOK");

  ctl.click("missioncard", "i3UIButton4_MIM");
  check("Comprar on an owned set: duplicate message, no popup", ctl.msg?.text === L.MS.duplicate && !ctl.mission.popup);
  ctl.click("popup", "btnOK");
  ctl.listSelect("msets", L.tabSets(mc.state, 0).indexOf(12));
  ctl.click("missioncard", "i3UIButton4_MIM");
  check("Field (12) under rank 31: the rank popup text", ctl.msg?.text === L.rankBlockText("STR_POPUP_MESSAGE_QEUST_ERROR_FIELD") && !ctl.mission.popup);
  ctl.click("popup", "btnOK");

  ctl.listSelect("msets", L.tabSets(mc.state, 0).indexOf(5));
  check("picking another owned set makes it active (2360 [0, card])", conn.sent.at(-1)?.op === 2360 && conn.sent.at(-1)!.body[0] === 0 && mc.state.active === 0);
  ctl.click("missioncard", "i3UIButton3_MIM");
  check("Info+ opens the Detail popup", ctl.mission.popup?.kind === "detail" && modal()?.join() === "mdetail");
  ctl.click("mdetail", "i3UIButtonComposed3");
  check("Detail Next of a set without items: nothing changes (buttons disabled)", ctl.mission.popup?.setId === 5 && !ctl.mission.popup?.item);
  ctl.mission = { ...ctl.mission, popup: { kind: "detail", setId: 13 } };
  ctl.click("mdetail", "i3UIButtonComposed3");
  const evNext = ctl.mission.popup?.item;
  ctl.click("mdetail", "i3UIButtonComposed3");
  const evWrap = ctl.mission.popup?.item;
  ctl.click("mdetail", "i3UIButtonComposed30");
  check("Detail Next / Prev step the set's items and wrap (event set: 0 -> 1 -> 0 -> 1), same set",
    evNext === 1 && evWrap === 0 && ctl.mission.popup?.item === 1 && ctl.mission.popup?.setId === 13);
  ctl.click("mdetail", "Button_Close");
  check("Detail Close", !ctl.mission.popup);

  ctl.click("missioncard", "i3UIButton5_MIM");
  check("Excluir asks first", ctl.msg?.text === L.MS.deleteAsk);
  conn.answers.set(2366, [del2367(0, 1, [{ set: 0 }, { set: 9 }])]);
  ctl.click("popup", "btnOK");
  await new Promise((r) => setTimeout(r, 10));
  check("OK sends 2366 [0]; slot 0 empty, delete message", conn.sent.at(-1)?.op === 2366 && conn.sent.at(-1)!.body.join() === "0" && mc.state.slots[0].setId === 0 && ctl.msg?.text === L.MS.deleteOk);
  ctl.click("popup", "btnOK");

  conn.push(prize2361(1, 1, 4321));
  check("2361 prize updates the wallet's gold", wallet.gold === 4321 && mc.prize === null);
  const done = L.completeInfo({ type: 1, setId: 9, card: 0 })!;
  check("2361 opens the Complete popup (card prize: exp / gold lines, Medalha of badge 103)", modal()?.join() === "mdone" && done.exp === `+Exp : ${L.missionSet(9)!.cards[0].exp}` && done.badges.join() === "false,false,true,false");
  ctl.click("profile", "i3UIButton0_MID");
  check("the Complete popup is modal", ctl.profileTab === "mission");
  ctl.click("mdone", "i3UIButtonOK");
  check("OK closes it", !ctl.missionDone && modal() == null);
  const whole = L.completeInfo({ type: 4, setId: 14, card: 9 })!;
  check("set finished (273, 4): set bonus added, Ordem Azul only with BonusBadgeMaster, set items", whole.items.join() === "1104003071" && !whole.badges[3] && L.completeInfo({ type: 4, setId: 5, card: 9 })!.badges[3] === true);
  ctl.click("profile", "i3UIButton0_MID");
  check("Título tab back", ctl.profileTab === "designation");
  mc.dispose();
}

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
