// Used by src/p2p/test/p2pbattle.live.ts (P2P host):
// A switches to the knife -> B's copy of A holds that item id / slot (WeaponSync + ActionState.weaponFlag);
// A throws a flashbang -> B gets the SubHead.Grenade throw (origin + velocity) and its explosion;
// A drops (G) its rifle -> B gets the DropWeapon event and the SubHead.DroppedWeapon position stream.
import type { PbBattleNet } from "../battle.ts";
import type { DroppedSyncEvent, PlayerState, ThrowEvent, WeaponDropEvent } from "../../game/netAdapter";

export const KNIFE_ID = 301001; // default melee (weapons.json)
export const FLASH_ID = 508002; // server FlashBang (throwables.ts)
export const RIFLE_ID = 103037; // default primary

export interface ReplicationResult { name: string; ok: boolean; detail: string }

/** Pumps both clients for ~1.5 s with `mk(i)` states while A switches / throws / drops; returns one result per feature. */
export async function replicationChecks(
  A: PbBattleNet, B: PbBattleNet, aSlot: number,
  mk: (who: "A" | "B", i: number) => PlayerState, i0: number,
): Promise<{ results: ReplicationResult[]; i: number }> {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const throws: ThrowEvent[] = [];
  const drops: WeaponDropEvent[] = [];
  const streamed: DroppedSyncEvent[] = [];
  const offT = B.onRemoteThrow((e) => throws.push(e));
  const offD = B.onRemoteDrop((e) => drops.push(e));
  const offS = B.onRemoteDropped((e) => streamed.push(e));
  const idx = (aSlot & 0x0f) << 4;
  const origin: [number, number, number] = [3.5, 1.4, -8];
  const vel: [number, number, number] = [4.25, 3.5, -12.75];
  const boom: [number, number, number] = [7.5, 0.25, -18];
  const dropAt: [number, number, number] = [5, 0.5, -9];
  let i = i0;
  const pump = setInterval(() => {
    const k = i - i0;
    // knife in hand from the first tick on (slot 2 = melee)
    A.sendState({ ...mk("A", i), weapon: "M-7", weaponId: KNIFE_ID, weaponSlot: 2 });
    B.sendState(mk("B", i));
    if (k === 5) A.sendThrow({ actorId: A.localId, idx, state: "throw", weaponId: FLASH_ID, pos: origin, vel });
    if (k === 15) A.sendThrow({ actorId: A.localId, idx, state: "explode", weaponId: FLASH_ID, pos: boom, vel: [0, 0, 0] });
    if (k === 20) A.sendDrop({ actorId: A.localId, weaponId: RIFLE_ID, slot: 0, ammo: 30, extra: 0, reserve: 90, death: false, idx: 1, pos: dropAt, yaw: 0 });
    if (k === 22) A.sendDropped({ actorId: A.localId, idx: 1, weaponId: RIFLE_ID, slot: 0, death: false, ammo: 30, extra: 0, reserve: 90, pos: [5, 0.75, -9.25], resting: false });
    if (k === 25) A.sendDropped({ actorId: A.localId, idx: 1, weaponId: RIFLE_ID, slot: 0, death: false, ammo: 30, extra: 0, reserve: 90, pos: [5, 0.04, -9.5], resting: true });
    i++;
  }, 40);
  await sleep(1600);
  clearInterval(pump);
  await sleep(300);
  offT();
  offD();
  offS();
  const near = (p: number[] | undefined, q: number[], tol = 0.05) => !!p && Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) < tol;
  const seen = B.latest(aSlot);
  const th = throws.find((t) => t.state === "throw"), ex = throws.find((t) => t.state === "explode");
  const dr = drops[0], rest = streamed.find((s) => s.resting);
  return {
    i,
    results: [
      { name: "weapon in hand: A's knife (item id + melee slot) on B's copy of A",
        ok: seen?.weaponId === KNIFE_ID && seen.weaponSlot === 2, detail: `weaponId ${seen?.weaponId} slot ${seen?.weaponSlot}` },
      { name: "throwable: A's flashbang throw (SubHead.Grenade: idx, item, origin, velocity) reaches B",
        ok: !!th && th.idx === idx && th.weaponId === FLASH_ID && th.actorId === A.localId && near(th.pos, origin) && near(th.vel, vel, 1e-4),
        detail: th ? `idx ${th.idx} id ${th.weaponId} pos ${th.pos.map((v) => v.toFixed(2))} vel ${th.vel.map((v) => v.toFixed(2))}` : "none" },
      { name: "throwable: its explosion record (position) reaches B",
        ok: !!ex && ex.idx === idx && near(ex.pos, boom), detail: ex ? `pos ${ex.pos.map((v) => v.toFixed(2))}` : "none" },
      { name: "dropped weapon: A's DropWeapon (item, ammo, slot) + the DroppedWeapon stream at rest reach B",
        ok: !!dr && dr.weaponId === RIFLE_ID && dr.ammo === 30 && dr.reserve === 90 && dr.slot === 0 && !!rest && rest.weaponId === RIFLE_ID && near(rest.pos, [5, 0.04, -9.5], 0.02),
        detail: `${drops.length} drop(s) idx ${dr?.idx}, ${streamed.length} stream record(s)${rest ? ` rest ${rest.pos.map((v) => v.toFixed(2))}` : ""}` },
    ],
  };
}
