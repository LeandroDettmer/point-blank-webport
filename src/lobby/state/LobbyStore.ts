// Lobby rooms/players. 2588 LOBBY_GET_ROOMLIST_ACK is paged and the server rotates the page on
// every request (src/net/gameClient.ts): pages are merged, and page 0 of a list starts a new round so rooms that
// disappeared are dropped (same rule as src/ui/lobbyScreen.ts).
import type { LobbyPlayer, RoomInfo, RoomListPage } from "../../net/gameClient.ts";
import { Observable } from "./observable.ts";

export type LobbyKey = "rooms" | "players";

export class LobbyStore extends Observable<LobbyKey> {
  rooms = new Map<number, RoomInfo>();
  players = new Map<number, LobbyPlayer>();
  totalRooms = 0;
  totalPlayers = 0;
  updatedAt = 0;

  applyPage(p: RoomListPage, now = Date.now()): void {
    if (p.roomPage === 0) this.rooms = new Map();
    if (p.playerPage === 0) this.players = new Map();
    for (const r of p.rooms) this.rooms.set(r.roomId, r);
    for (const pl of p.players) this.players.set(pl.sessionId, pl);
    this.totalRooms = p.totalRooms;
    this.totalPlayers = p.totalPlayers;
    this.updatedAt = now;
    this.emit(["rooms", "players"]);
  }

  /** After 1052 nick colour is accepted: our own row takes the colour now, without re-reading the lobby list. */
  setNickColor(nickname: string, nickColor: number): void {
    for (const [id, pl] of this.players) if (pl.nickname === nickname) this.players.set(id, { ...pl, nickColor });
    this.emit(["players"]);
  }

  clear(): void {
    this.rooms = new Map();
    this.players = new Map();
    this.emit(["rooms", "players"]);
  }

  roomList(): RoomInfo[] { return [...this.rooms.values()].sort((a, b) => a.roomId - b.roomId); }
  playerList(): LobbyPlayer[] { return [...this.players.values()].sort((a, b) => b.rank - a.rank || a.nickname.localeCompare(b.nickname)); }

  /**
   * Quick start candidates [RECRIADO: the web picks client-side; the original's server-side quick join is not
   * implemented by ?]: waiting rooms (state READY) with a free slot, fullest first.
   */
  quickStartCandidates(): RoomInfo[] {
    return this.roomList().filter((r) => r.state === 1 && r.players < r.slots).sort((a, b) => b.players - a.players || a.roomId - b.roomId);
  }
}
