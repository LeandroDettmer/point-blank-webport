// GM chat commands: Server.Game CommandManager (":name args" in lobby/room chat, 2384 types All/Lobby) with the ten
// ICommand classes of Data/Commands and PermissionXML (system_permissions + system_access_rights, keyed by Account.Access).
// The reply is PROTOCOL_LOBBY_CHATTING_ACK(0, 5, false, result); an exception answers CommandsExceptionError.
import { PacketWriter } from "../../../src/net/packet.ts";
import { pool } from "../db.ts";
import type { Account } from "../shared/account.ts";
import * as dao from "../shared/dao.ts";
import { loadBattlePass } from "../shared/data.ts";
import { ItemsModel, ItemCategory, ItemEquipType, getItemCategory } from "../shared/items.ts";
import { getGood, getGoodByItemId, loadShop } from "../shared/shop.ts";
import { getLabel } from "../shared/translation.ts";
import { pointCashAck } from "../auth/packets.ts";
import { seasonChallengeInfoAck } from "../auth/metaPackets.ts";
import * as gp from "./packets.ts";
import { grantItem } from "./progress.ts";
import { tryCreateItem } from "../shared/playerUtils.ts";
import { titlesTable } from "./profileHandlers.ts";
import { roomOf, endBattleByCommand } from "./roomHandlers.ts";
import { lobbyChatAck } from "./socialHandlers.ts";
import { PLAYER_HELP, tokenize } from "./chatGuard.ts";
import { applyMute, reportsSummary } from "./reports.ts";
import { bugsSummary } from "./bugReports.ts";
import { SlotState } from "./roomModel.ts";
import type { GameClient } from "./gameServer.ts";

const log = (m: string) => console.log(`${new Date().toISOString()} [gm-ts] ${m}`);
const send = (a: Account | null | undefined, b: Uint8Array) => (a?.connection as GameClient | null)?.session.send(b);

/** quoted[i]: args[i] was written "in quotes" (only filled for :player, see serverCommands) */
interface Command { command: string; description: string; permission: string; args: string; execute(args: string[], p: Account, quoted: boolean[]): Promise<string> | string }

/** Wired by gameServer.ts. */
export const gm = {
  online: (): Iterable<Account> => [],
  byPid: async (_p: bigint): Promise<Account | null> => null,
  byNick: async (_n: string): Promise<Account | null> => null,
  /** accounts.access_level now (null = no row); replaced by the unit tests */
  accessOf: async (pid: bigint): Promise<number | null> => {
    const x = (await pool.query(`SELECT access_level FROM accounts WHERE player_id=$1`, [String(pid)])).rows[0];
    return x ? Number(x.access_level) : null;
  },
};

// ---- PermissionXML -----------------------------------------------------------------------------------------------------
let rights = new Map<number, Set<string>>();
export async function loadPermissions(): Promise<void> {
  const names = new Map((await pool.query(`SELECT key, name FROM system_permissions ORDER BY key ASC`)).rows.map((x) => [Number(x.key), String(x.name)]));
  rights = new Map();
  for (const x of (await pool.query(`SELECT key FROM system_access_levels ORDER BY key ASC`)).rows) rights.set(Number(x.key), new Set());
  for (const x of (await pool.query(`SELECT level_key, permission_key FROM system_access_rights ORDER BY level_key ASC, permission_key ASC`)).rows) {
    const lv = Number(x.level_key);
    if (!rights.has(lv)) rights.set(lv, new Set());
    const n = names.get(Number(x.permission_key));
    if (n) rights.get(lv)!.add(n);
  }
  log(`${names.size} permissions, ${rights.size} levels`);
}
const havePermission = (p: Account, perm: string) => rights.get(p.access)?.has(perm) ?? false;

// ---- helpers -----------------------------------------------------------------------------------------------------------
/** ComDiv.ToTitleCase: title-cases the first word only. */
const titleCase = (t: string) => { const w = t.split(" ")[0].toLowerCase(), tc = w.replace(/(^|[^\p{L}\p{N}])(\p{L})/gu, (_m, a: string, b: string) => a + b.toUpperCase()); return t.replace(t.split(" ")[0], tc); };
/** int.Parse (throws like C# on bad input -> CommandsExceptionError). */
const parseInt32 = (s: string | undefined) => { const t = (s ?? "").trim(); if (!/^[+-]?\d+$/.test(t)) throw new Error(`FormatException: ${s}`); const n = Number(t); if (n > 2147483647 || n < -2147483648) throw new Error("OverflowException"); return n; };
const tryInt = (s: string | undefined) => (/^\s*[+-]?\d+\s*$/.test(s ?? "") && Math.abs(Number(s)) <= 2147483647 ? Number(s) : null);
const tryLong = (s: string | undefined) => (/^\s*[+-]?\d+\s*$/.test(s ?? "") ? BigInt(String(s).trim()) : null);
const lower = (s: string | undefined) => { if (s === undefined) throw new Error("IndexOutOfRangeException"); return s.toLowerCase(); };
const closeAccount = (a: Account, ms: number) => (a.connection as GameClient | null)?.session.close(true, ms);
const kickAck = () => new PacketWriter(24).writeH(2009).zeros(19).writeC(0).toBytes();
const rewardPopupAck = (target: Account, item: ItemsModel) => new PacketWriter(16).writeH(2430).writeH(0).writeH(target.inventory.items.length).writeC(1).writeD(item.id).toBytes();
/** the web client draws no announce popup (3079), so GM notices go as "Server" chat lines, one per line of text */
const toChat = (a: Account, text: string) => { for (const l of text.split(/\r?\n/)) if (l.trim()) send(a, lobbyChatAck(0, "Server", 5, false, l.trim().slice(0, 240))); };
const toAllChat = (text: string) => { for (const a of gm.online()) toChat(a, text); };

const WEAPONS = { AllWeapons: 511, AssaultRifle: 31, SubMachineGun: 47, SniperRifle: 79, ShotGun: 143, MachineGun: 271, RPG7: 511 }; // Data/CommandHelper.JSON "WeaponsFlag"
const PLAYTIME: Record<number, number> = { 5: 85, 10: 101, 15: 117, 20: 133, 25: 149, 30: 165 }; // "PlayTime" MinutesNN
const sys = { udpType: 3, debug: false, test: false, debugPing: false }; // ConfigLoader runtime toggles (no effect on the TS servers)
const UDP_NAMES = ["NONE", "RELAY", "RELAY_P2P", "RELAY", "CLIENT"];

/** Sets every title flag on `p` (online or loaded from the DB), saves it and, when connected, sends the 2383 titles packet. Returns how many were new. */
async function unlockAllTitles(p: Account): Promise<number> {
  const t = p.title;
  let n = 0;
  for (let id = 1; id <= 44; id++) {
    const m = titlesTable().get(id);
    if (m && (t.flags & m.flag) !== m.flag) { n++; t.flags |= m.flag; if (t.slots < m.slot) t.slots = m.slot; }
  }
  if (n > 0) {
    await dao.update1("player_titles", "slots", t.slots, "owner_id", p.playerId);
    await dao.update1("player_titles", "flags", t.flags.toString(), "owner_id", p.playerId);
    const w = new PacketWriter(32).writeH(2383).writeD(Number(p.playerId & 0xffffffffn)).writeQ(t.flags).writeC(t.equiped1).writeC(t.equiped2).writeC(t.equiped3).writeD(t.slots);
    send(p, w.toBytes());
  }
  return n;
}

/** :player title <nick|uid>: unlockAllTitles for another player; offline targets are saved and apply at the next login. */
async function executeTitle(target: string | undefined, isNick: boolean, p: Account): Promise<string> {
  if (!target) return "Usage: player title <nick|uid> (\"quotes\" for a nick with spaces or digits)";
  const uid = isNick ? null : tryLong(target);
  const label = uid !== null ? `UID: ${uid}` : `Nickname: ${target}`;
  const t = uid !== null ? await gm.byPid(uid) : await gm.byNick(target);
  if (!t) return `Player with ${label} doesn't Exist!`;
  if (t.playerId !== p.playerId && t.access > p.access) return `Title failed! (Can't Change Higher Access Level Than Yours)`;
  const n = await unlockAllTitles(t);
  const online = !!t.connection;
  if (n > 0 && online) toChat(t, `Todos os títulos foram liberados por ${p.nickname}.`);
  return `Title All Titles Opened To UID: ${t.playerId} (${t.nickname}) - ${n} new${online ? "" : " (offline, applies at next login)"}`;
}

/** ValuesCommand.ResolveItem: GoodsId, then ItemId, then a raw item id (>= 100000). */
function resolveItem(v: number): ItemsModel | null {
  const g = getGood(v) ?? getGoodByItemId(v);
  if (g) return g.item.clone();
  if (v < 100000) return null;
  return new ItemsModel(v, "Command Item", getItemCategory(v) === ItemCategory.Coupon ? ItemEquipType.Durable : ItemEquipType.Permanent, 1);
}
async function grantWithPopup(target: Account, item: ItemsModel): Promise<void> { send(target, rewardPopupAck(target, item)); await grantItem(target, item); }

async function saveBan(a: Account, days: number): Promise<bigint | null> {
  try {
    const r = await pool.query(`INSERT INTO base_ban_history(owner_id, player_id, type, value, reason, start_date, expire_date) VALUES($1, $1, 'ACCOUNT', $2, 'GM Command', $3, $4) RETURNING object_id`,
      [String(a.playerId), String(a.playerId), new Date(), new Date(Date.now() + days * 86400000)]);
    return BigInt(r.rows[0].object_id);
  } catch (e) { log(`SaveBanHistory: ${e}`); return null; }
}

/** `:help <command>` detail: syntax lines and examples per command [RECRIADO: the C# help only printed the one-line args] */
const HELP_DETAIL: Record<string, string[]> = {
  help: [":help [page] - list the commands you may run (5 per page)", ":help <command> - syntax and examples of one command"],
  endbattle: [":endbattle - ends the running battle of your room (you must be inside a started match)"],
  host: [
    ":host wpn <all|ar|smg|sr|sg|mg|rpg> - restrict the room weapons (room leader, in a room)",
    ":host time <minutes> - room play time (3, 5, 7, 10, 15, 20, 25, 30)",
    ":host compe <on|off> - competitive mode (room must have 3v3, 4v4 or 5v5 slots)",
    "e.g. :host wpn sr",
  ],
  sendmsg: [
    ":sendmsg room <text> - message to everyone in your room",
    ":sendmsg channel <text> - message to the lobby of your channel",
    ":sendmsg player <text> - message to every online player",
    "e.g. :sendmsg player Server restart in 5 minutes",
  ],
  roominfo: [
    ":roominfo time <n> - room time (before the match starts)",
    ":roominfo flags <n> - weapons flag (number)",
    ":roominfo killcam <0-255> - kill cam value",
  ],
  sys: [
    ":sys udp <1-4> - UDP mode",
    ":sys debug <0|1> | :sys test <0|1> | :sys ping <0|1> - debug / test / ping modes",
    ":sys reload <pase|classic_mode> - reload battle pass / classic mode",
    ":sys title all - unlock every title for yourself",
  ],
  teamcash: [":teamcash <red|blue> <cash> - gives cash to every player of a team in your room", "e.g. :teamcash red 1000"],
  title: [":title - unlock every title for yourself"],
  reports: [":reports - latest player reports", ":reports <nick> - reports of / against one nick (\"quotes\" for spaces)"],
  mute: [":mute <nick> <minutes> - silence a player in chat (1-43200); 0 lifts it", "e.g. :mute teste3 30"],
  bugs: [":bugs [n] - latest bug reports (n 1-20, default 5)"],
  refreshshop: [":refreshshop - reload the shop catalog and resend it to you"],
  player: [
    ":player gift <gold|cash|tags> <amount> <uid|nick> - give currency (e.g. :player gift gold 5000 teste3)",
    ":player gift item <goodsId> <uid|nick> - give an item",
    ":player kick <nick|uid> [seconds] - disconnect an online player (e.g. :player kick teste3)",
    ":player ban normal <days> <uid|nick> - ban for N days",
    ":player ban permanent <days> <uid|nick> - permanent ban (days is ignored, any number)",
    ":player title <nick|uid> - unlock every title of another player (online or offline; e.g. :player title teste3)",
    ":player xtx ci <goodsId|itemId> - give yourself an item; :player xtx cia <id> <uid|nick> - give one to another player",
  ],
};

// ---- the commands (Data/Commands, assembly order) ----------------------------------------------------------------------
const COMMANDS: Command[] = [
  {
    command: "endbattle", description: "End work in progress battle", permission: "moderatorcommand", args: "",
    execute(_a, p) {
      const r = roomOf(p);
      if (!r) return "A room is required to execute the command.";
      const s = r.getSlot(p.slotId);
      if (!r.isPreparing() || !(s && s.state >= SlotState.READY)) return "Oops! the battle hasn't started.";
      endBattleByCommand(r);
      return "Battle ended.";
    },
  },
  {
    command: "help", description: "Show available commands", permission: "helpcommand", args: "%page% (optional)",
    execute(a, p) {
      // one chat line per command: the web client does not draw the announce popup the C# server used here
      const line = (t: string) => send(p, lobbyChatAck(0, "Server", 5, false, t));
      const mine = COMMANDS.filter((c) => havePermission(p, c.permission));
      if (a.length !== 0 && tryInt(a[0]) === null) {
        const name = lower(a[0]).replace(/^:/, "");
        const c = mine.find((x) => x.command === name);
        if (!c) return `Command '${name}' not found. Use :help to list the commands.`;
        line(`:${c.command} - ${c.description}`);
        for (const l of HELP_DETAIL[c.command] ?? [`:${c.command} ${c.args}`]) line(l);
        return `Help of '${c.command}' displayed`;
      }
      let page = 1;
      if (a.length !== 0) { const n = tryInt(a[0]); page = n === null ? 1 : n === 0 ? 1 : n; }
      const pages = Math.trunc((mine.length + 5 - 1) / 5);
      if (page < 1 || page > pages) return `Please insert a valid page. Pages: ${pages}`;
      const chunk = mine.slice((page - 1) * 5, page * 5);
      line(`Commands (${page}/${pages}) - ":help <command>" shows syntax and examples:`);
      for (const c of chunk) line(`:${c.command} ${c.args} -> ${c.description}`);
      if (page === pages) { line("Comandos de jogador (todos), digite no chat:"); for (const l of PLAYER_HELP) line(l); }
      return `Displayed commands page '${page}' of '${pages}'`;
    },
  },
  {
    command: "host", description: "Change room options (AI Only)", permission: "hostcommand", args: "%options% %value%",
    execute(a, p) {
      const r = roomOf(p);
      if (!r) return "A room is required to execute the command.";
      if (r.leader !== p.slotId || r.slots[r.leader]?.playerId !== p.playerId) return "This Command Is Only Valid For Host (Room Leader).";
      const opt = lower(a[0]), val = lower(a[1]);
      switch (opt) {
        case "wpn": {
          const set = (f: number, msg: string) => { r.weaponsFlag = f; r.updateRoomInfo(); return msg; };
          switch (val) {
            case "all": return set(WEAPONS.AllWeapons, "All Weapons (AR, SMG, SR, SG, MG, SHD)");
            case "sg": return set(WEAPONS.ShotGun, "Weapon Shot Gun (Only)");
            case "sr": return set(WEAPONS.SniperRifle, "Weapon Sniper Rifle (Only)");
            case "rpg": return set(WEAPONS.RPG7, "Weapon RPG-7 (Only) - Hot Glitch");
            case "ar": return set(WEAPONS.AssaultRifle, "Weapon Assault Rifle (Only)");
            case "mg": return set(WEAPONS.MachineGun, "Weapon Machine Gun (Only)");
            case "smg": return set(WEAPONS.SubMachineGun, "Weapon Sub Machine Gun (Only)");
          }
          return set(WEAPONS.AllWeapons, "Weapon Default (Value Not Founded)");
        }
        case "time": {
          const m = parseInt32(val);
          if (PLAYTIME[m] !== undefined) { r.killTime = PLAYTIME[m]; r.updateRoomInfo(); return `${titleCase(opt)} ${m} Minutes`; }
          return `${titleCase(opt)} None! (Wrong Value)`;
        }
        case "compe":
          switch (val) {
            case "on": {
              const n = r.getSlotCount();
              if (n !== 6 && n !== 8 && n !== 10) return "Please change the slots to (3v3) or (4v4) or (5v5)";
              r.name = "Competitive!!!"; r.competitive = true;
              // AllUtils.SendCompetitiveInfo: the competitive rank table (Competitive.Rank()) is not ported, points only
              send(p, lobbyChatAck(p.session?.sessionId ?? 0, getLabel("Competitive"), p.nickColor, true, getLabel("CompetitiveRank", "-", p.competitive.points, 0)));
              return `${titleCase(opt)}titive Enabled!`;
            }
            case "off":
              r.name = ["Feel the Headshots!!", "Land of Dead!", "Kill! or be Killed!!"][Math.floor(Math.random() * 3)];
              r.competitive = false;
              return `${titleCase(opt)}titive Disabled!`;
            default: return `Unable to use Competitive command! (Wrong Value: ${val})`;
          }
        default: return `Command ${titleCase(opt)} was not founded!`;
      }
    },
  },
  {
    command: "sendmsg", description: "Send messages", permission: "moderatorcommand", args: "%options% %text%",
    execute(a, p) {
      const opt = lower(a[0]), text = a.slice(1).join(" ");
      switch (opt) {
        case "room": {
          const r = roomOf(p);
          if (!r) return "A room is required to execute the command.";
          for (const x of r.getAllPlayers()) toChat(x, text);
          return `Message sended to current Room Id: ${r.roomId + 1}`;
        }
        case "channel": {
          const ch = (p.connection as GameClient | null)?.channelOf(p) ?? null;
          if (!ch) return "Please run the command in the lobby.";
          for (const x of ch.lobbyPlayers) toChat(x, text);
          return `Message sended to current Channel Id: ${ch.id + 1}`;
        }
        case "player": {
          let n = 0;
          for (const x of gm.online()) { toChat(x, text); n++; }
          return `Message sended to ${n} total of player(s)`;
        }
        default: return `Command ${titleCase(opt)} was not founded!`;
      }
    },
  },
  {
    command: "roominfo", description: "Change room options", permission: "moderatorcommand", args: "%options% %value%",
    execute(a, p) {
      const r = roomOf(p);
      if (!r) return "A room is required to execute the command.";
      const opt = lower(a[0]), val = lower(a[1]);
      switch (opt) {
        case "time": {
          const n = parseInt32(val) * 6;
          if (n < 0) return `Oops! Map 'index' Isn't Supposed To Be: ${val}. Try an Higher Value.`;
          const s = r.getSlot(p.slotId);
          if (r.isPreparing() || (s && s.state >= SlotState.READY)) return "Oops! You Can't Change The 'time' While The Room Has Started Game Match.";
          r.killTime = n; r.updateRoomInfo();
          return `${titleCase(opt)} Changed To ${[3, 3, 3, 5, 7, 5, 10, 15, 20, 25, 30][r.killTime >> 4] % 60} Minutes`; // TIMES[KillTime >> 4] (throws past the table, like C#)
        }
        case "flags": { const f = parseInt32(val); r.weaponsFlag = f; r.updateRoomInfo(); return `${titleCase(opt)} Changed To ${f}`; }
        case "killcam": { const n = parseInt32(val); if (n < 0 || n > 255) throw new Error("OverflowException"); r.killCam = n; r.updateRoomInfo(); return `${titleCase(opt)} Changed To ${n}`; }
        default: return `Command ${titleCase(opt)} was not founded!`;
      }
    },
  },
  {
    command: "sys", description: "change server settings", permission: "developercommand", args: "%options% %value%",
    async execute(a, p) {
      const opt = lower(a[0]), val = lower(a[1]);
      const onOff = (k: "debug" | "test" | "debugPing", label: string) => {
        const f = parseInt32(val) === 1;
        if (f === sys[k]) return `${label} Mode Already Changed To: ${f ? "True" : "False"}`;
        sys[k] = f;
        return `${titleCase(opt)} Mode '${f ? "Enabled" : "Disabled"}'`;
      };
      switch (opt) {
        case "udp": {
          const n = parseInt32(val);
          if (n === sys.udpType) return `UDP State Already Changed To: ${sys.udpType}`;
          if (n < 1 || n > 4) return `Cannot Change UDP State To: ${n}`;
          sys.udpType = n;
          return `${titleCase(opt)} State Changed (${n} - ${UDP_NAMES[n]})`;
        }
        case "debug": return onOff("debug", "Debug");
        case "test": return onOff("test", "Test");
        case "ping": return onOff("debugPing", "Ping");
        case "reload":
          if (val === "pase") { await loadBattlePass(); send(p, seasonChallengeInfoAck(p)); return "Refresh CHALLENGE_INFO_ACK!"; }
          if (val === "classic_mode") return "Refresh Classic Mode Manager!";
          return `${titleCase(opt)} Opción de 'reload' no válida: ${val}. Use 'pase' o 'classic_mode'.`;
        case "title":
          if (val !== "all") return `${titleCase(opt)} Arguments was not valid!`;
          void unlockAllTitles(p);
          return `${titleCase(opt)} Successfully Opened!`;
        default: return `Command ${titleCase(opt)} was not founded!`;
      }
    },
  },
  {
    command: "teamcash", description: "Send cash to a team", permission: "gamemastercommand", args: "%team% %cash% (Team = FR/CT)",
    async execute(a, p) {
      const r = roomOf(p);
      if (!r) return "Please execute the command in a room";
      if (a.length !== 2) return "Please use correct command usage, :teamcash %team% %cash%";
      const v = tryInt(a[1]);
      if (v === null) return "Please use correct number as value";
      const team = a[0].toLowerCase();
      if (team !== "red" && team !== "blue") return "Please use correct team, 'red' or 'blue'";
      const t = team === "red" ? 0 : 1;
      for (let i = 0; i < 18; i++) {
        if (i % 2 !== t) continue;
        const s = r.slots[i];
        const x = s && s.playerId > 0n ? r.svc.getAccount(s.playerId) : null;
        if (x && (await dao.addMoney(x, 0, v))) send(x, pointCashAck(0, x)); // by delta, never x.cash + v from memory
      }
      return `'${v}' cash sended to team ${team}`;
    },
  },
  {
    command: "title", description: "Unlock all title", permission: "gamemastercommand", args: "",
    async execute(_a, p) { await unlockAllTitles(p); return "All title Successfully Opened!"; },
  },
  {
    command: "reports", description: "List player reports (of or against a nick)", permission: "moderatorcommand", args: "%nick% (optional, \"quotes\" for spaces)",
    async execute(a, p) {
      const nick = tokenize(a.join(" "))[0]?.value;
      toChat(p, await reportsSummary(nick));
      return nick ? `Reports of '${nick}' displayed` : "Latest reports displayed";
    },
  },
  {
    command: "mute", description: "Mute a player in chat (0 minutes = lift)", permission: "moderatorcommand", args: "%nick% %minutes%",
    async execute(a, p) {
      const tk = tokenize(a.join(" "));
      const minutes = tk.length >= 2 ? tryInt(tk[tk.length - 1].value) : null;
      if (minutes === null || minutes < 0 || minutes > 43200) return "Please use correct command usage, :mute %nick% %minutes% (0 to 43200)";
      const nick = tk.slice(0, -1).map((x) => x.value).join(" ");
      const t = await gm.byNick(nick);
      if (!t) return `Player with Nickname: ${nick} doesn't Exist!`;
      if (t.playerId === p.playerId) return "Can't mute yourself";
      if (t.access > p.access) return "Can't mute Higher Access Level Than Yours";
      await applyMute(t.playerId, minutes, `GM :mute by ${p.nickname}`);
      if (minutes === 0) { send(t, lobbyChatAck(0, "Server", 5, false, "Você pode falar no chat novamente.")); return `Player '${t.nickname}' has been un-muted`; }
      send(t, lobbyChatAck(0, "Server", 5, false, `Você foi silenciado por ${minutes} minutos por um moderador.`));
      toAllChat(`Player '${t.nickname}' has been muted for ${minutes} Minutes!`);
      return `Player '${t.nickname}' muted for ${minutes} Minutes`;
    },
  },
  {
    command: "bugs", description: "List the latest bug reports", permission: "moderatorcommand", args: "%n% (optional, default 5)",
    async execute(a, p) {
      const n = tryInt(a[0]) ?? 5;
      toChat(p, await bugsSummary(n));
      return `Latest ${Math.max(1, Math.min(20, n))} bug reports displayed`;
    },
  },
  {
    command: "refreshshop", description: "Send messages", permission: "gamemastercommand", args: "",
    async execute(_a, p) {
      await loadShop(); // C#: ShopManager.Reset + Load(1); the TS catalog builder needs both loads
      const c = p.connection as GameClient | null;
      if (c) { for (const b of gp.fullCatalog(p, true)) c.session.send(b); c.session.send(gp.saillistAck(true)); }
      return "Success Refresh shop";
    },
  },
  {
    command: "player", description: "modify value of player", permission: "gamemastercommand", args: "%options1% $options2% %value% %uid%",
    async execute(a, p, quoted) {
      if (a[0]?.toLowerCase() === "title") return executeTitle(a[1], !!quoted[1], p); // [RECRIADO] web build: unlock every title of another player
      const o1 = lower(a[0]), o2 = lower(a[1]);
      if (o1 === "xtx") return executeXtx(o2, a, p, quoted);
      const USAGE = "Usage: player gift <gold|cash|tags|item> <value|goodsId> <uid|nick> | player kick <nick|uid> <uid|nick> <seconds> | player ban <normal|permanent> <days> <uid|nick>";
      if (!o1) return USAGE;
      // [RECRIADO] shorthand for the web build: "player kick <nick|uid> [seconds]" -> "player kick nick|uid <seconds> <target>"
      if (o1 === "kick" && (quoted[1] || (o2 !== "uid" && o2 !== "nick"))) {
        if (!a[1]) return "Usage: player kick <nick|uid> [seconds]";
        a = ["kick", tryLong(a[1]) !== null && !quoted[1] ? "uid" : "nick", a[2] ?? "0", a[1]];
        quoted = [false, false, false, quoted[1]];
      }
      if (a[3] === undefined || tryInt(a[2]) === null) return USAGE;
      const val = parseInt32(a[2]);
      // a "quoted" target is always a nick: a player named "1001" must not turn a GM's ban / gift into one on UID 1001
      const uid = quoted[3] ? null : tryLong(a[3]), isUid = uid !== null;
      const who = () => (isUid ? `UID: ${uid}` : `Nickname: ${a[3]}`);
      const find = async () => (isUid ? await gm.byPid(uid!) : await gm.byNick(a[3]));
      switch (o1) {
        case "gift": {
          const t = await find();
          const money = async (col: "gold" | "cash" | "tags") => {
            if (!t) return `Player with ${who()} doesn't Exist!`;
            // by delta (a negative gift only takes what the row still holds); t's balance is read back
            if (!(await dao.addMoney(t, col === "gold" ? val : 0, col === "cash" ? val : 0, col === "tags" ? val : 0))) return `${titleCase(o1)} Command wrong or not founded!`;
            send(t, pointCashAck(0, t));
            return `${titleCase(o1)} ${val} Amount Of ${titleCase(o2)} To UID: ${t.playerId} (${t.nickname})`;
          };
          switch (o2) {
            case "gold": return money("gold");
            case "cash": return money("cash");
            case "tags": return money("tags");
            case "item": {
              if (!t) return `Player with ${who()} doesn't Exist!`;
              const g = getGood(val);
              if (!g) return `Goods Id: ${val} not founded!`;
              const item = g.item.clone();
              send(t, rewardPopupAck(p, item));
              // C#: the character check and CreateCharacter use the invoker (Player), the 3334 goes to the target (kept)
              if (Math.trunc(item.id / 100000) === 6 && !p.character.getCharacter(item.id)) await grantItem(p, item);
              else { await tryCreateItem(item, t); send(t, gp.inventoryGetInfoAck(0, t, [item])); }
              return `${titleCase(o1)} ${item.name} To UID: ${t.playerId} (${t.nickname})`;
            }
          }
          break;
        }
        case "kick": {
          const by = lower(a[1]); // not o2: the shorthand above rewrote a[1] to "uid" / "nick"
          const t = by === "uid" ? await gm.byPid(uid ?? -1n) : by === "nick" ? await gm.byNick(a[3]) : null;
          if (by !== "uid" && by !== "nick") break;
          const label = by === "uid" ? `UID: ${uid}` : `Nickname: ${a[3]}`;
          if (!t || !t.connection) return `Player with ${label} doesn't Exist!`;
          if (by === "uid" ? t.playerId === p.playerId : t.nickname === p.nickname) return `Player by ${label} failed! (Can't Kick Yourself)`;
          if (t.access > p.access) return `Player by ${label} failed! (Can't Kick Higher Access Level Than Yours)`;
          send(t, kickAck());
          closeAccount(t, (val * 1000) % 1000); // TimeSpan.FromSeconds(n).Milliseconds: the ms component (0 for whole seconds)
          return `${titleCase(o1)} Player by ${label} Executed in ${val} Seconds!`;
        }
        case "ban": {
          if (o2 !== "normal" && o2 !== "permanent") break;
          const t = await find();
          if (!t) return `Player with ${who()} doesn't Exist!`;
          if (t.playerId === p.playerId) return `Player by ${who()} failed! (Can't Ban Yourself)`;
          if (t.access > p.access) return `Player by ${who()} failed! (Can't Ban Higher Access Level Than Yours)`;
          const days = o2 === "normal" ? val : 999;
          const oid = await saveBan(t, days);
          if (oid === null) return `${titleCase(o1)} Command wrong or not founded!`;
          await dao.update1("accounts", "ban_object_id", oid.toString(), "player_id", t.playerId);
          toAllChat((o2 === "normal" ? `Player '${t.nickname}' has been banned for ${days} Day(s)!` : `Player '${t.nickname}' has been permanently Banned!`));
          t.banObjectId = oid;
          send(t, kickAck());
          closeAccount(t, 1000);
          return `${titleCase(o1)} ${who()} Success for ${days} Day(s)`;
        }
      }
      return `Command ${titleCase(o1)} was not founded!`;
    },
  },
];

async function executeXtx(o2: string, a: string[], p: Account, quoted: boolean[]): Promise<string> {
  switch (o2) {
    case "ci": {
      if (a.length < 3) return "Usage: player xtx ci <GoodsId|ItemId>";
      const v = tryInt(a[2]);
      if (v === null) return `Invalid value: ${a[2]}`;
      const it = resolveItem(v);
      if (!it) return `Goods/Item not found. '${v}' is neither a valid GoodsId nor ItemId.`;
      await grantWithPopup(p, it);
      return `Xtx ${it.name || it.id} to self (${p.nickname})`;
    }
    case "cia": {
      if (a.length < 4) return "Usage: player xtx cia <GoodsId|ItemId> <UID|Nick>";
      const v = tryInt(a[2]);
      if (v === null) return `Invalid value: ${a[2]}`;
      const uid = quoted[3] ? null : tryLong(a[3]);
      const t = uid !== null ? await gm.byPid(uid) : await gm.byNick(a[3]);
      if (!t) return `Player with ${uid !== null ? `UID: ${uid}` : `Nickname: ${a[3]}`} doesn't Exist!`;
      if (t.playerId === p.playerId) return "Use 'ci' to give items to yourself.";
      const it = resolveItem(v);
      if (!it) return `Goods/Item not found. '${v}' is neither a valid GoodsId nor ItemId.`;
      await grantWithPopup(t, it);
      return `Xtx ${it.name || it.id} To UID: ${t.playerId} (${t.nickname})`;
    }
  }
  return `Command Xtx ${o2} was not founded!`;
}

/** AllUtils.ServerCommands -> CommandManager.TryParse: true when the text was a command the player may run. */
export async function serverCommands(p: Account, text: string): Promise<boolean> {
  const reply = (t: string) => send(p, lobbyChatAck(0, "Server", 5, false, t));
  try {
    const t = text.trim();
    if (t.length === 0 || !t.startsWith(":")) return false;
    let name = t.slice(1), args: string[] = [], quoted: boolean[] = [];
    if (name.includes(" ")) { const parts = name.split(" "); name = parts[0]; args = parts.slice(1); }
    const cmd = COMMANDS.find((c) => c.command === name);
    if (!cmd || !havePermission(p, cmd.permission)) return false;
    // [web] the level of the login goes stale when the account is demoted in the DB: one read per command, fail closed
    const now = (await gm.accessOf(p.playerId)) ?? 0;
    if (now !== p.access) { log(`Player '${p.nickname}' (UID: ${p.playerId}) access ${p.access} -> ${now} (DB)`); p.access = now; }
    if (!havePermission(p, cmd.permission)) return false;
    if (name === "player") {
      // [RECRIADO] quote-aware for the targets: "nick with spaces" is one token and a quoted number stays a nick (the C# split on spaces)
      const rest = t.slice(1 + name.length), tk = tokenize(rest);
      args = tk.map((x) => x.value); quoted = tk.map((x) => rest[x.start] === "\"");
    }
    const result = await cmd.execute(args, p, quoted);
    reply(result);
    log(`Player '${p.nickname}' (UID: ${p.playerId}) Running Command '${text}'`);
    return true;
  } catch (e) {
    log(`command '${text}' by ${p.nickname}: ${(e as Error).message}`);
    reply(getLabel("CommandsExceptionError"));
    return true;
  }
}
