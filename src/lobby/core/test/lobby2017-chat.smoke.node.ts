// Node-only smoke test for the lobby chat client (net/chatClient.ts, bugReport.ts, errorRing.ts):
// packet layouts of 2571 / 3606 / 1830 as server writes them, the "\u0001BUG" line, the block list, command parsing,
// the 100-line history and that text stays plain (no markup is interpreted). Run:
//   node --experimental-transform-types --no-warnings src/lobby/core/test/lobby2017-chat.smoke.node.ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

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
const { ChatClient, splitArgs, parseLobbyChat, BUG_MARK } = await import("../../../net/chatClient.ts");
const { scrub, pushError, lastErrors } = await import("../../../net/errorRing.ts");
const { buildBugMeta } = await import("../../../net/bugReport.ts");

const checks: { name: string; ok: boolean }[] = [];
const check = (name: string, ok: boolean, detail = "") => { checks.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`); };

// ---- packets exactly as server socialHandlers writes them (wstrz = chars + NUL)
const wstrz = (w: InstanceType<typeof PacketWriter>, s: string) => { for (let i = 0; i < s.length; i++) w.writeH(s.charCodeAt(i)); return w.writeH(0); };
const lobbyAck = (session: number, nick: string, color: number, gm: boolean, text: string) => {
  const w = new PacketWriter(64).writeD(session).writeC(nick.length + 1);
  wstrz(w, nick).writeC(color).writeC(gm ? 1 : 0).writeH(text.length + 1);
  return new PacketReader(wstrz(w, text).toBytes());
};
const roomAck = (type: number, slot: number, gm: boolean, text: string) => {
  const w = new PacketWriter(64).writeH(type).writeD(slot).writeC(gm ? 1 : 0).writeD(text.length + 1);
  return new PacketReader(wstrz(w, text).toBytes());
};
const whisperAck = (sender: string, gm: boolean, text: string) => {
  const w = new PacketWriter(96).writeU(sender, 66).writeC(gm ? 1 : 0).writeC(0).writeH(text.length + 1);
  return new PacketReader(wstrz(w, text).writeC(0).toBytes());
};

const sent: { op: number; body: Uint8Array }[] = [];
let listener: ((op: number, r: InstanceType<typeof PacketReader>) => void) | null = null;
const conn = {
  on: (fn: typeof listener) => { listener = fn; return () => { listener = null; }; },
  send: (op: number, body?: InstanceType<typeof PacketWriter>) => { sent.push({ op, body: body ? body.toBytes() : new Uint8Array() }); },
  waitFor: () => Promise.reject(new Error("no server")),
};
const c = new ChatClient();
c.myNick = "me";
c.attach(conn as never);
c.nickOfSlot = (s) => (s === 2 ? "Slot2" : "");
const got: { kind: string; nick: string; text: string; gm: boolean; slot?: number }[] = [];
c.onLine((l) => got.push(l));
let bugs = 0;
c.onBugPopup(() => { bugs++; });

const p = parseLobbyChat(lobbyAck(7, "Nick", 3, false, "olá <b>x</b>"));
check("parseLobbyChat", p.session === 7 && p.nick === "Nick" && p.color === 3 && p.text === "olá <b>x</b>");

listener!(2571, lobbyAck(7, "Alice", 0, false, "<img src=x onerror=alert(1)>"));
listener!(2571, lobbyAck(9, "GMBob", 1, true, "aviso"));
listener!(2571, lobbyAck(0, "Server", 5, false, "Comandos: /ajuda"));
listener!(2571, lobbyAck(0, "Server", 5, false, BUG_MARK));
listener!(3606, roomAck(1, 2, false, "geral sala"));
listener!(3606, roomAck(4, 2, false, "time"));
listener!(1830, whisperAck("Carol", false, "psiu"));
check("lobby line: kind all, text untouched (no markup parsing)", got[0].kind === "all" && got[0].nick === "Alice" && got[0].text === "<img src=x onerror=alert(1)>");
check("gm flag", got[1].gm === true && got[1].nick === "GMBob");
check("server line = system", got[2].kind === "system" && got[2].text === "Comandos: /ajuda");
check("BUG mark is not shown, fires the popup", bugs === 1 && !got.some((l) => l.text === BUG_MARK));
check("room 3606: general / team with the slot's nick", got[3].kind === "all" && got[3].nick === "Slot2" && got[3].slot === 2 && got[4].kind === "team");
check("whisper 1830", got[5].kind === "whisper" && got[5].nick === "Carol" && c.lastWhisper === "Carol");

// ---- send
check("send 2384 {H type, H len, U text}", c.send(1, "oi") && sent[0].op === 2384 && new PacketReader(sent[0].body).readH() === 1);
{
  const r = new PacketReader(sent[0].body);
  r.readH(); const n = r.readH();
  check("send body text", n === 2 && r.readU(n * 2) === "oi");
}
c.send(1, "x".repeat(100));
{ const r = new PacketReader(sent.at(-1)!.body); r.readH(); check("send cut at 60", r.readH() === 60); }
check("whisper 1826 + own line", c.whisper("Carol", "oi") && sent.at(-1)!.op === 1826 && got.at(-1)!.kind === "whisper" && got.at(-1)!.nick === "me");

// ---- block list (persisted)
c.block("Alice");
const before = got.length;
listener!(2571, lobbyAck(7, "alice", 0, false, "bloqueada"));
listener!(2571, lobbyAck(9, "GMBob", 1, true, "gm passa"));
check("blocked nick is filtered (case-insensitive), GM and system are not", got.length === before + 1 && got.at(-1)!.nick === "GMBob");
check("isBlocked + persisted", c.isBlocked("ALICE") && (store.get("pbweb.chat.blocked") ?? "").includes("alice"));
c.unblock("alice");
check("unblock", !c.isBlocked("Alice") && store.get("pbweb.chat.blocked") === "[]");

// ---- history bound
const h = new ChatClient();
for (let i = 0; i < 130; i++) h.system(`l${i}`);
check("history bounded to 100", h.history().length === 100 && h.history()[0].text === "l30");

// ---- command parsing
check("splitArgs quotes", JSON.stringify(splitArgs('/w "Nick Com Espaco" oi tudo bem', 3)) === JSON.stringify(["/w", "Nick Com Espaco", "oi tudo bem"]));
check("splitArgs plain", JSON.stringify(splitArgs("/bloquear   fulano")) === JSON.stringify(["/bloquear", "fulano"]));

// ---- error ring / bug meta never carry secrets
pushError("fetch failed https://x.test/api?token=SECRET123&a=1");
pushError("token=abcdef cookie: sid=1 " + "A".repeat(80));
const errs = lastErrors().join("|");
check("errorRing scrubs query / token / long blobs", !errs.includes("SECRET123") && !errs.includes("abcdef") && !errs.includes("A".repeat(40)), errs);
check("errorRing scrubs a bare 32-char token", scrub(`ws closed 3f9a${"0b".repeat(14)} x`) === "ws closed [x] x" && scrub("short abcdef0123456789") === "short abcdef0123456789");
for (let i = 0; i < 40; i++) pushError(`e${i} ` + "z".repeat(400));
check("errorRing bounded (20 x 300)", lastErrors().length === 20 && lastErrors().every((e) => e.length <= 300));
const meta = JSON.parse(buildBugMeta({ p2p_role: "host", room_id: 4 }));
check("bug meta fields", meta.p2p_role === "host" && meta.room_id === 4 && Array.isArray(meta.last_errors) && "client_build" in meta && "fps" in meta && "ping" in meta && "map" in meta && "mode" in meta && "user_agent" in meta);
check("bug meta <= 4000", buildBugMeta().length <= 4000);

const failed = checks.filter((x) => !x.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} passed`);
if (failed.length) process.exit(1);
