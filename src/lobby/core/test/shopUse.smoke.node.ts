// Node-only smoke test of "use now" after a shop purchase (controller doBuy -> msg.onOk -> useBought): a cosmetic use item
// (nick colour 1800006, u8; clan emblem 1800052, u32) takes the inventory's Usar through cosmeticUse (the Cross shell's
// useCosmeticItem), so no 1050 goes out; any other Durable item still activates with 1050. Without the cosmetic hook, 1050 on
// a cash use item (class 18) answers 1051 0x80000000 and the message box shows "Não é possível equipar / 1050: erro 0x80000000".
// No browser, no server. Run:
//   node --experimental-transform-types --no-warnings src/lobby/core/test/shopUse.smoke.node.ts
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { fileURLToPath } from "node:url";

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
const { Lobby2017 } = await import("../controller.ts");
const { MetaSession } = await import("../../state/MetaSession.ts");
const { ItemEquipType } = await import("../../types.ts");
const { setItemNameTable } = await import("../../state/itemNames.ts");

setItemNameTable(JSON.parse(readFileSync(new URL("../../state/data/itemNames.json", import.meta.url), "utf8")));
let fails = 0;
const check = (name: string, ok: boolean, detail = "") => { if (!ok) fails++; console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`); };

// ---- a fake Game connection: records requests; 1050 answers 1051 with the server's failure (server handleEquipSingle -> runItemAuth)
type Reader = InstanceType<typeof PacketReader>;
type Listener = (op: number, r: Reader) => void;
class FakeConn {
  isOpen = true;
  listeners = new Set<Listener>();
  sent: { op: number }[] = [];
  waiters: { op: number; resolve: (r: Reader) => void }[] = [];
  on(fn: Listener) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  waitFor(op: number) { return new Promise<Reader>((resolve) => this.waiters.push({ op, resolve })); }
  send(op: number, body?: InstanceType<typeof PacketWriter> | Uint8Array) {
    this.sent.push({ op });
    if (op === 1050) queueMicrotask(() => this.push(new PacketWriter(8).writeH(1051).writeD(0x80000000).toBytes()));
    void body;
  }
  push(packet: Uint8Array) {
    const op = packet[0] | (packet[1] << 8);
    for (const f of [...this.listeners]) f(op, new PacketReader(packet, 2));
    const w = this.waiters.filter((x) => x.op === op);
    this.waiters = this.waiters.filter((x) => x.op !== op);
    for (const x of w) x.resolve(new PacketReader(packet, 2));
  }
}

const tick = () => new Promise((r) => setTimeout(r, 10));
const FAIL_TEXT = "Não é possível equipar\n1050: erro 0x80000000";

/** buy one cash use item in the shop (SBN_Buy), then answer the "Deseja usar este item agora?" box with OK */
async function buyThenUse(itemId: number, objectId: number, cosmetic: ((it: { itemId: number }) => boolean) | null) {
  const conn = new FakeConn();
  const ctl = new Lobby2017({ serverUrl: "", username: "tester", token: new Uint8Array(), render: () => {}, onBattle() {}, onExit() {}, onLocalPlay() {} });
  const s = new MetaSession();
  s.attach(conn as never);
  s.shop.offers = [{ itemId, options: [{ goodId: 1, itemId, priceGold: 0, priceCash: 100 }] }] as never;
  s.buy = async () => { (s.player.state.inventory as Map<number, unknown>).set(objectId, { objectId, itemId, equip: ItemEquipType.Durable, count: 3600 }); return {} as never; };
  const c = ctl as unknown as Record<string, unknown>;
  c.session = s;
  c.cosmeticUse = cosmetic;
  ctl.menu = { ...ctl.menu, selected: itemId } as never;
  ctl.openBuy();
  ctl.click("buy", "SBN_Buy");
  await tick();
  const box = ctl.msg as { text: string; onOk?: () => void } | null;
  box?.onOk?.();
  await tick();
  return { conn, ctl, box };
}

// 1. nick colour (1800006, u8) bought, then "use now": the cosmetic hook takes it, no 1050
{
  const seen: number[] = [];
  const { conn, box } = await buyThenUse(1800006, 7001, (it) => { seen.push(it.itemId); return true; });
  check("nick colour: the use-now box asks after the purchase", !!box && box.text.includes("Deseja usar este item agora?"));
  check("nick colour: use now goes to the cosmetic hook with the bought item", seen.length === 1 && seen[0] === 1800006);
  check("nick colour: no 1050 is sent (the inventory's Usar never activates it)", !conn.sent.some((x) => x.op === 1050));
}

// 2. clan emblem change (1800052, u32) bought, then "use now": same route
{
  const seen: number[] = [];
  const { conn } = await buyThenUse(1800052, 7002, (it) => { seen.push(it.itemId); return true; });
  check("clan emblem: use now goes to the cosmetic hook", seen.length === 1 && seen[0] === 1800052);
  check("clan emblem: no 1050 is sent", !conn.sent.some((x) => x.op === 1050));
}

// 3. the hook does not claim it: the old path, 1050 on a cash use item -> the server's 0x80000000 is shown
{
  const { conn, ctl } = await buyThenUse(1800006, 7003, () => false);
  check("no cosmetic hook: 1050 is sent for the cash use item", conn.sent.some((x) => x.op === 1050));
  check("no cosmetic hook: the error text of the failed 1050", ctl.msg?.text === FAIL_TEXT, JSON.stringify(ctl.msg?.text));
}

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
