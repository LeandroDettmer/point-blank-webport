// Room screen (inside the lobby card): slots by team, change team, ready / start, then drives the
// battle bootstrap (LOADING_START -> PRESTARTBATTLE -> Match UDP -> STARTBATTLE -> RESPAWN) and
// hands a connected PbBattleNet (NetAdapter) to `onBattle`. See src/net/roomClient.ts.
import type { GameClient } from "../net/gameClient.ts";
import type { PacketReader } from "../net/packet.ts";
import { RoomClient, ROOM_STATE_NAMES, RoomState, WIRE_READY, mapName, slotStateName, type EndBattleInfo } from "../net/roomClient.ts";
import { PbBattleNet } from "../net/battle.ts";
import { defaultServerUrl } from "../net/connection.ts";
import { watchRespawnEquip, type RespawnAckSource } from "../game/charEquip.ts";
import { setBattleProgress } from "../game/battleLoading.ts";
import { discardBattlePrep, runBattlePrep } from "../game/battlePrep.ts";
import { AVAILABLE_MAPS, MAP_LABELS, loadMapIndex, mapIndexEntry } from "../config.ts";
import { RoomCountdown, type Rgba } from "./roomCountdown.ts";
import { playUiSound } from "./uiClick.ts";
import { tOr } from "../lobby/ui/i18n.ts";

/** Room preset offered on "Criar sala": TDM (Rules.xml Mode 1: Rule 0, Stage 1, Conditions 4) on a
 * given server mapId, named from the exported maps index. */
export interface RoomPreset {
  mapId: number;
  mapName: string;
  rule: number;
  stage: number;
  roomType: number;
  /** AI room (stage 2): AiCount / AiLevel of ROOM_CREATE_REQ. `allies` [RECRIADO]: leader-local bots on the
   * player's own team, never sent to the server (see net/roomClient.ts CreateRoomOptions.ai). */
  ai?: { count: number; level: number; allies?: number };
  /** RoomWeaponsFlag of the mode (lobby core roomModes.ts); default 0x1ff = every weapon */
  weaponsFlag?: number;
  /** kills/time nibbles (CreateRoomOptions.killTime); default 0x63 = 60 kills / 10 min */
  killTime?: number;
  /** password (max 4 chars), entry restriction, observer rules byte, random-map stage flag + mask, slot count (ROOM_CREATE_REQ) */
  password?: string; limit?: number; watchRule?: number; flag?: number; randomMaps?: Uint8Array; slots?: number;
}

/** Server maps valid for Death Match (Matches.xml Match Rule="1"); ROOM_CREATE_REQ itself does not
 * validate maps, but this is the mode the room preset tiles are for. */
const TDM_SERVER_MAP_IDS = new Set([
  1, 2, 3, 4, 5, 6, 7, 9, 10, 11, 12, 18, 20, 21, 22, 23, 26, 27, 28, 29, 32, 33, 34, 35, 36, 37, 41, 42, 65, 67, 69,
  105, 106, 107, 118, 119, 134, 136, 123, 139,
]);

const DEFAULT_MAP_ID = "nstation";

/** Maps offered on "Criar sala" (M. Station first/default): 2017-exported maps whose server mapId
 * is valid for Death Match/TDM, deduped by mapId. Built lazily so it reflects loadMapIndex(). */
function buildRoomPresets(): RoomPreset[] {
  const seenMapIds = new Set<number>();
  const presets: RoomPreset[] = [];
  const ids = AVAILABLE_MAPS.includes(DEFAULT_MAP_ID) ? [DEFAULT_MAP_ID, ...AVAILABLE_MAPS.filter((id) => id !== DEFAULT_MAP_ID)] : AVAILABLE_MAPS;
  for (const id of ids) {
    const e = mapIndexEntry(id);
    if (e?.mapId == null || !TDM_SERVER_MAP_IDS.has(e.mapId) || seenMapIds.has(e.mapId)) continue;
    seenMapIds.add(e.mapId);
    presets.push({ mapId: e.mapId, mapName: MAP_LABELS[id] ?? e.name, rule: 0, stage: 1, roomType: 4 });
  }
  return presets;
}

export interface RoomScreenHost {
  render(title: string, sub: string, ...body: Node[]): void;
  status(msg: string, err?: boolean): void;
  /** Loading curtain while the battle starts (caption per step; null = remove it). The caller keeps it up until onBattle. */
  loading?(caption: string | null): void;
  /** Back to the lobby (room already left). */
  onLeave(): void;
  /** Battle is live: plug `net` into the game loop. Call `end()` to leave the match early. */
  onBattle?(net: PbBattleNet, room: RoomClient): void;
  serverUrl?: string;
  /** Account PlayerId (LOGIN_ACK); its low byte goes in every Match UDP header. */
  playerId: bigint;
  /** start countdown (5126, roomCountdown.ts): a system line of the chat box in its {col} colour; without it the line goes to status */
  notice?(text: string, color: Rgba | null): void;
  /** a message box over the room (OK only) */
  popup?(text: string): void;
  /** the countdown lock of the room (0x8f0530): top menu, MyInfo, room info and the team frame except btnStart take no input */
  lockRoom?(on: boolean): void;
  /** a menu (inventory / shop / profile / clan) is open over the room: countdown events are dropped (0x8f2e0b) */
  subPhase?(): boolean;
}

const TEAM = ["FR (vermelho)", "CT (azul)"];
/** longest wait for the match preload before PRESTARTBATTLE (server kick: 90 s after LOADING_START); the rest loads after it */
const PREP_CAP_MS = 25000;
/** STARTBATTLE_ACK wait: the server answers once the leader and most of each team are ready, so a player who loaded fast
 * waits here for the slowest one's preload (up to PREP_CAP_MS) */
const STARTBATTLE_WAIT_MS = 45000;

/** loading curtain captions of the battle start (the 2017 lobby host shows them; the legacy screen uses host.status) */
export const BATTLE_CAPTION = {
  start: "Iniciando a partida...\nAguarde um momento.",
  load: "Carregando a partida...\nAguarde um momento.",
  connect: "Conectando na partida...\nAguarde um momento.",
  wait: "Aguardando os outros jogadores...",
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...kids: (Node | string)[]) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  for (const k of kids) e.append(k);
  return e;
}

function button(label: string, onClick: () => void, cls = ""): HTMLButtonElement {
  const b = el("button", cls ? { class: cls } : {}, label);
  b.onclick = onClick;
  return b;
}

/** NOT ORIGINAL: warm the game chunk (main.ts + vendor-three / vendor-rapier, 2 MB wasm) while the room is open, idle and
 *  once, so the battle start does not wait for the download. Same specifier boot.ts uses: the browser keeps one module. */
let gameChunkWarm = false;
function preloadGameChunk(): void {
  if (gameChunkWarm) return;
  gameChunkWarm = true;
  const go = () => { void import("../main.ts").catch(() => { gameChunkWarm = false; }); };
  if (typeof requestIdleCallback === "function") requestIdleCallback(go, { timeout: 5000 });
  else setTimeout(go, 1500);
}

export class RoomScreen {
  readonly room: RoomClient;
  net: PbBattleNet | null = null;
  private host: RoomScreenHost;
  private phase: "room" | "starting" | "battle" | "result" = "room";
  private lastResult: EndBattleInfo | null = null;
  private busy = false;
  /** the room's start countdown (5126); driven by cdTick while it counts */
  readonly countdown: RoomCountdown;
  private cdTick: ReturnType<typeof setInterval> | null = null;

  private constructor(game: GameClient, host: RoomScreenHost) {
    this.host = host;
    preloadGameChunk();
    this.room = new RoomClient(game);
    this.room.onChange = () => { if (this.phase !== "starting") this.draw(); };
    this.room.onRulesChanged = () => { if (this.phase === "room") this.host.status("O líder alterou as regras da sala. Se você estava pronto, confirme Pronto novamente.", true); };
    this.room.onStartGame = () => void this.bootstrapBattle();
    this.countdown = new RoomCountdown({
      notice: (t, c) => (host.notice ? host.notice(t, c) : t.trim() && host.status(t)),
      lock: (on) => host.lockRoom?.(on),
      sound: (f) => playUiSound(f),
      subPhase: () => host.subPhase?.() ?? false,
    }, () => this.room.isLeader);
    this.room.onCountdown = (n) => this.onCountdown(n);
    this.room.onEndBattle = (e) => this.onEnd(e);
    this.room.onKicked = (why) => { this.host.status(`Expulso da partida: ${why}`, true); this.stopNet(); this.phase = "room"; this.draw(); };
  }

  /** Without `preset` the host card first shows a map picker (M. Station default, Metro); "Voltar" rejects. */
  static async create(game: GameClient, host: RoomScreenHost, name: string, preset?: RoomPreset): Promise<RoomScreen> {
    const p = preset ?? await RoomScreen.pickMap(host);
    const s = new RoomScreen(game, host);
    host.status(`Criando sala (${p.mapName}, TDM)... o servidor ignora creates < 4s após entrar, pode levar alguns segundos.`);
    try {
      await s.room.create({ name, mapId: p.mapId, rule: p.rule, stage: p.stage, roomType: p.roomType, slots: p.slots ?? 16, killTime: p.killTime ?? 0x63, weaponsFlag: p.weaponsFlag, ai: p.ai,
        password: p.password, limit: p.limit, watchRule: p.watchRule, flag: p.flag, randomMaps: p.randomMaps });
    } catch (e) {
      s.room.dispose();
      throw e;
    }
    s.draw();
    host.status("Sala criada. Aguarde um jogador no time adversário ficar PRONTO e clique Iniciar.");
    return s;
  }

  private static async pickMap(host: RoomScreenHost): Promise<RoomPreset> {
    await loadMapIndex();
    return new Promise((resolve, reject) => {
      const presets = buildRoomPresets();
      const tiles = presets.map((p, i) => button(`${p.mapName} (TDM)`, () => resolve(p), i === 0 ? "primary" : ""));
      host.render("Criar sala", "Escolha o mapa · Team Deathmatch", el("div", { class: "row" }, ...tiles),
        el("div", { class: "row" }, button("Voltar", () => reject(new Error("Criação de sala cancelada.")))));
      host.status("");
    });
  }

  static async join(game: GameClient, host: RoomScreenHost, roomId: number, password = "", stealth = false): Promise<RoomScreen> {
    const s = new RoomScreen(game, host);
    try {
      await s.room.join(roomId, password, stealth);
    } catch (e) {
      s.room.dispose();
      throw e;
    }
    s.draw();
    host.status(`Entrou no slot ${s.room.mySlot + 1} (${TEAM[s.room.mySlot % 2]}).`);
    return s;
  }

  /** A room the server seated this client in (clan-war pairing): the ROOM_JOIN_ACK body already read, no request sent. */
  static adopt(game: GameClient, host: RoomScreenHost, ack: PacketReader): RoomScreen {
    const s = new RoomScreen(game, host);
    try {
      s.room.adopt(ack);
    } catch (e) {
      s.room.dispose();
      throw e;
    }
    s.draw();
    host.status(`Entrou no slot ${s.room.mySlot + 1} (${TEAM[s.room.mySlot % 2]}).`);
    return s;
  }

  dispose(): void {
    this.stopCountdown();
    this.stopNet();
    this.room.dispose();
  }

  /** 5126: the exe step (RoomCountdown.event), then its OnUpdate one-second steps until the count runs out */
  private onCountdown(n: number): void {
    this.countdown.event(n);
    if (this.countdown.count <= 0) { this.stopCdTick(); return; }
    if (this.cdTick) return;
    let last = performance.now();
    this.cdTick = setInterval(() => {
      const now = performance.now();
      this.countdown.update((now - last) / 1000);
      last = now;
      if (this.countdown.count <= 0) this.stopCdTick();
    }, 50);
  }

  private stopCdTick(): void {
    if (this.cdTick) clearInterval(this.cdTick);
    this.cdTick = null;
  }

  /** START_GAME / leave: no more countdown steps, room lock released */
  private stopCountdown(): void {
    this.stopCdTick();
    this.countdown.reset();
  }

  private draw(): void {
    const r = this.room;
    const info = r.room;
    const cols = [0, 1].map((team) => {
      const rows = r.slots.filter((s) => s.slot % 2 === team && s.slot < (info?.slotCount ?? 16)).map((s) =>
        el("tr", {},
          el("td", {}, String(s.slot + 1)),
          el("td", {}, (s.nick || (s.state >= 12 ? "(jogador)" : "—")) + (s.slot === r.leaderSlot ? " ★" : "") + (s.slot === r.mySlot ? " (você)" : "")),
          el("td", {}, slotStateName(s.state))));
      return el("div", {}, el("h2", {}, TEAM[team]),
        el("table", {}, el("thead", {}, el("tr", {}, el("th", {}, "#"), el("th", {}, "Jogador"), el("th", {}, "Estado"))), el("tbody", {}, ...rows)));
    });
    const me = r.slots[r.mySlot];
    const actions: Node[] = [];
    if (this.phase === "room") {
      if (r.isLeader) actions.push(button("Iniciar partida", () => void this.startAsLeader(), "primary"));
      else actions.push(button(me?.state === WIRE_READY ? "Cancelar pronto" : "Pronto", () => r.ready(), "primary"));
      actions.push(button("Trocar time", () => {
        if (!r.changeTeam(1 - (r.mySlot % 2))) this.host.status("Sem slot livre no outro time (ou você está PRONTO).", true);
      }));
      actions.push(button("Sair da sala", () => void this.leave()));
    } else if (this.phase === "battle") {
      actions.push(button("Abandonar partida", () => { r.giveUp(); this.stopNet(); this.phase = "room"; this.draw(); }));
      if (r.isLeader) actions.push(button("Encerrar partida (tempo 0)", () => r.timerSync(0)));
    }
    const sub = info
      ? `Sala #${info.roomId + 1} · mapa ${mapName(info.mapId)} · modo ${info.roomType === 4 ? "TDM" : info.roomType} · ${ROOM_STATE_NAMES[info.state] ?? info.state}`
      : "";
    const extra: Node[] = [];
    if (this.phase === "battle" && this.net) {
      extra.push(el("div", { class: "sub" }, `Em batalha · Match UDP slot ${this.net.link.session.slot} · tx ${this.net.link.txPackets} / rx ${this.net.link.rxPackets} pacotes`));
    }
    if (this.lastResult) {
      const w = ["FR", "CT", "empate"][this.lastResult.winner] ?? String(this.lastResult.winner);
      extra.push(el("div", { class: "sub" }, `Última partida: vencedor ${w}${this.lastResult.frKills !== undefined ? ` · kills FR ${this.lastResult.frKills}` : ""}`));
    }
    this.host.render(info?.name ?? "Sala", sub, el("div", { class: "cols" }, ...cols), ...extra, el("div", { class: "row" }, ...actions));
  }

  private async startAsLeader(): Promise<void> {
    if (this.countdown.running) { this.room.ready(); return; } // the leader's READYBATTLE during the countdown stops it (255)
    if (this.busy) return;
    this.busy = true;
    try {
      this.host.status("Iniciando (READYBATTLE)...");
      await this.room.start();
    } catch (e) {
      this.host.status(`${(e as Error).message}\n(TDM precisa de pelo menos 1 jogador PRONTO no time adversário)`, true);
    } finally {
      this.busy = false;
    }
  }

  /** START_GAME received (both leader and guests): run the loading/rendezvous handshake. */
  private async bootstrapBattle(): Promise<void> {
    if (this.phase !== "room") return;
    this.phase = "starting";
    this.stopCountdown();
    const r = this.room;
    try {
      this.host.loading?.(BATTLE_CAPTION.load);
      this.host.status("Carregando (LOADING_START)...");
      await r.loadingStart();
      if (!r.isLeader) await this.waitRoomState(RoomState.RENDEZVOUS, 15000); // leader's LOADING_START sets the UDP server
      // map, renderer and the match assets of every slot (USER_EQUIPMENT 3667 arrived with LOADING_START) load now, behind the curtain
      await runBattlePrep(r, PREP_CAP_MS);
      this.host.status("PRESTARTBATTLE...");
      const ep = await r.preStart();
      const roster = r.slots.filter((s) => s.state >= 12).map((s) => ({ slot: s.slot, name: s.nick || `slot ${s.slot + 1}`, team: (s.slot % 2) as 0 | 1 }));
      const net = new PbBattleNet({
        session: { uniqueRoomId: ep.uniqueRoomId, roomSeed: ep.roomSeed, slot: ep.slot, accountId: this.accountIdByte(), signalTicket: ep.signalTicket },
        roster, serverUrl: this.host.serverUrl ?? defaultServerUrl(), room: r,
      });
      this.net = net;
      // Chain onto room.onRespawnAck here, before the round's very first `r.respawn()` below: that first RESPAWN_ACK
      // (everyone's initial spawn) fires while Game.create() (map/weapon preload) is still ahead, at main.ts's
      // onBattle handoff - a listener wired only inside Game.create() misses it, so head/face/beret (and the
      // actorHasHelmet flag the HUD icon and Helmet Protection read) stay empty for round 1 until someone respawns.
      watchRespawnEquip(r as unknown as RespawnAckSource);
      this.host.loading?.(BATTLE_CAPTION.connect);
      setBattleProgress(0.93);
      this.host.status(`Conectando na partida P2P (sala ${ep.uniqueRoomId})...`);
      await net.connect();
      const started = new Promise<void>((res, rej) => {
        const t = setTimeout(() => rej(new Error("STARTBATTLE: timeout")), STARTBATTLE_WAIT_MS);
        r.onBattleStart = () => { clearTimeout(t); r.onBattleStart = null; res(); };
      });
      r.startBattle();
      this.host.loading?.(BATTLE_CAPTION.wait);
      setBattleProgress(0.97);
      this.host.status("Aguardando os outros jogadores (STARTBATTLE)...");
      await started;
      net.setRespawnCount(await r.respawn());
      this.phase = "battle";
      this.draw();
      this.host.status("Partida em andamento.");
      this.host.onBattle?.(net, r);
    } catch (e) {
      discardBattlePrep();
      this.host.loading?.(null);
      this.host.status(`Falha ao iniciar a batalha: ${(e as Error).message}`, true);
      this.stopNet();
      this.phase = "room";
      this.draw();
    }
  }

  /** PB UDP header carries the low byte of the account PlayerId (Server.Game EquipmentSync). */
  private accountIdByte(): number {
    return Number(this.host.playerId & 0xffn);
  }

  private waitRoomState(min: number, timeoutMs: number): Promise<void> {
    if ((this.room.room?.state ?? 0) >= min) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const prev = this.room.onChange;
      const t = setTimeout(() => { this.room.onChange = prev; reject(new Error(`sala não chegou em ${ROOM_STATE_NAMES[min]}`)); }, timeoutMs);
      this.room.onChange = () => {
        prev?.();
        if ((this.room.room?.state ?? 0) >= min) {
          clearTimeout(t);
          this.room.onChange = prev;
          resolve();
        }
      };
    });
  }

  private onEnd(e: EndBattleInfo): void {
    this.lastResult = e;
    this.stopNet();
    this.phase = "room";
    this.draw();
    this.host.status("Partida encerrada (ENDBATTLE). De volta à sala.");
    // the away kick brought him back: the exe's message box text for it (the kick itself: awayChecker.ts 0x76c6c0)
    if (e.away) this.host.popup?.(tOr("STBL_IDX_EP_GAME_AWAY_INPUT_LOBBY", "Por estar inativo na partida por muito tempo\nvocê foi movido para a sala de espera."));
  }

  private stopNet(): void {
    this.net?.dispose();
    this.net = null;
  }

  private async leave(): Promise<void> {
    await this.room.leave();
    this.dispose();
    this.host.onLeave();
  }
}
