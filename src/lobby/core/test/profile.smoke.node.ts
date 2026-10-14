// Node-only smoke test of the Perfil / Títulos phase: the title client (net/titleClient.ts: 2383 / 2363 pushes, 2376-2381
// requests), the title rules (titleLogic.ts), the confirm button mode (profile.ts) and the controller flow (INFO button -> page -> pick -> confirm -> popup -> request
// -> state). No browser, no server. Run:
//   node --experimental-transform-types --no-warnings src/lobby/core/test/profile.smoke.node.ts
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
const { TitleClient, TitleOp } = await import("../../../net/titleClient.ts");
const { Lobby2017 } = await import("../controller.ts");
const { EMPTY_CHROME } = await import("../model.ts");
const { confirmMode } = await import("../profile.ts");
const { TITLES, TREE_NODES, EFFECTS } = await import("../titleData.ts");
const L = await import("../titleLogic.ts");
const { hasHangul } = await import("../../screens/strings.ts");
const { setItemNameTable, itemName } = await import("../../state/itemNames.ts");

setItemNameTable(JSON.parse(readFileSync(new URL("../../state/data/itemNames.json", import.meta.url), "utf8")));
let fails = 0;
const check = (name: string, ok: boolean, detail = "") => { if (!ok) fails++; console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`); };

// ---- a fake Game connection: records requests, answers like server profileHandlers.ts, pushes like handleLobbyEnter
type Listener = (op: number, r: InstanceType<typeof PacketReader>) => void;
class FakeConn {
  listeners = new Set<Listener>();
  sent: { op: number; body: Uint8Array }[] = [];
  waiters: { op: number; resolve: (r: InstanceType<typeof PacketReader>) => void }[] = [];
  /** what the server would answer to the next request of an opcode */
  answers = new Map<number, Uint8Array[]>();
  on(fn: Listener) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  waitFor(op: number) { return new Promise<InstanceType<typeof PacketReader>>((resolve) => this.waiters.push({ op, resolve })); }
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
const info = (flags: bigint, e: [number, number, number], slots: number) => new PacketWriter(32).writeH(2383).writeD(1).writeQ(flags).writeC(e[0]).writeC(e[1]).writeC(e[2]).writeD(slots).toBytes();
const medals = (r: number, e: number, m: number, mm: number) => new PacketWriter(32).writeH(2363).writeQ(1n).writeD(r).writeD(e).writeD(m).writeD(mm).toBytes();
const ack = (op: number, ...ds: number[]) => { const w = new PacketWriter(16).writeH(op); for (const d of ds) w.writeD(d); return w.toBytes(); };

// ---- title client
{
  const conn = new FakeConn();
  const tc = new TitleClient(conn);
  let ticks = 0;
  tc.subscribe(() => ticks++);
  check("state starts unknown with 1 slot", !tc.state.known && tc.state.slots === 1 && tc.state.flags === 0n);
  conn.push(medals(3, 2, 1, 0));
  conn.push(info((1n << 1n) | (1n << 2n), [2, 0, 0], 2));
  check("2363 + 2383 push fill the state", tc.state.known && tc.state.ribbon === 3 && tc.state.ensign === 2 && tc.state.medal === 1 && tc.state.flags === 6n && tc.state.equiped.join() === "2,0,0" && tc.state.slots === 2 && ticks === 2);

  conn.answers.set(TitleOp.CHANGE_REQ, [ack(2377, 0, 3)]);
  const got = await tc.change(3);
  check("change(3): request 2376 [3], ack applies the flag and the slot count", got.ok && conn.sent.at(-1)!.op === 2376 && conn.sent.at(-1)!.body.join() === "3" && L.hasTitle(tc.state, 3) && tc.state.slots === 3);
  conn.answers.set(TitleOp.CHANGE_REQ, [ack(2377, 0x80001083, 3)]);
  const refused = await tc.change(4);
  check("change(4) refused: error code, no flag", !refused.ok && refused.err === 0x80001083 && !L.hasTitle(tc.state, 4));

  conn.answers.set(TitleOp.EQUIP_REQ, [new PacketWriter(8).writeH(2379).writeD(0).writeC(1).writeC(3).toBytes()]);
  const eq = await tc.equip(1, 3);
  check("equip(1, 3): request 2378 [1, 3], slot 1 filled", eq.ok && conn.sent.at(-1)!.body.join() === "1,3" && tc.state.equiped.join() === "2,3,0");
  conn.answers.set(TitleOp.EQUIP_REQ, [new PacketWriter(8).writeH(2379).writeD(0x80000000).writeC(0xff).writeC(0xff).toBytes()]);
  check("equip refused: state kept", !(await tc.equip(2, 1)).ok && tc.state.equiped.join() === "2,3,0");
  conn.answers.set(TitleOp.RELEASE_REQ, [ack(2381, 0)]);
  const rel = await tc.release(1, 3);
  check("release(1, 3): request 2380, slot 1 empty", rel.ok && conn.sent.at(-1)!.op === 2380 && tc.state.equiped.join() === "2,0,0");
  tc.dispose();
  check("dispose detaches the listener", conn.listeners.size === 0);
}

// ---- rules + texts (pt-BR string table, as the lobby loads it)
await (await import("../../ui/i18n.ts")).loadStrings();
{
  const base = { ...L.emptyTitleState(), known: true };
  const d1 = L.titleDef(1)!, d2 = L.titleDef(2)!;
  check("title 1 needs 1 ribbon and rank 1", L.getBlock(base, 1, d1) === "badges" && L.getBlock({ ...base, ribbon: 1 }, 0, d1) === "rank" && L.getBlock({ ...base, ribbon: 1 }, 1, d1) === null);
  check("title 2 needs title 1, 2 ribbons, rank 2", L.getBlock({ ...base, ribbon: 2 }, 2, d2) === "required" && L.getBlock({ ...base, ribbon: 2, flags: 2n }, 2, d2) === null && L.getBlock({ ...base, flags: 4n }, 9, d2) === "owned");
  check("names come from NAME_NO<set-1>, not the wire id", L.titleName(L.titleDef(14)!) !== "" && L.titleDef(14)!.set === 10);
  check("rank names", L.rankName(1) !== "" && !hasHangul(L.rankName(1)));
  // Sniper (id 14) = Set_10: AuthWeapon 5 / 6 = 105006 (its server award)
  check("weapon authority id", L.weaponItemId(5, 6) === 105006);
  // effect ids = the exe's DESIGNATION_ID table (CDesignationValueSet 0x4d1a20 values / 0x4d29d0 texts), not pef registry order
  const blaster = L.titleDef(40)!; // Set_14: plus id 56 = Throw_Speed_Plus_1 / STR_HEADER_THROWING_PLAS_1
  check("effect id -> pef key + string (exe table)", EFFECTS[blaster.plus[0]].join() === "THROWING_PLAS_1,Throw_Speed_Plus_1" && EFFECTS[71].join() === "WEAPON_REACTION_CONTROL_PLUS_1,Weapon_Reaction_Control_Plus_1" && EFFECTS[161][1] === "DPD_Rate_Minus_1" && EFFECTS[171][0] === "DESIGNATION_GET_SLOT2");
  check("effect texts come from STR_HEADER_*", L.effectText(51) === "Aumento de taxa de acerto de disparo Lv1" && L.effectText(86) === "Redução de movimento Lv1" && L.effectText(71) === "Aumento de precisão Lv1" && L.effectText(0) === "");
  // every title: name, English name, explanation, requirements and the three effect rows, none empty
  const nameOf = (id: number) => itemName(id).name;
  const empties: string[] = [];
  for (const t of TITLES) {
    const r = L.effectRows(t, nameOf);
    const fields: Record<string, string> = { name: L.titleName(t), name2: L.titleName2(t), explain: L.titleExplain(t), rank: L.rankName(t.rank), plus: r.plus, minus: r.minus, add: r.add };
    for (const [k, v] of Object.entries(fields)) if (!v.trim() || v.startsWith("#") || /Non String/.test(v)) empties.push(`${t.id}.${k}`);
    if (t.req1 && !L.titleDef(t.req1)) empties.push(`${t.id}.req1`);
    if (t.weapon.length && !r.add.includes(nameOf(L.weaponItemId(t.weapon[0][0], t.weapon[0][1])))) empties.push(`${t.id}.weapon`);
    for (const id of [...t.plus, ...t.minus]) if (!L.effectText(id)) empties.push(`${t.id}.effect${id}`);
    for (const id of t.add) if (id !== 220 && !L.effectText(id)) empties.push(`${t.id}.add${id}`);
  }
  check("44 titles: no empty detail field (name, English name, explanation, rank, + / - / extra rows, weapons)", empties.length === 0, empties.join(" "));
  const gunner = L.effectRows(L.titleDef(30)!, nameOf), assail = L.effectRows(L.titleDef(24)!, nameOf);
  check("rows: Gunner plus / minus effect texts, no minus -> Indisponível", gunner.plus === L.effectText(51) && gunner.minus === L.effectText(86) && L.effectRows(L.titleDef(1)!, nameOf).minus === L.TS.none);
  check("weapon row is independent of the extra effect id (title 24: AddEffect none, weapon [4,13])", L.titleDef(24)!.add.length === 0 && assail.add.startsWith("Permissão de compra de ") && assail.add !== L.effectRows(L.titleDef(9)!, nameOf).add);
}

// ---- controller: INFO button -> profile page -> pick -> confirm -> popup -> request -> state
{
  const conn = new FakeConn();
  const frames: { page: string; popup: boolean }[] = [];
  const ctl = new Lobby2017({
    serverUrl: "", username: "tester", token: new Uint8Array(),
    render: () => frames.push({ page: ctl.page, popup: !!(ctl as unknown as { modal(): string[] | null }).modal() }),
    onBattle() {}, onExit() {}, onLocalPlay() {},
  });
  const c = ctl as unknown as Record<string, unknown>;
  c.session = { notifyScreen() {}, player: undefined, shop: {}, lobby: new Proxy({}, { get: () => () => [] }) };
  c.stopPolling = () => {};
  const tc = (ctl.titles = new TitleClient(conn));
  ctl.page = "lobby";

  ctl.loadingRooms = false; // the room list is in: no loading curtain over the lobby
  conn.push(medals(1, 0, 0, 0));
  conn.push(info(0n, [0, 0, 0], 1));

  ctl.click("myinfo", "i3UIButton");
  check("INFO button opens the profile page", (ctl.page as string) === "profile" && ctl.profileTab === "designation");
  ctl.click("hit", "node:1");
  check("a node click picks the title", ctl.profile.selected === 1);
  // the controller reads the rank from the profile store; none here, so the confirm falls on the rank gate
  ctl.click("designation", "i3UIButtonConfirm");
  check("get without the rank: the client's own refusal text, no request", ctl.msg?.text === L.TS.notMatch && conn.sent.length === 0);
  ctl.click("popup", "btnOK");

  // rank 1 profile
  const rankOf = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(ctl), "chrome")!;
  void rankOf;
  (ctl as unknown as { chrome(): { rank: number } }).chrome = () => ({ ...EMPTY_CHROME, page: "profile", rank: 1 });
  ctl.click("designation", "i3UIButtonConfirm");
  check("get with rank 1 + 1 ribbon: confirm popup first", ctl.msg?.text === L.TS.getAsk && !!ctl.msg.onCancel && conn.sent.length === 0);
  conn.answers.set(2376, [medals(0, 0, 0, 0), ack(2377, 0, 1)]);
  ctl.click("popup", "btnOK");
  await new Promise((r) => setTimeout(r, 10));
  check("OK sends 2376 [1], the flag arrives, a success message shows", conn.sent.at(-1)?.op === 2376 && L.hasTitle(tc.state, 1) && ctl.msg?.text === L.TS.gotIt && !ctl.profile.busy, JSON.stringify([conn.sent.at(-1)?.op, ctl.msg?.text]));
  ctl.click("popup", "btnOK");

  check("confirmMode: owned, not equipped -> use; unknown id -> none", confirmMode({ state: tc.state, selected: 1 }) === "use" && confirmMode({ state: tc.state, selected: 0 }) === "none");
  ctl.click("hit", "slot0");
  check("slot click picks the slot", ctl.profile.slotSel === 0);
  ctl.click("designation", "i3UIButtonConfirm");
  check("use: confirm popup", ctl.msg?.text === L.TS.equipAsk);
  conn.answers.set(2378, [new PacketWriter(8).writeH(2379).writeD(0).writeC(0).writeC(1).toBytes()]);
  ctl.click("popup", "btnOK");
  await new Promise((r) => setTimeout(r, 10));
  check("OK sends 2378 [0, 1]; slot 0 now holds title 1", conn.sent.at(-1)?.op === 2378 && conn.sent.at(-1)!.body.join() === "0,1" && tc.state.equiped[0] === 1 && ctl.msg?.text === L.TS.registered);
  ctl.click("popup", "btnOK");

  ctl.click("hit", "unequip0");
  check("X asks before releasing", ctl.msg?.text === L.TS.releaseAsk);
  conn.answers.set(2380, [ack(2381, 0)]);
  ctl.click("popup", "btnOK");
  await new Promise((r) => setTimeout(r, 10));
  check("OK sends 2380 [0, 1]; the slot is empty again", conn.sent.at(-1)?.op === 2380 && conn.sent.at(-1)!.body.join() === "0,1" && tc.state.equiped[0] === 0);

  ctl.click("hit", "slot1");
  check("a locked slot cannot be picked", ctl.profile.slotSel === 0);
  // the lobby view needs a whole player store: only the page switch is checked
  c.backToLobby = () => { ctl.page = "lobby"; };
  (ctl as unknown as { onMain(c: string): void }).onMain("i3UIButton9");
  check("Voltar leaves the profile for the lobby", (ctl.page as string) === "lobby");
  ctl.click("myinfo", "i3UIButton");
  check("the INFO button opens it again with a clean pick", (ctl.page as string) === "profile" && ctl.profile.selected === 0 && ctl.profile.slotSel === -1);
  tc.dispose();
}

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
