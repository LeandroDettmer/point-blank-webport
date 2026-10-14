// node:worker_threads entry of the P2P match host for the Node tests: the same runtime as src/host/worker.ts
// (the browser Web Worker), with parentPort as the pipe.
import { parentPort } from "node:worker_threads";
import { attachHost } from "../../host/runtime.ts";
import type { HostIn, HostOut, HostPort } from "../../host/messages.ts";

const port: HostPort = { postMessage: (m: HostOut) => parentPort!.postMessage(m), onmessage: null };
parentPort!.on("message", (m: HostIn) => port.onmessage?.({ data: m }));
attachHost(port);
