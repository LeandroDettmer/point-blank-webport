// Live E2E of the context menu "Novo dono" (leader transfer in the ready room): A creates the room and is leader, B joins,
// B (guest) asks for the leadership by the menu path and is refused, A hands it to B and both clients see B as leader.
//   node --experimental-transform-types src/net/test/leaderTransfer.live.ts [--gw ws://127.0.0.1:8090] [--api http://127.0.0.1:8090]
// Needs Postgres and server running. Exit 0 = pass.
import { AuthClient, gameTargetForServer } from "../authClient.ts";
import { GameClient } from "../gameClient.ts";
import { RoomClient } from "../roomClient.ts";
import { collectEnterPushes } from "../metaGame.ts";
import { fetchAuthMeta } from "../metaAuth.ts";

const arg = (k: string, d: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const GW = arg("--gw", "ws://127.0.0.1:8090");
const API = arg("--api", "http://127.0.0.1:8090");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const checks: { name: string; ok: boolean }[] = [];
const check = (name: string, ok: boolean, detail = "") => { checks.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`); };

async function waitFor(cond: () => boolean, ms = 3000): Promise<boolean> {
  for (let t = 0; t < ms; t += 50) { if (cond()) return true; await sleep(50); }
  return cond();
}

async function enter(username: string): Promise<GameClient> {
  const res = await fetch(`${API}/api/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password: "leader-test-pw1" }) });
  const body = (await res.json()) as { token?: string; error?: string };
  if (res.status !== 201 || !body.token) throw new Error(`register ${username}: ${res.status} ${body.error ?? ""}`);
  console.log("enter", username);
  const auth = new AuthClient(GW);
  const mac = crypto.getRandomValues(new Uint8Array(6));
  mac[0] = (mac[0] & 0xfe) | 2;
  const login = await auth.connectAndLogin({ token: Uint8Array.from(Buffer.from(body.token, "base64")), mac });
  if (!login.ok) throw new Error(`${username}: login ${login.errorName}`);
  await fetchAuthMeta(auth.conn);
  const server = (await auth.getServers()).find((s) => s.index > 0)!;
  await auth.leave();
  const game = new GameClient(gameTargetForServer(server), GW);
  const connect = game.conn.connect.bind(game.conn);
  let pushes: Promise<unknown> | null = null;
  game.conn.connect = async (...a) => { const i = await connect(...a); pushes = collectEnterPushes(game.conn).done; return i; };
  await game.enter(login.username, login.playerId, server.index);
  await pushes;
  await game.selectChannel(0);
  await game.enterLobby();
  return game;
}

async function main(): Promise<void> {
  const sfx = `${Date.now() % 1e7}`;
  const gA = await enter(`lda${sfx}`); await sleep(3000);
  const gB = await enter(`ldb${sfx}`); await sleep(3000);
  const A = new RoomClient(gA), B = new RoomClient(gB);

  const room = await A.create({ name: `leader ${sfx.slice(-4)}`, mapId: 4, slots: 4 });
  check("A creates the room and leads (slot 0)", A.isLeader && A.mySlot === 0, `mySlot ${A.mySlot} leaderSlot ${A.leaderSlot}`);
  const slotB = await B.join(room.roomId);
  check("B joins a normal slot", slotB > 0 && slotB < 16, `slot ${slotB}`);
  await waitFor(() => B.leaderSlot === 0);

  // guest asks for the leadership through the menu path: the server refuses (not leader), the room keeps A
  B.changeLeader(0);
  await sleep(1000);
  check("guest B cannot take the room (3616 refused)", A.isLeader && !B.isLeader, `A leaderSlot ${A.leaderSlot}, B leaderSlot ${B.leaderSlot}`);

  // leader A hands the room to B (Novo dono on B's slot)
  A.changeLeader(slotB);
  check("leader A hands the room to B", await waitFor(() => B.isLeader && A.leaderSlot === slotB), `A leaderSlot ${A.leaderSlot}, B leaderSlot ${B.leaderSlot}`);
  check("A is now a guest", !A.isLeader && A.mySlot === 0, `A mySlot ${A.mySlot}`);

  await B.leave().catch(() => {});
  await A.leave().catch(() => {});
  A.dispose(); B.dispose();
  gA.close(); gB.close();
  const failed = checks.filter((x) => !x.ok);
  console.log(failed.length ? `\nRESULT: FAIL - ${failed.map((x) => x.name).join("; ")}` : `\nRESULT: PASS - ${checks.length} checks`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
