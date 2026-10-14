// Entry point: account screen (register/login via account-api) -> servers/channels -> lobby, inventory and shop -> room
// -> battle (main.ts startGame) -> room -> lobby. Lobby: the Point Blank Cross screens (src/lobby/screensCross, default);
// ?lobby=web = simple table lobby (LobbyScreen, test utility).
// ?play (or #play) skips straight to the map with local bots; ?manual shows the old token login form.
import "./assetBoot.ts"; // first: the production asset map hooks (no-op without VITE_ASSET_BASE)
import "./net/errorRing.ts"; // last 20 console errors for the bug report (/bug)
import { LobbyScreen, respawnEquipFor, type LobbyScreenOptions } from "./ui/lobbyScreen.ts";
import { aiSkill } from "./lobby/core/controller.ts";
import { showAccountScreen } from "./ui/accountScreen.ts";
import { installFullscreen } from "./ui/fullscreen.ts";
import { openDevLauncher, resetDevParams, takeDevSaved } from "./ui/devLauncher.ts";
import { hideBattleLoading } from "./game/battleLoading.ts";
import { loadMapIndex, mapFromRoomMapId, type MapId } from "./config.ts";
import type { PbBattleNet } from "./net/battle.ts";
import type { RoomClient } from "./net/roomClient.ts";
import type { GameHandle } from "./main.ts";
import type { PlayerStore } from "./lobby/screens/index.ts";
import { EquipSlot } from "./lobby/types.ts";
import { setBattlePrep } from "./game/battlePrep.ts";
import { missionPanelOn } from "./game/pbHud/missionHud.ts";
import { CHANNEL_TYPE_CLAN } from "./net/authClient.ts";
import { ClanClient } from "./net/clanClient.ts";
import type { MissionClient } from "./net/missionClient.ts";
import { installAssetCache } from "./cache/register.ts";
import { jsonOnce } from "./jsonOnce.ts";
import { getSettings } from "./gameplay/settings.ts";

installAssetCache(); // prod only: service worker + persistent storage + "browser keeps no cache" warning

/** Common surface boot.ts needs from every lobby flow (LobbyScreenCross default, LobbyScreen ?lobby=web). */
interface LobbyScreenLike {
  hide(): void;
  show(): void;
  readonly player: PlayerStore | null;
  /** the lobby's mission cards client of the Game connection (2017 lobby only): the match shows its tasks, never a 2nd client */
  readonly missions?: MissionClient | null;
  /** ChannelType of the channel the lobby session is in (2017 controller): the clan HUD of a clan match needs the clan channel */
  readonly channelType?: number | null;
  /** the room was adopted from the clan-war pairing (controller adoptClanRoom, 6930 / 3586): always a clan match */
  readonly clanPairing?: boolean | null;
}

/** Clan vs clan match (the clan HUD: Clan_On banner, Result clan block): a room of the clan channel with a clan seat on each side.
 *  [INFERIDO] The server's room.clanMatch (clanWarHandlers buildBattleRoom) is not sent to the client; this reads the same rule from the
 *  channel type and the seats' clan names. */
function isClanMatch(screen: LobbyScreenLike, room: RoomClient): boolean {
  if (screen.clanPairing === true) return true; // marked by the pairing that seated us (no protocol flag exists for it)
  if (screen.channelType !== CHANNEL_TYPE_CLAN) return false;
  const side = [false, false];
  for (const s of room.slots) if (s.clan && (s.team === 0 || s.team === 1)) side[s.team] = true;
  return side[0] && side[1];
}

// ROOM_CREATE killTime nibbles (see CreateRoomOptions.killTime in src/net/roomClient.ts).
const KILLS = [15, 30, 50, 60, 80, 100, 120, 140, 160];
const TIMES_MIN = [3, 3, 3, 5, 7, 5, 10, 15, 20, 25, 30];
const ROUNDS = [1, 2, 3, 5, 7, 9]; // server RoomModel ROUNDS (killTime & 15 in round modes)
const ROOM_BOMB = 8; // RoomCondition.Bomb (Bomb Mission)
/** round modes of the match config (rounds from the room's killTime): RoomCondition -> match.cfg.mode */
const ROUND_MATCH_MODE: Record<number, "BOMB" | "DESTROY" | "DEFENCE" | "ANNIHILATION" | "ACE"> = { 8: "BOMB", 12: "DESTROY", 16: "ANNIHILATION", 20: "DEFENCE", 32: "ACE" };

let busy = false; // a game is loading or running (one canvas at a time)

function fatal(err: unknown): void {
  console.error(err);
  const hud = document.getElementById("hud");
  if (hud) hud.textContent = `Fatal error: ${err}`;
}

/** "Testar mapa" / ?play: offline map with bots. `map` + a lobby `screen` is "Treino com bots" from Criar Sala
 * [RECRIADO]: same as ?play, on the room's chosen map, with a "Sair da partida" button back to the lobby.
 * With a logged-in `screen.player`, the first life and the T panel use the account's real inventory/loadout/chara
 * (same as playBattle) instead of testLoadout.ts's fixed test set. */
/** ?play=all: every base weapon complete in 2017 (weapons/complete-cross.json via testLoadout.ts completeOnly), for
 * the panel T stress test. testLoadout.ts's short TEST_WEAPONS list stays the plain ?play default. */
async function allWeaponsInventory(): Promise<{ inventory: import("./game/respawnSelect.ts").RespawnInventory; defaults: { primary: number; secondary: number; melee: number; grenade: number; special: number } }> {
  const [{ catalogFromWeapons, localTestInventory, RESPAWN_SLOTS }, { completeOnly }, weapons, models, complete] = await Promise.all([
    import("./game/respawnSelect.ts"),
    import("./game/testLoadout.ts"),
    jsonOnce<{ weapons: { id: number; slot: number; className: string; name: string }[]; defaultLoadout: { primary: number; secondary: number; melee: number; grenade: number } }>("/assets/cross/weapons/weapons.json"),
    fetch("/assets/weapons/models/index.json").then((r) => r.json()) as Promise<{ weapons: { itemIds?: number[] }[] }>,
    // only weapons complete in the Cross export (pb-extract-tools audit-weapons-cross.mjs); missing file = no filter
    fetch("/assets/weapons/complete-cross.json").then((r) => (r.ok ? r.json() : null)).catch(() => null) as Promise<{ complete: number[] } | null>,
  ]);
  const catalog = catalogFromWeapons(weapons.weapons);
  let inventory = localTestInventory(weapons.defaultLoadout, models, catalog);
  if (complete) inventory = completeOnly(inventory, complete.complete, (id) => RESPAWN_SLOTS[(catalog(id)?.slot ?? 0) - 1] ?? null);
  const e = inventory.equipped;
  return { inventory, defaults: { primary: e.primary, secondary: e.secondary, melee: e.melee, grenade: e.grenade, special: e.special } };
}

function playLocal(screen?: LobbyScreenLike, map?: MapId, allWeapons?: boolean, bots?: { botCount: number; botSkill: number }, allItems?: boolean, fist?: boolean): void {
  if (busy) return;
  busy = true;
  screen?.hide();
  const player = screen?.player;
  let handle: GameHandle | null = null;
  let ended = false;
  const finish = () => {
    if (ended) return;
    ended = true;
    handle?.stop();
    handle = null;
    busy = false;
    resetDevParams(takeDevSaved()); // the test params (F2 launcher or typed in the URL) end with the match
    screen?.show();
  };
  void loadMapIndex()
    .then(() => Promise.all([
      import("./main.ts"),
      import("./game/respawnSelect.ts"),
      import("./game/loadout.ts"),
      allWeapons ? allWeaponsInventory() : null,
    ]))
    .then(([{ startGame }, { inventoryFromPlayer }, { itemEffectsOf, allItemEffects }, all]) => startGame({
      map,
      respawnInventory: all ? all.inventory : player ? inventoryFromPlayer(player) : undefined,
      localChara: player?.teamCharas().red || undefined, // no room/side offline: red-side chara
      localRank: player?.state.profile?.rank,
      itemEffects: allItems ? allItemEffects() : player ? itemEffectsOf(player.items(), player.equipPairs()[EquipSlot.Beret]?.itemId) : undefined,
      botCount: bots?.botCount,
      botSkill: bots?.botSkill,
      onLeave: screen ? finish : undefined,
    }).then((h) => ({ h, all })))
    .then(({ h, all }) => {
      if (ended) { h.stop(); return; }
      handle = h;
      // Local mode only auto-equips testLoadout.ts's TEST_EQUIPPED when no respawnInventory was given (game.ts);
      // with a real player inventory, or ?play=all's full one, set the first life's weapons ourselves (playBattle below).
      const w = all ? all.defaults : player?.weaponLoadout();
      const ws = (h.game.weapons as { ws?: { setLoadout(ids: Record<string, number>): void } }).ws;
      // ?play=fist: the Clube da Luta loadout (respawnSelect enforceRoomWeapons KNUCKLE_STAGE) to test the bare fist offline;
      // an explicit 0 keeps a slot empty
      if (fist && ws) { ws.setLoadout({ primary: 0, secondary: 0, melee: 323001, grenade: 0 }); return; }
      if (w && ws) ws.setLoadout(Object.fromEntries(Object.entries({ primary: w.primary, secondary: w.secondary, melee: w.melee, grenade: w.grenade, special: w.special }).filter(([, id]) => id > 0)));
    })
    .catch((err) => { finish(); fatal(err); });
}

/** Room battle went live: load the room's map with the Match UDP adapter; ENDBATTLE / kick / leave -> back to the room. */
function playBattle(screen: LobbyScreenLike, net: PbBattleNet, room: RoomClient): void {
  if (busy) return;
  busy = true;
  screen.hide();
  const slot = net.link.session.slot;
  const kt = room.room?.killTime ?? 0x63;
  let handle: GameHandle | null = null;
  let ended = false;
  const prevCloseRef: { fn: ((reason: string) => void) | null } = { fn: room.game.conn.onClose };

  const prevEnd = room.onEndBattle;
  const prevKick = room.onKicked;
  const prevDeath = room.onDeath;
  const finish = () => {
    if (ended) return;
    ended = true;
    room.onEndBattle = prevEnd;
    room.onKicked = prevKick;
    room.onDeath = prevDeath;
    if (room.game.conn.onClose !== prevCloseRef.fn) room.game.conn.onClose = prevCloseRef.fn;
    handle?.stop();
    handle = null;
    busy = false;
    hideBattleLoading();
    screen.show();
  };
  // ENDBATTLE: the end-of-match screen (GameResult) first, the room after its button / countdown; a give-up leaves at once
  room.onEndBattle = (e) => {
    prevEnd?.(e);
    const g = handle?.game;
    if (e.left || !g) { finish(); return; }
    const rounds = e.frRounds !== undefined;
    // clan block of the end screen: the 5140 own record (grade, emblem); points come from the clan detail (801) once the server wrote them
    const clan = e.clan && e.clan.id > 0 && isClanMatch(screen, room) ? e.clan : null;
    g.showFinal({
      winner: e.winner, red: rounds ? e.frRounds! : e.frKills ?? 0, blue: rounds ? e.ctRounds! : e.ctKills ?? 0,
      exp: e.exp ?? null, gold: e.gold ?? null, // per room slot: the end screen shows every row's own
      clan: clan ? { name: clan.name, rank: clan.rank, logo: clan.logo } : null,
    }, finish);
    if (clan) {
      const cc = new ClanClient(room.game.conn);
      void cc.detail(clan.id).then((c) => { if (c.ok && c.data) g.setFinalClanPoints(c.data.points); }).catch(() => {}).finally(() => cc.dispose());
    }
  };
  room.onKicked = (why) => { prevKick?.(why); finish(); };
  // the connection to the game server dropped mid-battle: leave the match and let the lobby show its "connection lost" notice (the game
  // used to stay up on a dead link, the lobby screen with the message being hidden behind it)
  const conn = room.game.conn, prevClose = conn.onClose;
  conn.onClose = (why) => { prevClose?.(why); if (!ended) { console.warn(`[battle] connection to the game server lost: ${why}`); finish(); } };
  // AI room: the bots are simulated in ONE client, the P2P match host (game.ts Bot on slot ids, net/battle.ts sendBotStates), and
  // replicated to the others as slot records; Server.Game knows no AI slot, so its DEATH scores miss the bot kills. Every peer
  // gets the same kill events (the dead-state mark of the slot), so each local match keeps the same score.
  const botRoom = room.isBotRoom;
  room.onDeath = (d) => { prevDeath?.(d); if (!botRoom) handle?.game.setScore(d.frKills, d.ctKills); };

  // Original lobby: inventory + equipped loadout (6150/3082) for the respawn weapon change (T) and the first life.
  const player = screen.player;
  void loadMapIndex()
    .then(() => Promise.all([import("./main.ts"), import("./game/respawnSelect.ts"), import("./game/loadout.ts")]))
    .then(([{ startGame }, { inventoryFromPlayer }, { itemEffectsOf }]) => startGame({
      net,
      respawnInventory: player ? inventoryFromPlayer(player) : undefined,
      // ?: the side's equipped character (same pick as the RESPAWN pair 8, respawnEquipFor) + Quick Change items
      localChara: player ? (slot % 2 === 0 ? player.teamCharas().red : player.teamCharas().blue) || undefined : undefined,
      itemEffects: player ? itemEffectsOf(player.items(), player.equipPairs()[EquipSlot.Beret]?.itemId) : undefined,
      // mission panel / Tab list / "Task Completed": the lobby's MissionClient (2359 / 2361 keep coming on the Game connection)
      missions: screen.missions ?? undefined,
      missionPanel: missionPanelOn(room.room?.roomType ?? 4),
      // stage type = STAGE_ID >> 24 = roomType >> 2 (missionHud.ts): the mission HUD's Y0 (stageY0 in crossScore.ts)
      stageType: (room.room?.roomType ?? 4) >> 2,
      // HeadHunter / Chaos: the room rule decides the damage of every hit (damage.ts ruleDamage)
      room: room.room ? { rule: room.room.rule, roomType: room.room.roomType } : undefined,
      clanMatch: isClanMatch(screen, room),
      map: mapFromRoomMapId(room.room?.mapId ?? 4),
      localTeam: (slot % 2) as 0 | 1,
      localName: room.slots[slot]?.nick || `slot ${slot + 1}`,
      localRank: player?.state.profile?.rank,
      // AI room: AiCount enemies on the other team at AiLevel (lobby2017 aiSkill); guests don't know AiCount yet -> 8.
      // botAllies [RECRIADO]: leader-local choice (room.ai.allies, never sent to the server); guests default to 0.
      ...(botRoom ? { botCount: (room.ai?.count ?? 8) + (room.ai?.allies ?? 0), botSkill: aiSkill(room.ai?.level ?? 1), botAllies: room.ai?.allies ?? 0 } : {}),
      // Server owns the round: kill goal ends it there, the leader's clock ends it via TIMERSYNC 0.
      // Bomb Mission: the rounds are the room's ROUNDS count, the server ends each one (5155) and restarts it (5153)
      match: ROUND_MATCH_MODE[room.room?.roomType ?? -1]
        ? { mode: ROUND_MATCH_MODE[room.room!.roomType], roundLimit: ROUNDS[kt & 15] ?? 3, killLimit: 0, timeLimit: (TIMES_MIN[(kt >> 4) & 15] ?? 3) * 60, endScreen: Infinity }
        : { killLimit: KILLS[kt & 15] ?? 60, timeLimit: (TIMES_MIN[(kt >> 4) & 15] ?? 10) * 60, endScreen: Infinity },
      onMatchEnd: () => { if (room.isLeader) room.timerSync(0); },
      onLeave: (reason) => {
        room.giveUp();
        room.onEndBattle?.({ winner: 2, left: true, away: reason === "away" }); // GIVEUPBATTLE_ACK only: close the battle locally (RoomScreen + game)
      },
    }))
    .then((h) => {
      hideBattleLoading(); // the curtain (game/battleLoading.ts) stayed up from START until the game is ready
      if (ended) { h.stop(); return; } // ENDBATTLE arrived while the map was loading
      handle = h;
      // First life: the server spawned us with the equipped weapons (RESPAWN 5137, lobbyScreen respawnWithLoadout);
      // show the same ones (later lives go through the respawn menu, which starts from the same loadout).
      // (Sniper / Shotgun / Knife rooms: the barred weapons already swapped, same as respawnWithLoadout)
      const e = player ? respawnEquipFor(player, slot, undefined, room.room?.weaponsFlag, room.room?.stage) : null;
      const ws = (h.game.weapons as { ws?: { setLoadout(ids: Record<string, number>): void } }).ws;
      // Room weapon limit: a barred slot arrives as 0 and must stay empty. setLoadout fills a missing slot with the
      // default weapon, an explicit 0 leaves it empty (`ids.x ?? default`).
      const limited = ((room.room?.weaponsFlag ?? 0x1ff) & 0x1ff) !== 0x1ff;
      if (e && ws) ws.setLoadout(Object.fromEntries(Object.entries({ primary: e[0].itemId, secondary: e[1].itemId, melee: e[2].itemId, grenade: e[3].itemId, special: e[4].itemId }).filter(([k, id]) => id > 0 || (limited && k !== "special"))));
    })
    .catch((err) => {
      console.error("[boot] battle start failed", err);
      hideBattleLoading();
      room.giveUp();
      room.onEndBattle?.({ winner: 2, left: true });
    });
}

/**
 * Room battle between LOADING_START and PRESTART (ui/roomScreen.ts via game/battlePrep.ts): the room's map and the match set
 * (every slot's weapons, character and head gear, the bots' weapon in an AI room) load behind the curtain (main.ts
 * prepareGame), so playBattle's startGame after STARTBATTLE + RESPAWN finds them ready.
 */
async function prepareBattle(screen: LobbyScreenLike, room: RoomClient): Promise<void> {
  if (busy) return; // a game is still up (end screen): playBattle will not take this battle either
  const slot = room.mySlot;
  // the other slots' USER_EQUIPMENT 3667 comes right after the LOADING_START ack, which resolved first: let it land
  const others = room.slots.filter((s) => s.state >= 12 && s.slot !== slot && s.nick);
  for (let t = 0; t < 1500 && others.some((s) => !room.equipAcks.has(s.slot)); t += 50) await new Promise((r) => setTimeout(r, 50));
  const player = screen.player;
  const team = (slot % 2) as 0 | 1;
  const e = player ? respawnEquipFor(player, slot, undefined, room.room?.weaponsFlag, room.room?.stage) : null; // what the first RESPAWN sends
  const localWeapons = e ? e.slice(0, 5).map((p) => p.itemId) : [];
  const localChara = player ? (team === 0 ? player.teamCharas().red : player.teamCharas().blue) || undefined : undefined;
  const acks = [...room.equipAcks.values()];
  const set = {
    weapons: [...localWeapons, ...acks.flatMap((a) => Object.values(a.weapons) as number[])],
    charas: [
      { itemId: localChara, team, equip: e ? { head: e[EquipSlot.Head]?.itemId, face: e[EquipSlot.Face]?.itemId, beret: e[EquipSlot.Beret]?.itemId } : undefined },
      ...acks.map((a) => ({ itemId: a.chara, team: (a.slot % 2) as 0 | 1, equip: { head: a.parts[0], face: a.parts[1], beret: a.beret } })),
    ],
    local: { chara: localChara, team, weapons: localWeapons },
    bomb: room.room?.roomType === ROOM_BOMB,
  };
  const [m] = await Promise.all([import("./main.ts"), loadMapIndex()]);
  await m.prepareGame(mapFromRoomMapId(room.room?.mapId ?? 4), set, room.isBotRoom);
}

if (import.meta.env.DEV) void import("./dev/clickDiag.ts").then((m) => m.installClickDiag());
installFullscreen(); // Alt+Enter: fullscreen toggle (ui/fullscreen.ts)
const params = new URLSearchParams(location.search);
// Default = login/lobby flow. ?playtest (or ?play, #play) = straight into a local match with bots;
// ?playtest=all = every weapon + every battle item (Quick Change, Respawn, HP/Defense/Ammo coupons...) active.
// ?play=fist = the same local match with the Clube da Luta loadout (bare fist 323001 only)
if (params.has("playtest") || params.has("play") || location.hash === "#play") {
  const all = params.get("playtest") === "all" || params.get("play") === "all";
  playLocal(undefined, undefined, all, undefined, all, params.get("play") === "fist");
} else if (params.has("manual")) {
  // token form (no account-api session): the simple table lobby (the 2017 flow needs a session)
  openLobby();
} else {
  // login: the account card (ui/accountScreen.ts) on the Point Blank Cross login art
  void showAccountScreen().then((session) => openLobby(session)).catch(fatal);
}

function openLobby(session?: LobbyScreenOptions["session"]): void {
  // ?lobby= in the URL wins; without it, Configuração > Interface (settings.lobbyUi, read once per load)
  const variant = params.get("lobby") ?? getSettings().lobbyUi;
  let screen: LobbyScreenLike;
  // F2 in the lobby: offline test launcher (ui/devLauncher.ts)
  window.addEventListener("keydown", (e) => {
    if (e.code !== "F2" || busy) return;
    e.preventDefault();
    if (document.getElementById("pbdevl")) document.getElementById("pbdevl")!.remove();
    else void loadMapIndex().then(() => openDevLauncher((map) => playLocal(screen, map)));
  });
  const onBattle = (net: PbBattleNet, room: RoomClient) => playBattle(screen, net, room);
  setBattlePrep({ run: (room) => prepareBattle(screen, room), discard: () => void import("./main.ts").then((m) => m.discardPrepared()) });
  if (variant === "web" || !session) {
    screen = new LobbyScreen({ onPlay: () => playLocal(screen), onBattle, session });
  } else {
    // the lobby controller (core/controller.ts: state and protocol only) drawn with the Point Blank Cross i3Gui windows (lobby/screensCross)
    void import("./lobby/screensCross/app.ts").then((m) => { screen = new m.LobbyScreenCross({ session, onBattle, onLocalPlay: (map, bots) => playLocal(screen, map, false, bots) }); }).catch(fatal);
  }
}
