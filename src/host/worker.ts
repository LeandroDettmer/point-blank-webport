// Web Worker entry of the P2P match host (P2P): src/host/local.ts starts it in the room leader's tab.
import { attachHost } from "./runtime.ts";
import type { HostPort } from "./messages.ts";

attachHost(self as unknown as HostPort);
