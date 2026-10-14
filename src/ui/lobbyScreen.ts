// Start flow: login -> Auth meta 2316/2318/2320/1060 -> server/channel list (card) -> USER_ENTER (+ pushes up to
// 3082) -> lobby ANTIGO simples (tabela de salas/jogadores, src/net/gameClient.ts getRoomList) -> room
// (src/ui/roomScreen.ts) -> battle (boot.ts playBattle) -> room -> "Sair" -> lobby antigo.
// "Testar mapa" launches the offline PoC (src/main.ts).
import { AuthClient, gameTargetForServer, type GameServerInfo, type LoginResult } from "../net/authClient.ts";
import { GameClient, type LobbyPlayer, type RoomInfo } from "../net/gameClient.ts";
import { defaultServerUrl, GW_OVERRIDE } from "../net/connection.ts";
import type { AuthMeta } from "../net/metaAuth.ts";
import { candidateTokens, deriveWebTokenBase64, parseTokenInput } from "../net/token.ts";
import { RoomScreen } from "./roomScreen.ts";
import type { PbBattleNet } from "../net/battle.ts";
import type { RoomClient } from "../net/roomClient.ts";
import { createMetaSession, type MetaSession, type PlayerStore } from "../lobby/screens/index.ts";
import type { EquipPair } from "../lobby/types.ts";
import { enforceRoomWeapons } from "../game/respawnSelect.ts";

const ROOM_STATES = ["UNK", "READY", "COUNTDOWN", "LOADING", "RENDEZVOUS", "PRE_BATTLE", "BATTLE_READY", "BATTLE", "BATTLE_END", "EMPTY"];

const CSS = `
#pbnet{position:fixed;inset:0;z-index:50;display:flex;align-items:center;justify-content:center;
  background:radial-gradient(ellipse at top,#1d2733,#07090c);color:#dfe6ee;font:14px/1.4 system-ui,sans-serif}
#pbnet.hidden{display:none}
#pbnet .card{width:min(920px,calc(100vw - 32px));max-height:calc(100vh - 32px);overflow:auto;
  background:#0f151cdd;border:1px solid #2c3a48;border-radius:10px;padding:20px;box-shadow:0 10px 40px #000a}
#pbnet h1{margin:0 0 4px;font-size:20px;color:#ffb347;letter-spacing:.5px}
#pbnet h2{margin:18px 0 8px;font-size:15px;color:#9fc3e6}
#pbnet .sub{color:#7d8d9c;font-size:12px;margin-bottom:14px}
#pbnet label{display:block;font-size:12px;color:#9aa8b5;margin:8px 0 3px}
#pbnet input{width:100%;box-sizing:border-box;padding:8px 10px;background:#081018;color:#e8eef4;
  border:1px solid #2c3a48;border-radius:6px;font:inherit}
#pbnet .row{display:flex;gap:10px;flex-wrap:wrap;margin-top:14px}
#pbnet button{padding:8px 14px;border-radius:6px;border:1px solid #3b556e;background:#18314a;color:#e8f2ff;cursor:pointer;font:inherit}
#pbnet button:hover{background:#21456a}
#pbnet button.primary{background:#c77414;border-color:#e0892a;color:#fff}
#pbnet button.primary:hover{background:#dd8522}
#pbnet button:disabled{opacity:.5;cursor:default}
#pbnet .status{margin-top:12px;font-family:monospace;font-size:12px;white-space:pre-wrap;color:#9fb0c0}
#pbnet .status.err{color:#ff7b72}
#pbnet .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px}
#pbnet .tile{padding:10px;border:1px solid #2c3a48;border-radius:6px;background:#0b1620;cursor:pointer;text-align:left}
#pbnet .tile:hover{border-color:#e0892a}
#pbnet .tile small{display:block;color:#7d8d9c}
#pbnet table{width:100%;border-collapse:collapse;font-size:13px}
#pbnet th,#pbnet td{padding:5px 8px;border-bottom:1px solid #1f2b37;text-align:left;white-space:nowrap}
#pbnet th{color:#7d8d9c;font-weight:600}
#pbnet .cols{display:grid;grid-template-columns:2fr 1fr;gap:16px}
@media (max-width:700px){#pbnet .cols{grid-template-columns:1fr}}
#pbnet details{margin-top:8px;color:#7d8d9c;font-size:12px}
`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...kids: (Node | string)[]) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  for (const k of kids) e.append(k);
  return e;
}

export interface LobbyScreenOptions {
  onPlay: () => void;
  /** Token from the account screen (account-api); skips the manual login form. */
  session?: { token: Uint8Array; username: string };
  /** A room battle went live: plug the NetAdapter into the game loop. */
  onBattle?: (net: PbBattleNet, room: RoomClient) => void;
}

/**
 * 18 pairs for RESPAWN 5137 from the equipped loadout (6150/3082 in the PlayerStore): pair 8 = the character of
 * the slot's team (charaSlots via 2453), weapons [0..4] from `equip` when given (respawn weapon change, T).
 */
export function respawnEquipFor(player: PlayerStore, slot: number, equip?: EquipPair[], weaponsFlag = 0x1ff, stage = 0): EquipPair[] {
  let pairs = player.equipPairs();
  const t = player.teamCharas();
  const chara = slot % 2 === 0 ? t.red : t.blue;
  if (chara) pairs[8] = { itemId: chara, objectId: player.state.charaInfo?.charas.find((c) => c.itemId === chara)?.objectId ?? 0 };
  equip?.slice(0, 5).forEach((p, i) => { if (p?.itemId) pairs[i] = { ...p }; });
  // Sniper / Shotgun / Knife rooms: a barred equipped weapon is swapped for an owned one the room allows; Clube da Luta
  // (stage 224): the bare fist only
  const owned = player.items().filter((i) => i.equip !== 1).map((i) => ({ itemId: i.itemId, objectId: i.objectId }));
  pairs = enforceRoomWeapons(pairs, owned, weaponsFlag, { itemId: 0, objectId: 0 }, stage);
  return pairs;
}

/**
 * Makes every RESPAWN of this room carry the equipped loadout: RoomScreen's first respawn (zero body) and
 * PbBattleNet's later ones (weapons only). Without it the server swaps in the defaults.
 */
export function respawnWithLoadout(room: RoomClient, player: PlayerStore): void {
  const respawn = room.respawn.bind(room);
  room.respawn = (flag, equip) => respawn(flag, respawnEquipFor(player, room.mySlot, equip, room.room?.weaponsFlag, room.room?.stage));
}

/**
 * Lobby ANTIGO (tabela de salas/jogadores): login -> servidores/canais -> lobby -> sala. Loadout real via
 * fetchMeta (2316/2318/2320/1060) + os pushes do Game (2453/3082): respawnWithLoadout no RESPAWN 5137 e
 * respawnInventory (boot.ts) usam `this.player`.
 */
export class LobbyScreen {
  private root: HTMLDivElement;
  private card: HTMLDivElement;
  private statusEl: HTMLDivElement;
  private auth: AuthClient | null = null;
  private game: GameClient | null = null;
  private login: LoginResult | null = null;
  private authMeta: AuthMeta | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private rooms = new Map<number, RoomInfo>();
  private players = new Map<number, LobbyPlayer>();
  private roomScreen: RoomScreen | null = null;
  private inRoom = false;
  private opts: LobbyScreenOptions;
  /** session (inventory/loadout) opened alongside the table lobby; drives respawnWithLoadout + respawnInventory. */
  private meta: MetaSession | null = null;

  constructor(opts: LobbyScreenOptions) {
    this.opts = opts;
    document.head.append(el("style", {}, CSS));
    this.root = el("div", { id: "pbnet" });
    this.card = el("div", { class: "card" });
    this.statusEl = el("div", { class: "status" });
    this.root.append(this.card);
    document.body.append(this.root);
    if (opts.session) {
      this.render("Project Blackout", `Entrando como ${opts.session.username}...`);
      void this.doLogin(this.savedServerUrl(), opts.session.username, "", "", opts.session.token);
    } else {
      this.showLogin();
    }
  }

  /** PlayerStore (inventory + equipped loadout), null outside a channel. Used by boot.ts respawnInventory. */
  get player(): PlayerStore | null {
    return this.meta?.player ?? null;
  }

  hide(): void {
    this.root.classList.add("hidden");
  }

  /** Back from a battle: the card still holds the room screen (or the lobby table, if the room was left). */
  show(): void {
    this.root.classList.remove("hidden");
  }

  private status(msg: string, err = false): void {
    this.statusEl.textContent = msg;
    this.statusEl.classList.toggle("err", err);
    (err ? console.warn : console.log)(`[pbnet] ${msg}`);
  }

  private render(title: string, sub: string, ...body: Node[]): void {
    this.root.classList.remove("hidden");
    this.card.replaceChildren(el("h1", {}, title), el("div", { class: "sub" }, sub), ...body, this.statusEl);
  }

  private playButton(): HTMLButtonElement {
    const b = el("button", {}, "Testar mapa");
    b.onclick = () => this.opts.onPlay();
    return b;
  }

  private savedServerUrl(): string {
    if (!GW_OVERRIDE) return defaultServerUrl(); // "pbweb.gw" only in the Vite dev build
    try { return localStorage.getItem("pbweb.gw") ?? defaultServerUrl(); } catch { return defaultServerUrl(); }
  }

  private showLogin(): void {
    const saved = (k: string, d: string) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
    const gw = el("input", { value: GW_OVERRIDE ? saved("pbweb.gw", defaultServerUrl()) : defaultServerUrl() });
    const user = el("input", { value: saved("pbweb.user", ""), autocomplete: "username" });
    const pass = el("input", { type: "password", value: "", autocomplete: "current-password" });
    const tok = el("input", { placeholder: "opcional: texto ou b64:<base64>" });
    const tokHint = el("div", { class: "sub" });
    const refreshHint = async () => {
      tokHint.textContent = user.value && pass.value
        ? `token web = ${await deriveWebTokenBase64(user.value, pass.value)}  (accounts.token)` : "";
    };
    user.oninput = pass.oninput = () => void refreshHint();
    const go = el("button", { class: "primary" }, "Entrar");
    const form = el("form", {},
      el("label", {}, "Usuário"), user,
      el("label", {}, "Senha"), pass,
      el("details", {}, el("summary", {}, "Avançado"),
        el("label", {}, "Servidor"), gw,
        el("label", {}, "Token"), tok, tokHint),
      el("div", { class: "row" }, go, this.playButton()));
    form.onsubmit = (e) => {
      e.preventDefault();
      try {
        localStorage.setItem("pbweb.gw", gw.value);
        localStorage.setItem("pbweb.user", user.value);
      } catch { /* ignore */ }
      go.disabled = true;
      void this.doLogin(gw.value.trim(), user.value.trim(), pass.value, tok.value.trim()).finally(() => (go.disabled = false));
    };
    this.render("Project Blackout", "Login no servidor local via WebSocket", form);
    this.status("");
  }

  private async doLogin(gw: string, user: string, pass: string, tokB64: string, tokenBytes?: Uint8Array): Promise<void> {
    this.teardown();
    try {
      const tokens = tokenBytes
        ? [{ label: "conta web", bytes: tokenBytes }]
        : tokB64 ? [{ label: "campo Token", bytes: parseTokenInput(tokB64) }] : await candidateTokens(user, pass);
      let auth!: AuthClient;
      let res!: LoginResult;
      for (const [i, t] of tokens.entries()) {
        if (i > 0) await new Promise((r) => setTimeout(r, 5500)); // server throttles 5s/IP
        this.status(`Conectando em ${gw} (auth), token ${t.label}...`);
        auth = this.auth = new AuthClient(gw);
        res = await auth.connectAndLogin({ token: t.bytes, width: screen.width, height: screen.height });
        if (res.ok || res.error !== 0x80000117) break;
        auth.conn.close();
      }
      if (!res.ok) {
        this.status(`Login recusado: ${res.errorName}\n(o servidor BR autentica só por token: accounts.token precisa ser o token acima)`, true);
        auth.conn.close();
        return;
      }
      this.login = res;
      this.status(`Logado como ${res.username} (pid ${res.playerId}). Perfil e inventário (2316/2318)...`);
      try {
        this.authMeta = await auth.fetchMeta();
      } catch (e) {
        this.authMeta = null; // the Game pushes (2453/3082/2395) still fill the stores, only the 2319 list is missing
        console.warn("[pbnet] Auth meta failed", e);
      }
      this.status("Buscando servidores...");
      const servers = await auth.getServers();
      this.showServers(servers);
    } catch (e) {
      this.status(String((e as Error).message ?? e), true);
    }
  }

  private showServers(servers: GameServerInfo[]): void {
    const games = servers.filter((s) => s.index > 0);
    const grid = el("div", { class: "grid" });
    for (const s of games) {
      const t = el("button", { class: "tile" }, `Servidor ${s.index}`,
        el("small", {}, `${s.online ? "online" : "offline"} · ${s.players}/${s.maxPlayers} · porta ${s.port}`));
      t.onclick = () => void this.pickServer(s);
      grid.append(t);
    }
    if (!games.length) grid.append(el("div", { class: "sub" }, "Nenhum servidor de jogo na lista (GAME_SERVER_STATE_ACK)."));
    const back = el("button", {}, "Sair");
    back.onclick = () => { this.teardown(); this.showLogin(); };
    this.render("Servidores", `Jogador: ${this.login?.username}`, grid, el("div", { class: "row" }, back, this.playButton()));
  }

  private async pickServer(s: GameServerInfo): Promise<void> {
    this.status(`Canais do servidor ${s.index}...`);
    const info = await this.auth!.getChannels(s.index);
    const count = info?.channelPlayers.length || s.channelTypes.length || 10;
    const grid = el("div", { class: "grid" });
    for (let c = 0; c < count; c++) {
      const players = info ? `${info.channelPlayers[c]}/${info.maxPerChannel}` : "?";
      const t = el("button", { class: "tile" }, `Canal ${c + 1}`, el("small", {}, `jogadores ${players} · tipo ${s.channelTypes[c] ?? "?"}`));
      t.onclick = () => void this.enterChannel(s, c);
      grid.append(t);
    }
    const back = el("button", {}, "Voltar");
    back.onclick = () => void this.auth!.getServers().then((l) => this.showServers(l)).catch((e) => this.status(String(e), true));
    this.render(`Servidor ${s.index} — canais`, info ? "GET_CHANNELLIST_ACK" : "sem resposta do GET_CHANNELLIST (lista padrão)", grid,
      el("div", { class: "row" }, back, this.playButton()));
    this.status(info ? "" : "Aviso: servidor não respondeu GET_CHANNELLIST (exige 11 canais no DB).", !info);
  }

  private async enterChannel(s: GameServerInfo, channelId: number): Promise<void> {
    const login = this.login!;
    try {
      this.status("Saindo do auth (USER_LEAVE)...");
      await this.auth!.leave();
      this.auth = null;
      const target = gameTargetForServer(s);
      this.status(`Conectando em ${target} (USER_ENTER)...`);
      const game = (this.game = new GameClient(target, this.serverUrlFromStorage()));
      game.conn.onClose = (why) => this.status(`Conexão com o game fechada: ${why}`, true);
      this.status(`Conectando em ${target} (USER_ENTER, aguardando 2453/3082)...`);
      await game.enter(login.username, login.playerId, s.index);
      this.status(`Entrando no canal ${channelId + 1}...`);
      await game.selectChannel(channelId);
      await game.enterLobby();
      this.meta = createMetaSession({ authMeta: this.authMeta, enterPushes: game.enterPushes, gameConn: game.conn });
      this.showLobby(s, channelId);
    } catch (e) {
      this.status(`${(e as Error).message ?? e}\nFaça login de novo.`, true);
      this.game?.close();
      this.game = null;
    }
  }

  private serverUrlFromStorage(): string {
    if (!GW_OVERRIDE) return defaultServerUrl();
    try { return localStorage.getItem("pbweb.gw") || defaultServerUrl(); } catch { return defaultServerUrl(); }
  }

  private showLobby(s: GameServerInfo, channelId: number): void {
    this.rooms.clear();
    this.players.clear();
    const roomsBody = el("tbody");
    const playersBody = el("tbody");
    const roomsTable = el("table", {}, el("thead", {}, el("tr", {}, ...["#", "Nome", "Mapa", "Estado", "Jog."].map((h) => el("th", {}, h)))), roomsBody);
    const playersTable = el("table", {}, el("thead", {}, el("tr", {}, el("th", {}, "Nick"), el("th", {}, "Rank"))), playersBody);
    const exit = el("button", {}, "Sair");
    exit.onclick = () => { this.teardown(); this.showLogin(); };
    const create = el("button", { class: "primary" }, "Criar sala");
    create.onclick = () => {
      create.disabled = true;
      void this.openRoom(s, channelId, (game, host) => RoomScreen.create(game, host, `sala de ${this.login?.username ?? "web"}`))
        .finally(() => (create.disabled = false));
    };
    this.render(`Lobby — Servidor ${s.index}, Canal ${channelId + 1}`, `Jogador: ${this.login?.username} · clique numa sala para entrar`,
      el("div", { class: "cols" },
        el("div", {}, el("h2", {}, "Salas"), roomsTable),
        el("div", {}, el("h2", {}, "Jogadores no lobby"), playersTable)),
      el("div", { class: "row" }, create, this.playButton(), exit));

    const draw = () => {
      roomsBody.replaceChildren(...[...this.rooms.values()].sort((a, b) => a.roomId - b.roomId).map((r) => {
        const tr = el("tr", { style: "cursor:pointer", title: "Entrar na sala" }, el("td", {}, String(r.roomId + 1)), el("td", {}, r.name), el("td", {}, String(r.mapId)),
          el("td", {}, ROOM_STATES[r.state] ?? String(r.state)), el("td", {}, `${r.players}/${r.slots}`));
        tr.onclick = () => void this.openRoom(s, channelId, (game, host) => RoomScreen.join(game, host, r.roomId));
        return tr;
      }));
      if (!this.rooms.size) roomsBody.append(el("tr", {}, el("td", { colspan: "5" }, "nenhuma sala")));
      playersBody.replaceChildren(...[...this.players.values()].map((p) =>
        el("tr", {}, el("td", {}, p.nickname || `(sessão ${p.sessionId})`), el("td", {}, String(p.rank)))));
      if (!this.players.size) playersBody.append(el("tr", {}, el("td", { colspan: "2" }, "—")));
    };
    draw();

    const poll = async () => {
      const game = this.game;
      if (!game || !game.conn.isOpen || this.inRoom) return;
      const page = await game.getRoomList();
      if (this.inRoom || this.game !== game) return; // entered a room / left while waiting
      if (page) {
        // Server rotates pages; drop entries when page 0 comes back to reflect removals.
        if (page.roomPage === 0) this.rooms.clear();
        if (page.playerPage === 0) this.players.clear();
        for (const r of page.rooms) this.rooms.set(r.roomId, r);
        for (const p of page.players) this.players.set(p.sessionId, p);
        draw();
        this.status(`${page.totalRooms} sala(s), ${page.totalPlayers} jogador(es) no lobby · atualizado ${new Date().toLocaleTimeString()}`);
      }
      this.pollTimer = setTimeout(() => void poll(), 1500);
    };
    void poll();
  }

  /** Stops the lobby polling and hands the card to a RoomScreen; back to the lobby table on leave/failure. */
  private async openRoom(s: GameServerInfo, channelId: number,
    open: (game: GameClient, host: import("./roomScreen.ts").RoomScreenHost) => Promise<RoomScreen>): Promise<void> {
    const game = this.game;
    if (!game || this.inRoom) return;
    this.inRoom = true;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    try {
      this.roomScreen = await open(game, {
        render: (title, sub, ...body) => this.render(title, sub, ...body),
        status: (msg, err) => this.status(msg, err),
        onLeave: () => { this.roomScreen = null; this.inRoom = false; this.showLobby(s, channelId); },
        onBattle: (net, room) => this.opts.onBattle?.(net, room),
        serverUrl: this.serverUrlFromStorage(),
        playerId: this.login!.playerId,
      });
      if (this.meta) respawnWithLoadout(this.roomScreen.room, this.meta.player);
    } catch (e) {
      this.roomScreen = null;
      this.inRoom = false;
      this.showLobby(s, channelId);
      this.status(String((e as Error).message ?? e), true);
    }
  }

  private teardownMeta(): void {
    this.meta?.detach();
    this.meta = null;
  }

  private teardown(): void {
    this.roomScreen?.dispose();
    this.roomScreen = null;
    this.inRoom = false;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    this.teardownMeta();
    this.auth?.conn.close();
    this.auth = null;
    if (this.game) this.game.conn.onClose = null;
    this.game?.close();
    this.game = null;
  }
}

