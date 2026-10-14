// Server.Match (UDP 40009) datagram codec. Source: Server.Match/MatchClient.cs (BeginReceive,
// ProcessUnregister_65, ProcessPVPPacket, WritePlayerActionData, Method0), Data/Utils/AllUtils.cs
// (GetDecryptedData, BaseWriteCode, IsUdp121Handshake), Data/Utils/Udp121Cipher.cs,
// Network/Packets/PROTOCOL_CONNECT.cs, PROTOCOL_EVENTS_ACTION.cs. See
//
// Every datagram starts with the same plaintext header (17 bytes, 25 on S->C and 121 C->S game data):
//   C opcode | C slot | T time | C round | H length (= whole datagram) | C respawn | C roundNumber
//   | C accountId (low byte of PlayerId) | C unk1 | D unk2
import { bitwiseDecrypt, bitwiseEncrypt } from "./bitwise.ts";
import { PacketReader, PacketWriter } from "./packet.ts";

export const MatchOp = {
  PVP: 3, // C->S game data (relayed to the other slots as opcode 4)
  PVE: 4, // S->C game data
  REGISTER: 65, // C->S join the UDP room (reply: CONNECT 66)
  CONNECT: 66, // S->C
  UNREGISTER: 67, // C->S leave
  PING: 97, // C->S, echoed verbatim
} as const;

/** Settings.ini [Others] UdpVersion = -31247.1733 (checked by RoomModel.AddPlayer). */
export const UDP_VERSION = [-31247 & 0xffff, 1733] as const;

export interface MatchHeader {
  opcode: number;
  slot: number;
  time: number;
  round: number;
  length: number;
  respawn: number;
  roundNumber: number;
  accountId: number;
  unk1: number;
  unk2: number;
}

export interface RoomKey {
  uniqueRoomId: number; // (serverId << 20) | (channelId << 12) | roomId
  roomSeed: number; // (mapId << 20) | (rule << 12) | roomType
}

// ---------------------------------------------------------------- half floats (SharpDX Half)

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);

export function toHalf(v: number): number {
  f32[0] = v;
  const x = u32[0];
  const sign = (x >>> 16) & 0x8000;
  let exp = ((x >>> 23) & 0xff) - 127 + 15;
  let mant = x & 0x7fffff;
  if (exp <= 0) {
    if (exp < -10) return sign;
    mant = (mant | 0x800000) >> (1 - exp);
    return sign | ((mant + 0x1000) >> 13);
  }
  if (exp >= 31) return sign | 0x7c00;
  mant += 0x1000; // round
  if (mant & 0x800000) {
    mant = 0;
    exp++;
    if (exp >= 31) return sign | 0x7c00;
  }
  return sign | (exp << 10) | (mant >> 13);
}

export function fromHalf(h: number): number {
  const s = h & 0x8000 ? -1 : 1;
  const e = (h >> 10) & 0x1f;
  const m = h & 0x3ff;
  if (e === 0) return s * m * 2 ** -24;
  if (e === 31) return m ? NaN : s * Infinity;
  return s * (1 + m / 1024) * 2 ** (e - 15);
}

// ---------------------------------------------------------------- Udp121Cipher

function tap(buf: Uint8Array, bit: number): number {
  const len = buf.length;
  const i = Math.floor(bit / 8) % len;
  const sh = bit & 7;
  if (sh === 0) return buf[i];
  return ((buf[(i + 1) % len] >> (8 - sh)) + ((buf[i] & (0xff >> sh)) << sh)) & 0xff;
}

/** Client->server blob (inverse of Udp121Cipher.Decrypt). key1 = header time bytes, key2 = unk2 bytes. */
export function udp121EncryptC2S(plain: Uint8Array, key1: Uint8Array, key2: Uint8Array, rnd = Math.random): Uint8Array {
  const k1 = key1.slice();
  const k2 = key2.slice();
  const iv1 = Math.floor(rnd() * 32);
  const iv2 = Math.floor(rnd() * 32);
  const mix = Math.floor(rnd() * 256);
  const padLen = ((2 - plain.length) & 7) + 2;
  const out = new Uint8Array(4 + plain.length + padLen);
  out[0] = iv1;
  out[1] = iv2;
  out[2] = mix;
  out[3] = padLen;
  const idx1 = ((mix & 0xf) + iv1) & 0xff;
  const idx2 = ((mix >> 4) + iv2) & 0xff;
  let fb = 0;
  let jit = 0;
  for (let i = 0; i < plain.length + padLen; i++) {
    fb = (fb ^ tap(k1, idx1 + jit) ^ tap(k2, idx2 + jit)) & 0xff;
    const c = (fb ^ (i < plain.length ? plain[i] : padLen)) & 0xff;
    out[4 + i] = c;
    jit = (jit + fb + 8) >>> 0;
    for (let j = 0; j < k1.length; j += 2) k1[j] ^= c;
    for (let j = 1; j < k2.length; j += 2) k2[j] ^= c;
  }
  return out;
}

/** Server->client blob (inverse of Udp121Cipher.EncryptServerToClient). */
export function udp121DecryptS2C(blob: Uint8Array, key1: Uint8Array, key2: Uint8Array): Uint8Array | null {
  if (blob.length < 4) return null;
  const [iv1, iv2, mix, padLen] = blob;
  const ctLen = blob.length - 4 - padLen;
  if (ctLen < 0) return null;
  const k1 = key1.slice();
  const k2 = key2.slice();
  const idx1 = (iv1 + (mix >> 4)) & 0xff;
  const idx2 = (iv2 + (mix & 15)) & 0xff;
  let fb = 0;
  let jit = 0;
  const out = new Uint8Array(ctLen);
  for (let i = 0; i < ctLen; i++) {
    fb = (fb ^ tap(k1, idx1 + jit) ^ tap(k2, idx2 + jit)) & 0xff;
    const c = blob[4 + i];
    out[i] = fb ^ c;
    jit = (jit + fb + 14) >>> 0;
    k1[0] ^= c;
    k1[2] ^= c;
    k2[1] ^= c;
    k2[3] ^= c;
  }
  return out;
}

// ---------------------------------------------------------------- datagrams

function writeHeader(w: PacketWriter, h: Omit<MatchHeader, "length">, length: number): void {
  w.writeC(h.opcode).writeC(h.slot).writeT(h.time).writeC(h.round).writeH(length)
    .writeC(h.respawn).writeC(h.roundNumber).writeC(h.accountId).writeC(h.unk1).writeD(h.unk2);
}

export function readHeader(data: Uint8Array): MatchHeader {
  const r = new PacketReader(data);
  const opcode = r.readC();
  const slot = r.readC();
  const time = new DataView(data.buffer, data.byteOffset + 2, 4).getFloat32(0, true);
  r.skip(4);
  return {
    opcode, slot, time, round: r.readC(), length: r.readH(), respawn: r.readC(), roundNumber: r.readC(),
    accountId: r.readC(), unk1: r.readC(), unk2: r.readD(),
  };
}

/**
 * 121 handshake (AllUtils.IsUdp121Handshake): 38 plaintext bytes, magic at 17..29, then
 * D uniqueRoomId, D roomSeed, C dedicationSlot. The server fills in UdpVersion itself.
 * opcode 65 = register (reply CONNECT 66), 67 = unregister.
 */
export function buildHandshake(opcode: 65 | 67, slot: number, accountId: number, key: RoomKey, dedicationSlot = 255): Uint8Array {
  const w = new PacketWriter(38);
  writeHeader(w, { opcode, slot, time: 0, round: 0, respawn: 0, roundNumber: 0, accountId, unk1: 0, unk2: 0 }, 38);
  w.writeD(0x34282e8c).writeD(0x2b3c3014).writeD(0x000705e4);
  w.writeD(key.uniqueRoomId).writeD(key.roomSeed).writeC(dedicationSlot);
  return w.toBytes();
}

/**
 * 121 game data (opcode 3): [25B plaintext header][rotate(blob ++ 9B trailer, length % 6 + 1)].
 * Trailer (read by ProcessPVPPacket after the actions): D uniqueRoomId, C dedicationSlot, D roomSeed.
 * dedicationSlot must be 255 for the server to relay to the other slots.
 */
export function buildGameData(
  h: Omit<MatchHeader, "length" | "opcode" | "unk2">,
  actions: Uint8Array,
  key: RoomKey,
  rnd = Math.random,
): Uint8Array {
  const unk2 = Math.floor(rnd() * 0x100000000) >>> 0;
  const timeBytes = new Uint8Array(4);
  new DataView(timeBytes.buffer).setFloat32(0, h.time, true);
  const unk2Bytes = new Uint8Array(4);
  new DataView(unk2Bytes.buffer).setUint32(0, unk2, true);
  const blob = udp121EncryptC2S(actions, timeBytes, unk2Bytes, rnd);
  const trailer = new PacketWriter(9).writeD(key.uniqueRoomId).writeC(255).writeD(key.roomSeed).toBytes();
  const region = new Uint8Array(blob.length + 9);
  region.set(blob);
  region.set(trailer, blob.length);
  const length = 25 + region.length;
  const w = new PacketWriter(length);
  writeHeader(w, { ...h, opcode: MatchOp.PVP, unk2 }, length);
  w.writeD(0).writeD(0);
  w.writeB(bitwiseEncrypt(region, (length % 6) + 1));
  return w.toBytes();
}

/** Opcode 97. Legacy framing (17B header + rotated 9B trailer); the server echoes it back. */
export function buildPing(slot: number, accountId: number, key: RoomKey, time: number): Uint8Array {
  const trailer = new PacketWriter(9).writeD(key.uniqueRoomId).writeC(255).writeD(key.roomSeed).toBytes();
  const length = 17 + trailer.length;
  const w = new PacketWriter(length);
  writeHeader(w, { opcode: MatchOp.PING, slot, time, round: 0, respawn: 0, roundNumber: 0, accountId, unk1: 0, unk2: 0 }, length);
  w.writeB(bitwiseEncrypt(trailer, (length % 6) + 1));
  return w.toBytes();
}

/** S->C opcode 4/132 (AllUtils.BaseWriteCode): returns the decrypted action stream. */
export function decodeServerGameData(data: Uint8Array): { header: MatchHeader; actions: Uint8Array } | null {
  if (data.length < 25) return null;
  const header = readHeader(data);
  if (header.length > data.length) return null;
  const region = bitwiseDecrypt(data.subarray(25, header.length), (header.length % 6) + 1);
  const actions = udp121DecryptS2C(region, data.slice(2, 6), data.slice(13, 17));
  return actions ? { header, actions } : null;
}

// ---------------------------------------------------------------- action records

/** UdpGameEvent (Server.Match/Data/Enums/UdpGameEvent.cs). Bit order below = wire order. */
export const Ev = {
  ActionState: 0x100,
  Animation: 0x2,
  PosRotation: 0x08000000,
  SoundPosRotation: 0x00800000,
  UseObject: 0x4,
  ActionForObjectSync: 0x10,
  RadioChat: 0x20,
  WeaponSync: 0x04000000,
  WeaponRecoil: 0x80,
  HpSync: 0x8,
  Suicide: 0x00100000,
  MissionData: 0x800,
  DropWeapon: 0x00400000,
  GetWeaponForClient: 0x01000000,
  FireData: 0x02000000,
  CharaFireNHitData: 0x400,
  HitData: 0x00020000,
  GrenadeHit: 0x10000000,
  GetWeaponForHost: 0x200,
} as const;

/** CameraX/CameraY are u16 angles; we map 0..65535 <-> 0..2π (yaw) and -π..π (pitch). */
export const angleToU16 = (a: number) => Math.round((((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) / (2 * Math.PI) * 65535) & 0xffff;
export const u16ToAngle = (v: number) => (v / 65535) * 2 * Math.PI;

export interface PosRot {
  x: number; y: number; z: number; // world position (Half3 on the wire)
  yaw: number; pitch: number; // radians
  area: number;
}

export interface FireInfo {
  effect: number; part: number; index: number; weaponId: number;
  x: number; y: number; z: number; // aim/target point (Half3)
}

export interface HitInfo {
  start: [number, number, number];
  end: [number, number, number];
  victimSlot: number;
  damage: number; // raw damage (HitIndex >> 21); applied as-is while AntiScript=False
  part: number; // CharaHitPart: 14 HEAD, 1 ALL (web: torso), 2 (web convention: limb)
  /** ObjectType in HitIndex bits 0-1: 1 User (server applies damage), 2 UserObject (relayed untouched). */
  objectType?: number;
  weaponId: number;
}

export interface ActionIn {
  /** SubHead.User/StageInfoChara: the player slot; Grenade: the throw net index; DroppedWeapon: the drop index */
  slot: number;
  /** UdpSubHead of the record when not User (1 Grenade, 2 DroppedWeapon, 8 StageInfoChara) */
  sub?: number;
  flags: number;
  actionState?: { action: number; value: number; weaponFlag: number };
  posRot?: PosRot;
  soundTime?: number;
  weaponId?: number;
  hp?: number;
  fire?: FireInfo;
  hits?: HitInfo[];
  /** Server-generated death event (PROTOCOL_EVENTS_ACTION type 2 with life 0). */
  death?: { killerSlot: number; deathType: number; hitPart: number };
  /** RadioChat 0x20: radio id (type * 10 + index) + map area */
  radio?: { id: number; area: number };
  /** DropWeapon 0x400000 (flags already carry the server's DropCounter) */
  drop?: WeaponDropInfo;
  /** GetWeaponForClient 0x1000000: a pick-up of the drop `flags & 0x1f` */
  pickup?: WeaponDropInfo;
  /** SubHead.Grenade record (slot = throw net index) */
  grenade?: GrenadeSyncInfo;
  /** SubHead.DroppedWeapon record (slot = drop index) */
  dropped?: DroppedWeaponInfo;
}

/** UdpSubHead (Server.Match/Data/Enums/UdpSubHead.cs) */
export const SubHead = { User: 0, Grenade: 1, DroppedWeapon: 2, StageInfoChara: 8 } as const;

/**
 * Grenade state byte. 2017 exe CGameUDPHandler::WriteGameEvent_ThrowWeaponData 0x9fbef0 (GAMEINFO_THROW_WEAPON +0xc):
 * 1 = flying (resent on a timer, +0x60), 8 = C5 triggered (timer +0x5c), any other value is sent at once and closes the
 * object (+0x50 = 2): web uses 2 = exploded; 0x80 = attached (the +0x14 byte is kept).
 */
export const GrenadeState = { Fly: 1, Explode: 2, Trigger: 8, Attached: 0x80 } as const;

/**
 * SubHead.Grenade body, 30 B, relayed untouched by Server.Match (GrenadeSync.cs) and matchCore:
 * C state | C ownerSlot | C seq | C 0 | H boomInfo | D weaponId | C acc | C ext | H x | H y | H z (Half3) | D vx | D vy | D vz.
 * The record's slot field is the throw net index (exe 0..255, `idx % 16` per thrower): web = owner * 16 + seq % 16.
 * Unk2/Unk3 (owner, seq) and Unk5..7 (velocity, f32 bits) are web conventions [INFERIDO]: both relays copy them as-is.
 */
export interface GrenadeSyncInfo {
  state: number; owner: number; weaponId: number; accessory?: number; extensions?: number;
  pos: [number, number, number]; vel: [number, number, number]; boomInfo?: number;
}

/**
 * SubHead.DroppedWeapon body, 31 B (DropedWeapon.cs): HV pos (Half3 x,y,z) | H unk1..4 | C weaponFlag | B[16].
 * Web: unk1..3 = loaded / extra / reserve, unk4 = 1 at rest; weaponFlag = pbDrop dropFlags; B[16] = D weaponId | C owner | 11 x 0.
 * The drop's owner streams it while it falls and once at rest.
 */
export interface DroppedWeaponInfo {
  pos: [number, number, number]; ammo: number; extra: number; reserve: number; resting: boolean; flags: number; weaponId: number; owner: number;
}

const f32bits = new DataView(new ArrayBuffer(4));
const fbits = (v: number) => (f32bits.setFloat32(0, v, true), f32bits.getUint32(0, true));
const bitsf = (v: number) => (f32bits.setUint32(0, v >>> 0, true), f32bits.getFloat32(0, true));

/** One SubHead.Grenade record: H 35 | H netIdx | C 1 | 30 B. */
export function encodeGrenade(netIdx: number, g: GrenadeSyncInfo): Uint8Array {
  return new PacketWriter(35).writeH(35).writeH(netIdx & 0xffff).writeC(SubHead.Grenade)
    .writeC(g.state & 0xff).writeC(g.owner & 0xff).writeC(netIdx & 0x0f).writeC(0).writeH(g.boomInfo ?? 0)
    .writeD(g.weaponId).writeC(g.accessory ?? 0).writeC(g.extensions ?? 0)
    .writeH(toHalf(g.pos[0])).writeH(toHalf(g.pos[1])).writeH(toHalf(g.pos[2]))
    .writeD(fbits(g.vel[0])).writeD(fbits(g.vel[1])).writeD(fbits(g.vel[2])).toBytes();
}
function readGrenade(r: PacketReader): GrenadeSyncInfo {
  const state = r.readC(), owner = r.readC();
  r.skip(2);
  const boomInfo = r.readH(), weaponId = r.readD(), accessory = r.readC(), extensions = r.readC();
  const pos: [number, number, number] = [fromHalf(r.readH()), fromHalf(r.readH()), fromHalf(r.readH())];
  const vel: [number, number, number] = [bitsf(r.readD()), bitsf(r.readD()), bitsf(r.readD())];
  return { state, owner, weaponId, accessory, extensions, pos, vel, boomInfo };
}

/** One SubHead.DroppedWeapon record: H 36 | H dropIdx | C 2 | 31 B. */
export function encodeDropped(dropIdx: number, d: DroppedWeaponInfo): Uint8Array {
  const w = new PacketWriter(36).writeH(36).writeH(dropIdx & 0xffff).writeC(SubHead.DroppedWeapon)
    .writeH(toHalf(d.pos[0])).writeH(toHalf(d.pos[1])).writeH(toHalf(d.pos[2]))
    .writeH(d.ammo & 0xffff).writeH(d.extra & 0xffff).writeH(d.reserve & 0xffff).writeH(d.resting ? 1 : 0)
    .writeC(d.flags & 0xff).writeD(d.weaponId).writeC(d.owner & 0xff);
  for (let i = 0; i < 11; i++) w.writeC(0);
  return w.toBytes();
}
function readDropped(r: PacketReader): DroppedWeaponInfo {
  const pos: [number, number, number] = [fromHalf(r.readH()), fromHalf(r.readH()), fromHalf(r.readH())];
  const ammo = r.readH(), extra = r.readH(), reserve = r.readH(), resting = r.readH() === 1;
  const flags = r.readC(), weaponId = r.readD(), owner = r.readC();
  return { pos, ammo, extra, reserve, resting, flags, weaponId, owner };
}

/**
 * DropWeapon / GetWeaponForClient body, 19 bytes (Server.Match DropWeapon.cs / GetWeaponForClient.cs):
 * H loaded | H extra (dual) | H reserve | H unk1..unk3 | C flags | D weaponId | C accessory | C extensions.
 * flags: gameplay/pbDrop.ts dropFlags (the server adds its drop counter on DropWeapon).
 */
export interface WeaponDropInfo {
  ammo: number; extra: number; reserve: number; flags: number; weaponId: number; accessory?: number; extensions?: number;
}

export interface ActionOut {
  actionState?: { action: number; value: number; weaponFlag: number };
  posRot?: PosRot;
  hp?: number;
  weapon?: { weaponId: number; accessory?: number; extensions?: number };
  fire?: FireInfo;
  hits?: HitInfo[];
  radio?: { id: number; area: number };
  /** never together with `weapon` (AllUtils.CheckDataFlags drops the WeaponSync flag but not its bytes) */
  drop?: WeaponDropInfo;
  pickup?: WeaponDropInfo;
  /** extra SubHead.Grenade records (idx = throw net index) */
  grenades?: { idx: number; g: GrenadeSyncInfo }[];
  /** extra SubHead.DroppedWeapon records (idx = drop index) */
  dropped?: { idx: number; d: DroppedWeaponInfo }[];
}

/** The User record of `a` followed by its Grenade / DroppedWeapon records (one datagram; the relays read <= 18 records). */
export function encodeActions(slot: number, a: ActionOut): Uint8Array {
  const recs = [encodeUserAction(slot, a)];
  for (const g of a.grenades ?? []) recs.push(encodeGrenade(g.idx, g.g));
  for (const d of a.dropped ?? []) recs.push(encodeDropped(d.idx, d.d));
  if (recs.length === 1) return recs[0];
  const out = new Uint8Array(recs.reduce((n, r) => n + r.length, 0));
  let o = 0;
  for (const r of recs) {
    out.set(r, o);
    o += r.length;
  }
  return out;
}

function writeDropInfo(w: PacketWriter, d: WeaponDropInfo): void {
  w.writeH(d.ammo & 0xffff).writeH(d.extra & 0xffff).writeH(d.reserve & 0xffff).writeH(0).writeH(0).writeH(0)
    .writeC(d.flags & 0xff).writeD(d.weaponId).writeC(d.accessory ?? 0).writeC(d.extensions ?? 0);
}
function readDropInfo(r: PacketReader): WeaponDropInfo {
  const ammo = r.readH(), extra = r.readH(), reserve = r.readH();
  r.skip(6);
  const flags = r.readC();
  const weaponId = r.readD();
  return { ammo, extra, reserve, flags, weaponId, accessory: r.readC(), extensions: r.readC() };
}

/** HitIndex bitfield (AllUtils.GetHitType/GetHitPart/GetHitDamageNormal). */
export function makeHitIndex(victimSlot: number, damage: number, part: number, objectType = 1): number {
  return ((damage & 0x7ff) << 21 | (part & 63) << 11 | (victimSlot & 0x1ff) << 2 | (objectType & 3)) >>> 0;
}

/** One SubHead.User record: H length | H slot | C 0 | D flags | events (wire order). */
export function encodeUserAction(slot: number, a: ActionOut): Uint8Array {
  const body = new PacketWriter(64);
  let flags = 0;
  if (a.actionState) {
    flags |= Ev.ActionState;
    body.writeH(a.actionState.action).writeC(a.actionState.value).writeC(a.actionState.weaponFlag);
  }
  if (a.posRot) {
    flags |= Ev.PosRotation;
    const p = a.posRot;
    body.writeH(angleToU16(p.yaw)).writeH(angleToU16(p.pitch)).writeH(p.area)
      .writeH(toHalf(p.z)).writeH(toHalf(p.x)).writeH(toHalf(p.y));
  }
  if (a.radio) {
    flags |= Ev.RadioChat;
    body.writeC(a.radio.id).writeC(a.radio.area);
  }
  if (a.weapon && !a.drop && !a.pickup) {
    flags |= Ev.WeaponSync;
    body.writeD(a.weapon.weaponId).writeC(a.weapon.accessory ?? 0).writeC(a.weapon.extensions ?? 0);
  }
  if (a.hp !== undefined) {
    flags |= Ev.HpSync;
    body.writeH(a.hp);
  }
  if (a.drop) {
    flags |= Ev.DropWeapon;
    writeDropInfo(body, a.drop);
  }
  if (a.pickup) {
    flags |= Ev.GetWeaponForClient;
    writeDropInfo(body, a.pickup);
  }
  if (a.fire) {
    flags |= Ev.FireData;
    const f = a.fire;
    body.writeC(f.effect).writeC(f.part).writeH(f.index).writeD(f.weaponId).writeC(0).writeC(0)
      .writeH(toHalf(f.x)).writeH(toHalf(f.y)).writeH(toHalf(f.z));
  }
  if (a.hits && a.hits.length) {
    flags |= Ev.HitData;
    body.writeC(a.hits.length);
    for (const h of a.hits) {
      body.writeT(h.start[0]).writeT(h.start[1]).writeT(h.start[2]);
      body.writeT(h.end[0]).writeT(h.end[1]).writeT(h.end[2]);
      body.writeT(h.end[0]).writeT(h.end[1]).writeT(h.end[2]);
      body.writeH(0).writeH(h.victimSlot).writeD(makeHitIndex(h.victimSlot, h.damage, h.part, h.objectType))
        .writeD(h.weaponId).writeC(0).writeC(0);
    }
  }
  const data = body.toBytes();
  return new PacketWriter(9 + data.length).writeH(9 + data.length).writeH(slot).writeC(0).writeD(flags).writeB(data).toBytes();
}

function readTV(r: PacketReader): [number, number, number] {
  const v = new DataView(r.data.buffer, r.data.byteOffset + r.pos, 12);
  r.skip(12);
  return [v.getFloat32(0, true), v.getFloat32(4, true), v.getFloat32(8, true)];
}

/**
 * Parses an S->C action stream. Only SubHead.User/StageInfoChara records are decoded; events are
 * read in the server's write order (MatchClient.Method0) and decoding of a record stops at the first
 * event whose layout we do not model (the record length still lets us skip to the next one).
 */
export function decodeActions(stream: Uint8Array): ActionIn[] {
  const out: ActionIn[] = [];
  const r = new PacketReader(stream);
  while (r.remaining >= 5) {
    const len = r.readH();
    const slot = r.readH();
    const sub = r.readC();
    if (sub === 0xff || len < 5 || r.pos - 5 + len > stream.length) break;
    const end = r.pos - 5 + len;
    if ((sub === 0 || sub === 8) && len >= 9) {
      const flags = r.readD();
      const a: ActionIn = { slot, flags };
      try {
        decodeEvents(new PacketReader(stream.subarray(r.pos, end)), flags, a);
      } catch { /* partial record: keep what we got */ }
      if (sub === SubHead.StageInfoChara) a.sub = sub;
      out.push(a);
    } else if (sub === SubHead.Grenade && len >= 35) {
      out.push({ slot, sub, flags: 0, grenade: readGrenade(new PacketReader(stream.subarray(r.pos, end))) });
    } else if (sub === SubHead.DroppedWeapon && len >= 36) {
      out.push({ slot, sub, flags: 0, dropped: readDropped(new PacketReader(stream.subarray(r.pos, end))) });
    }
    r.pos = end;
  }
  return out;
}

function decodeEvents(r: PacketReader, flags: number, a: ActionIn): void {
  const has = (f: number) => (flags & f) !== 0;
  // Server death event: HpSync | GetWeaponForHost only (PROTOCOL_EVENTS_ACTION type 2).
  if (flags === (Ev.HpSync | Ev.GetWeaponForHost) || flags === Ev.HpSync) {
    a.hp = r.readH();
    if (has(Ev.GetWeaponForHost)) {
      const deathType = r.readC();
      const killerSlot = r.readC();
      r.skip(6 + 4);
      a.death = { killerSlot, deathType, hitPart: r.readC() };
    }
    return;
  }
  if (has(Ev.ActionState)) a.actionState = { action: r.readH(), value: r.readC(), weaponFlag: r.readC() };
  if (has(Ev.Animation)) r.skip(8);
  if (has(Ev.PosRotation)) {
    const yaw = u16ToAngle(r.readH());
    const pitch = u16ToAngle(r.readH());
    const area = r.readH();
    const z = fromHalf(r.readH());
    const x = fromHalf(r.readH());
    const y = fromHalf(r.readH());
    a.posRot = { x, y, z, yaw, pitch: pitch > Math.PI ? pitch - 2 * Math.PI : pitch, area };
  }
  if (has(Ev.SoundPosRotation)) a.soundTime = new DataView(r.data.buffer, r.data.byteOffset + r.pos, 4).getFloat32(0, true), r.skip(4);
  if (has(Ev.UseObject)) r.skip(r.readC() * 4);
  if (has(Ev.ActionForObjectSync)) r.skip(2);
  if (has(Ev.RadioChat)) a.radio = { id: r.readC(), area: r.readC() };
  if (has(Ev.WeaponSync)) {
    a.weaponId = r.readD();
    r.skip(2);
  }
  if (has(Ev.WeaponRecoil)) r.skip(20 + 1 + 4 + 2);
  if (has(Ev.HpSync)) a.hp = r.readH();
  if (has(Ev.Suicide)) r.skip(r.readC() * (6 + 4 + 2 + 4));
  if (has(Ev.MissionData)) return; // layout not modelled
  if (has(Ev.DropWeapon)) a.drop = readDropInfo(r);
  if (has(Ev.GetWeaponForClient)) a.pickup = readDropInfo(r);
  if (has(Ev.FireData)) {
    const effect = r.readC();
    const part = r.readC();
    const index = r.readH();
    const weaponId = r.readD();
    r.skip(2);
    a.fire = { effect, part, index, weaponId, x: fromHalf(r.readH()), y: fromHalf(r.readH()), z: fromHalf(r.readH()) };
  }
  if (has(Ev.CharaFireNHitData)) return; // layout not modelled
  if (has(Ev.HitData)) {
    const n = r.readC();
    a.hits = [];
    for (let i = 0; i < n; i++) {
      const start = readTV(r);
      const end = readTV(r);
      readTV(r);
      r.readH();
      const objectId = r.readH();
      const idx = r.readD();
      const weaponId = r.readD();
      r.skip(2);
      a.hits.push({ start, end, victimSlot: objectId, damage: idx >>> 21, part: (idx >> 11) & 63, objectType: idx & 3, weaponId });
    }
  }
}
