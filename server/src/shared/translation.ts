// Plugin.Core Translation: runtime/Config/Translate/Strings.ini ("Key = text" lines, first one wins), GetLabel with
// .NET string.Format "{n}" placeholders; an unknown key returns the key itself.
import { readFileSync } from "node:fs";
import path from "node:path";
import { config } from "../config.ts";

const strings = new Map<string, string>();
try {
  for (const line of readFileSync(path.join(config.configDir, "Translate/Strings.ini"), "utf8").replace(/^﻿/, "").split(/\r?\n/)) {
    const i = line.indexOf(" = ");
    if (i >= 0 && !strings.has(line.slice(0, i))) strings.set(line.slice(0, i), line.slice(i + 3));
  }
} catch (e) {
  console.warn(`[translation] Strings.ini: ${(e as Error).message}`);
}

export function getLabel(title: string, ...args: unknown[]): string {
  const s = strings.has(title) ? strings.get(title)! : title;
  return args.length ? s.replace(/\{(\d+)\}/g, (m, n) => (Number(n) < args.length ? String(args[Number(n)]) : m)) : s;
}
