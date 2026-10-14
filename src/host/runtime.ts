// The match Worker's body: one MatchCore (the Server.Match port) behind the HostIn / HostOut pipe. Runs in a Web Worker
// in the leader's tab (src/host/worker.ts) and in a node:worker_threads Worker in the Node test (src/p2p/test).
// Each peer (the leader's own MatchLink, or one WebRTC guest) is the core's "IPEndPoint" `p<id>`.
import { MatchCore } from "./matchCore.ts";
import type { HostOut, HostPort } from "./messages.ts";

export function attachHost(port: HostPort): void {
  let core: MatchCore | null = null;
  const peers = new Map<number, { label: string; slot?: number }>();
  let spoofed = 0;
  const post = (m: HostOut) => port.postMessage(m);
  const log = (line: string) => post({ t: "log", line });

  port.onmessage = (e) => {
    const m = e.data;
    try {
      if (m.t === "start") {
        const uid = m.uniqueRoomId >>> 0, seed = m.roomSeed >>> 0;
        core = new MatchCore({
          send: (peer, data, rel) => post({ t: "dgram", id: Number(peer.slice(1)), data, rel }),
          game: (g) => post({ t: "game", m: g }),
          log,
          warn: (line) => { console.warn(`[p2p host] ${line}`); log(line); },
          // anti-cheat strikes: a guest's link only, after the datagram being read
          kick: (peer, reason) => queueMicrotask(() => {
            const id = Number(peer.slice(1)), p = peers.get(id);
            if (!p || p.slot === undefined) return;
            post({ t: "close", id, code: 4003, reason: "anti-cheat" });
            peers.delete(id);
            core?.peerClosed(peer);
            log(`peer #${id} (slot ${p.slot}) dropped: ${reason}`);
          }),
        }, {
          data: m.data, config: m.config, allowRoom: (u, s) => u === uid && s === seed,
          // the leader's own MatchLink opens without a slot (LocalHost.peer): it alone sends the AI seats' records
          hostPeer: (peer) => { const p = peers.get(Number(peer.slice(1))); return !!p && p.slot === undefined; },
        });
        let restored: { startTick: number; slots: number[] } | undefined;
        if (m.restore) {
          // a snapshot this build cannot read (version, shape) is the plain takeover: a fresh core, not a dead host
          try {
            restored = core.restore(m.restore);
            log(`restored from a host handoff: ${restored.slots.length} slot(s) to re-register, room start tick ${restored.startTick}`);
          } catch (err) {
            core.rooms.length = 0;
            log(`host handoff refused (${(err as Error).message}): fresh core`);
          }
        }
        post({ t: "ready", ...(restored ? { restored } : {}) });
        return;
      }
      if (!core) return;
      switch (m.t) {
        case "open":
          peers.set(m.id, { label: m.label, slot: m.slot });
          log(`peer #${m.id} ${m.label}${m.slot !== undefined ? ` (slot ${m.slot})` : ""} open`);
          break;
        case "dgram": {
          const p = peers.get(m.id);
          if (!p) return;
          // a guest speaks for its own slot only (the header slot byte is what Server.Match trusts together with the
          // source address; over WebRTC the address is the signaled slot)
          if (p.slot !== undefined && m.data.length > 1 && m.data[1] !== p.slot) { spoofed++; return; }
          core.receive(`p${m.id}`, m.data);
          break;
        }
        case "close":
          if (peers.delete(m.id)) {
            core.peerClosed(`p${m.id}`);
            log(`peer #${m.id} closed`);
          }
          break;
        case "snapshot": post({ t: "snapshot", snapshot: core.snapshot() }); break;
        case "respawn": core.respawnSync(m.s); break;
        case "remove": { const r = core.rooms[0]; if (r) core.removePlayerSync(r.uniqueRoomId, r.roomSeed, m.slot, m.type); break; }
        case "round": { const r = core.rooms[0]; if (r) core.roundSync(r.uniqueRoomId, r.roomSeed, m.round, m.teamSwap); break; }
        case "end":
          for (const id of [...peers.keys()]) {
            post({ t: "close", id, code: 1001, reason: m.reason });
            core.peerClosed(`p${id}`);
            peers.delete(id);
          }
          log(`match over: ${m.reason}`);
          break;
        case "stats": {
          const r = core.rooms[0];
          post({
            t: "stats", stats: {
              ...core.stats, spoofed, peers: peers.size,
              players: (r?.players ?? []).filter((p) => p.client).map((p) => ({ slot: p.slot, peer: p.client, life: p.life, dead: p.dead, respawn: p.respawnByServer })),
            },
          });
          break;
        }
      }
    } catch (err) {
      post({ t: "error", message: (err as Error).message });
    }
  };
}
