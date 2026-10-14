// Node shim for live tests that drive the real UI controllers (Lobby2017 -> RoomScreen -> PbBattleNet): the default
// netmode is p2p, whose browser pieces (RTCPeerConnection, the Web Worker host, the JSON import of matchData) do not
// exist in Node. Fills them in PbBattleNet's p2p options with node-datachannel and a worker_threads host, as
// p2pbattle.live.ts does explicitly.
import { readFileSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { RTCPeerConnection } from "node-datachannel/polyfill";
import { PbBattleNet } from "../../net/battle.ts";
import type { WorkerLike } from "../../host/local.ts";
import type { MatchData } from "../../host/matchCore.ts";

const DATA = JSON.parse(readFileSync(new URL("../../host/data/matchData.json", import.meta.url), "utf8")) as MatchData;

function nodeWorker(): WorkerLike {
  const w = new Worker(new URL("./nodeHostWorker.ts", import.meta.url));
  const like: WorkerLike = { postMessage: (m) => w.postMessage(m), onmessage: null, onerror: null, terminate: () => { void w.terminate(); } };
  w.on("message", (m) => like.onmessage?.({ data: m }));
  w.on("error", (e) => like.onerror?.({ message: e.message }));
  return like;
}

export function installNodeP2P(log: (line: string) => void = () => {}): void {
  const connect = PbBattleNet.prototype.connect;
  PbBattleNet.prototype.connect = function (this: PbBattleNet) {
    const o = (this as unknown as { p2pOpts: Record<string, unknown> }).p2pOpts;
    o.RTCPeerConnection ??= RTCPeerConnection;
    o.worker ??= nodeWorker;
    o.data ??= DATA;
    o.log ??= log;
    return connect.call(this);
  };
}
