// Smoke test for src/ui/roomCountdown.ts (UIPhaseReadyRoom::_EventProcess_BattlCountDown 0x8f2de0 + OnUpdate 0x8f3f00).
//   node --experimental-transform-types src/ui/dev/roomCountdown.smoke.node.ts
import { existsSync, readFileSync } from "node:fs";
import { COUNTDOWN_SOUNDS, RoomCountdown, parseCol, type Rgba } from "../roomCountdown.ts";

let fails = 0;
function check(name: string, ok: boolean, extra = ""): void {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${extra ? `  (${extra})` : ""}`);
  if (!ok) fails++;
}

interface Log { notices: { text: string; color: Rgba | null }[]; sounds: string[]; locks: boolean[] }
function make(leader: boolean, sub = { open: false }) {
  const log: Log = { notices: [], sounds: [], locks: [] };
  const cd = new RoomCountdown({
    notice: (text, color) => log.notices.push({ text, color }),
    lock: (on) => log.locks.push(on),
    sound: (f) => log.sounds.push(f.split("/").pop()!),
    subPhase: () => sub.open,
  }, () => leader);
  return { cd, log, sub };
}
const texts = (l: Log) => l.notices.map((n) => n.text);
const ORANGE: Rgba = [255, 120, 0, 1];

// the fallbacks are String_Brazil.lua's own texts (pt-BR.json when the assets are exported)
const strings = "public/assets/ui/strings/pt-BR.json";
if (existsSync(strings)) {
  const d = JSON.parse(readFileSync(strings, "utf8")) as Record<string, string>;
  const src = readFileSync("src/ui/roomCountdown.ts", "utf8");
  const keys = [...src.matchAll(/\["(STR_TBL_GUI_READY[A-Z_]*)", "((?:[^"\\]|\\.)*)"\]/g)];
  check("fallback texts = pt-BR.json", keys.length === 6 && keys.every(([, k, v]) => d[k] === v), keys.filter(([, k, v]) => d[k] !== v).map(([, k]) => k).join(","));
}

check("5126 byte read signed (255 = -1, 254 = -2, 5 = 5)", ((255 << 24) >> 24) === -1 && ((254 << 24) >> 24) === -2 && ((5 << 24) >> 24) === 5);
check("parseCol", JSON.stringify(parseCol("{col:255,120,0,255} Algum{/col}")) === JSON.stringify({ text: "Algum", color: ORANGE })
  && parseCol("plain").color === null);
check("sounds: count 1..5 = UI_Count_A..E", COUNTDOWN_SOUNDS.map((f) => f.slice(-5, -4)).join("") === "ABCDE");

{
  const { cd, log } = make(true);
  cd.event(5);
  check("leader 5: lock on", log.locks.join() === "true");
  check("leader 5: red STOP_GET_AWAY between two blank lines", texts(log).slice(0, 3).join("|") === "  |Não é possível mudar para outras funções ao iniciar jogo|  "
    && JSON.stringify(log.notices[1].color) === JSON.stringify([255, 0, 0, 1]));
  check("leader 5: START_COUNTDOWN then 'Início do jogo em 5segundos' (orange)", texts(log).slice(3).join("|") === "Iniciando contagem regressiva.|Início do jogo em 5segundos"
    && log.notices.slice(3).every((n) => JSON.stringify(n.color) === JSON.stringify(ORANGE)));
  check("leader 5: UI_Count_E", log.sounds.join() === "UI_Count_E.wav");
  check("running, count 5", cd.running && cd.count === 5);
  log.notices.length = 0;
  cd.update(0.5);
  check("0.5 s: nothing yet", log.notices.length === 0 && cd.count === 5);
  cd.update(0.5);
  check("1 s: count 4, alarm 4 + UI_Count_D", cd.count === 4 && texts(log).join() === "Início do jogo em 4segundos" && log.sounds.at(-1) === "UI_Count_D.wav");
  for (let i = 0; i < 80; i++) cd.update(0.05);
  check("5 s: 3 2 1 then 'O jogo será iniciado.'", texts(log).join("|") === ["Início do jogo em 4segundos", "Início do jogo em 3segundos", "Início do jogo em 2segundos", "Início do jogo em 1segundos", "O jogo será iniciado."].join("|"), texts(log).join("|"));
  check("sounds E D C B A, none at 0", log.sounds.join() === "UI_Count_E.wav,UI_Count_D.wav,UI_Count_C.wav,UI_Count_B.wav,UI_Count_A.wav", log.sounds.join());
  const n = log.notices.length;
  cd.update(5);
  check("stops at 0", cd.count === 0 && log.notices.length === n);
  check("lock held until START_GAME", log.locks.join() === "true" && cd.running);
  cd.reset();
  check("reset (START_GAME): lock off", log.locks.join() === "true,false" && !cd.running);
}
{
  const { cd, log } = make(true);
  cd.event(5);
  cd.update(1);
  log.notices.length = 0;
  cd.event(-1);
  check("leader cancel (255): unlock + 'O dono da sala cancelou...'", log.locks.join() === "true,false" && texts(log).join() === "O dono da sala cancelou a contagem regressiva." && !cd.running);
  const n = log.sounds.length;
  cd.update(3);
  check("count stops after a cancel", cd.count === -1 && log.sounds.length === n && log.notices.length === 1);
}
{
  const { cd, log } = make(false);
  cd.event(5);
  check("guest 5: no lock, no red notice", log.locks.length === 0 && texts(log).join("|") === "Iniciando contagem regressiva.|Início do jogo em 5segundos" && cd.running);
  cd.event(-2);
  check("player cancel (254): 'Algum jogador não está pronto...'", texts(log).at(-1) === "Algum jogador não está pronto, a contagem regressiva foi cancelada." && log.locks.length === 0);
}
{
  const { cd, log, sub } = make(false);
  sub.open = true;
  cd.event(5);
  check("sub-phase open: event dropped", log.notices.length === 0 && log.sounds.length === 0 && cd.count === 0);
}

console.log(fails ? `roomCountdown smoke: ${fails} FAIL` : "roomCountdown smoke: OK");
if (fails) process.exit(1);
