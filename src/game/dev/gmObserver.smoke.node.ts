// Node smoke of the hidden GM's observer decision (RoomClient.gmObserver / sitsOutRound, read by game.ts at Game.create and on every
// Bomb ROUND_START): the real RoomClient parses the server's real JOIN_ROOM_ACK (server roomPackets.joinRoomAck) of a GM
// that joined hidden (seat 16), then the real 5153 of a Bomb round, whose slots flag carries the GM's seat (C# GetSlotsFlag).
//   node --experimental-transform-types src/game/dev/gmObserver.smoke.node.ts
import { PacketReader, PacketWriter } from "../../net/packet.ts";
import { RoomClient, RoomOp } from "../../net/roomClient.ts";
import type { GameClient } from "../../net/gameClient.ts";

// server modules at run time only: the client tsconfig (lib ES2020) must not type-check the server sources
const srv = (p: string): Promise<any> => import(new URL(`../../../server/src/${p}`, import.meta.url).href);
const { Account } = await srv("shared/account.ts");
const { RoomModel, SlotState } = await srv("game/roomModel.ts");
const rp = await srv("game/roomPackets.ts");

let fails = 0;
const check = (name: string, ok: boolean) => { if (!ok) fails++; console.log(`${ok ? "ok  " : "FAIL"} ${name}`); };

// server side: a TDM / Bomb room with a leader, a guest and a GM that joined hidden
function serverRoom(roomType: number) {
  const accounts: { playerId: bigint }[] = [];
  const svc = { getAccount: (pid: bigint) => accounts.find((a) => a.playerId === pid) ?? null, send: () => {}, updateStatus: async () => {} };
  const r = new RoomModel(3, { id: 0, type: 0, serverId: 1, lobbyPlayers: [] }, svc);
  Object.assign(r, { name: "sala", mapId: 4, rule: 0, stage: 1, roomType, killTime: 0x13, weaponsFlag: 0x1ff });
  const mk = (pid: bigint, nick: string, gm = false) => {
    const a = new Account();
    Object.assign(a, { playerId: pid, nickname: nick, rank: 10, access: gm ? 100 : 0, isOnline: true });
    accounts.push(a);
    return a;
  };
  const L = mk(100n, "Leader"), P1 = mk(101n, "P1"), GM = mk(900n, "StaffGM", true);
  r.addPlayer(L); r.leader = L.slotId; r.addPlayer(P1);
  r.addStealthPlayer(GM);
  return { r, L, P1, GM };
}

// client side: a RoomClient on a fake connection that answers the JOIN with the server's bytes (readers start past the opcode)
function client(joinAck: Uint8Array) {
  const sent: { op: number; body: Uint8Array }[] = [];
  let feed: ((op: number, r: PacketReader) => void) | null = null;
  const conn = {
    send: (op: number, w?: PacketWriter) => sent.push({ op, body: w?.toBytes() ?? new Uint8Array(0) }),
    waitFor: async () => new PacketReader(joinAck, 2),
    on: (cb: (op: number, r: PacketReader) => void) => { feed = cb; return () => { feed = null; }; },
  };
  const rc = new RoomClient({ conn } as unknown as GameClient);
  const push = (bytes: Uint8Array) => feed?.(bytes[0] | (bytes[1] << 8), new PacketReader(bytes, 2));
  return { rc, sent, push };
}

for (const stealth of [true, false]) {
  const s = serverRoom(4);
  const seat = s.GM.slotId;
  const c = client(rp.joinRoomAck(0, s.GM, s.r));
  await c.rc.join(s.r.roomId, "", stealth);
  const tag = stealth ? "hidden join" : "join without the stealth byte (server seated it hidden anyway)";
  check(`${tag}: mySlot ${c.rc.mySlot} = server seat ${seat} (16 / 17)`, c.rc.mySlot === seat && seat >= 16);
  check(`${tag}: isGM latched from the own slot record (auth ${c.rc.slots[seat]?.auth})`, c.rc.isGM);
  check(`${tag}: gmObserver before any READY (game.ts:529 -> spectating)`, c.rc.gmObserver);
  c.rc.ready(0); // a click without the room's GM box
  const rb = c.sent.find((x) => x.op === RoomOp.BATTLE_READYBATTLE_REQ);
  check(`${tag}: READY goes out as mode 2`, !!rb && rb.body[0] === 2);
}

// a hidden GM that a team balance (3622) moved into a combatant seat (server before the specGM guard in tryBalancePlayer):
// still an observer, READY still mode 2 - the server keeps stealth / specGM on the moved slot
{
  const s = serverRoom(4);
  const c = client(rp.joinRoomAck(0, s.GM, s.r));
  await c.rc.join(s.r.roomId, "", true);
  c.push(rp.teamBalanceAck([{ oldId: s.GM.slotId, newId: 3, oldState: 0, newState: 9 }], s.r.leader, 1));
  c.rc.gmObserverMode = false; // the battle after: no READY with mode 2 sent from seat 16 any more
  check(`moved to seat ${c.rc.mySlot}: still gmObserver (hiddenGm)`, c.rc.mySlot === 3 && c.rc.gmObserver);
  c.sent.length = 0; c.rc.ready(0);
  check("moved: READY still mode 2", c.sent.find((x) => x.op === RoomOp.BATTLE_READYBATTLE_REQ)?.body[0] === 2);
}

// Bomb: ROUND_START 5153 of the real server; the GM's bit is in the flag like everyone's in LOAD+
{
  const s = serverRoom(8);
  for (const x of s.r.slots) if (x.playerId > 0n) x.state = SlotState.BATTLE;
  const flag = s.r.getSlotsFlag(true, false);
  check(`5153 slots flag carries the GM seat (0x${flag.toString(16)})`, ((flag >>> s.GM.slotId) & 1) === 1);
  const gm = client(rp.joinRoomAck(0, s.GM, s.r));
  await gm.rc.join(s.r.roomId, "", true);
  gm.push(rp.roundStartAck(s.r));
  check("GM: lastRoundStart parsed", gm.rc.lastRoundStart?.slotsFlag === flag);
  check("GM: sits the round out (game.ts initBomb / onRoundStart -> spectating)", gm.rc.sitsOutRound(gm.rc.lastRoundStart!.slotsFlag));
  const pl = client(rp.joinRoomAck(0, s.P1, s.r));
  await pl.rc.join(s.r.roomId, "");
  check(`player P1 (seat ${pl.rc.mySlot}, not GM): plays the round`, !pl.rc.isGM && !pl.rc.sitsOutRound(flag));
  check("player left out of the flag (late joiner, Spectator): sits it out", pl.rc.sitsOutRound(flag & ~(1 << pl.rc.mySlot)));
}

process.exit(fails ? 1 : 0);
