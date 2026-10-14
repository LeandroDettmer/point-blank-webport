// F2 in the lobby: launcher of offline test matches (map / mode / team / bots / bomb test aids). It only sets the same URL params the
// game already reads (?mode ?team ?bots ?allies ?bombspawn ?bombplanted ?bombrings) and starts the local match.
import { AVAILABLE_MAPS, MAP_LABELS, mapIndexEntry } from "../config.ts";
import { BOMB_SERVER_MAP_IDS, TDM_SERVER_MAP_IDS } from "../lobby/core/controller.ts";

const KEYS = ["mode", "team", "bots", "allies", "rounds", "spectate", "gm", "bombspawn", "bombplanted", "bombrings"];
const CSS = `#pbdevl{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:100;width:380px;background:#0c1220f2;border:1px solid #3a6ea5;color:#dfe8f5;font:13px Arial,sans-serif;padding:14px 18px;border-radius:4px}#pbdevl h3{margin:0 0 10px;color:#7fb8ff;font-size:15px}#pbdevl label{display:flex;justify-content:space-between;align-items:center;margin:6px 0}#pbdevl select,#pbdevl input[type=number]{width:190px;background:#18233a;color:#dfe8f5;border:1px solid #3a6ea5;padding:3px}#pbdevl .row{display:flex;gap:8px;margin-top:12px}#pbdevl button{flex:1;padding:6px;background:#1f3d66;color:#fff;border:1px solid #3a6ea5;cursor:pointer}#pbdevl small{color:#8fa0b8}`;

/**
 * Called when a local match ends: the test params of the match (this launcher's or typed into the URL by hand) leave the address bar, the
 * rest of the query (`saved`, what was there before the launcher) stays. A page reload then no longer repeats the test match.
 */
export function resetDevParams(saved: string | null = null): void {
  const p = new URLSearchParams(saved ?? location.search);
  for (const k of KEYS) p.delete(k);
  const q = p.toString();
  history.replaceState(null, "", location.pathname + (q ? `?${q}` : "") + location.hash);
}

export function openDevLauncher(start: (map: string) => void): void {
  if (document.getElementById("pbdevl")) return;
  if (!document.getElementById("pbdevl-css")) {
    const s = document.createElement("style");
    s.id = "pbdevl-css";
    s.textContent = CSS;
    document.head.appendChild(s);
  }
  const saved = location.search;
  const box = document.createElement("div");
  box.id = "pbdevl";
  const opt = (v: string, t: string) => `<option value="${v}">${t}</option>`;
  const maps = "";
  box.innerHTML = `<h3>Testes offline <small>(F2 fecha)</small></h3>
<label>Mapa <select id="dl-map">${maps}</select></label>
<label>Modo <select id="dl-mode">${opt("tdm", "Team Deathmatch")}${opt("bomb", "Destruição (Bomba)")}</select></label>
<label>Seu time <select id="dl-team">${opt("red", "TR / vermelho")}${opt("blue", "CT / azul")}</select></label>
<label>Entrar como espectador (8x8 de bots) <input id="dl-spec" type="checkbox"></label>
<label>Bots <input id="dl-bots" type="number" min="0" max="16" value="0"></label>
<label>Bots no seu time <input id="dl-allies" type="number" min="0" max="16" value="0"></label>
<label>Rodadas p/ vencer (0 = sem limite) <input id="dl-rounds" type="number" min="0" max="9" value="3"></label>
<label>Nascer perto da bomba <select id="dl-spawn">${opt("", "não")}${opt("a", "ponto A")}${opt("b", "ponto B")}</select></label>
<label>Bomba já plantada <select id="dl-planted">${opt("", "não")}${opt("a", "no ponto A")}${opt("b", "no ponto B")}</select></label>
<label>Anéis dos pontos <input id="dl-rings" type="checkbox"></label>
<div class="row"><button id="dl-go">Iniciar</button><button id="dl-x">Fechar</button></div>
<small>Dentro do jogo, F2 abre o menu de ações (plantar, explodir, teleportar...).</small>`;
  document.body.appendChild(box);
  // Bomb Mission: only the maps that have bomb sites (maps/bombsites.json); "a_blowcity" is another map than the Bomb one ("blowcity")
  const mapSel = box.querySelector<HTMLSelectElement>("#dl-map")!, modeSel = box.querySelector<HTMLSelectElement>("#dl-mode")!;
  let bombMaps: string[] | null = null;
  const fillMaps = () => {
    // the maps of the mode (Matches.xml Rule 1 = Death Match, Rule 2 = Bomb Mission; the bomb also needs its sites), one entry per server map id
    const bomb = modeSel.value === "bomb", ids = bomb ? BOMB_SERVER_MAP_IDS : TDM_SERVER_MAP_IDS, seen = new Set<number>();
    const list = AVAILABLE_MAPS.filter((m) => {
      const id = mapIndexEntry(m)?.mapId;
      if (id == null || !ids.has(id) || seen.has(id) || (bomb && bombMaps && !bombMaps.includes(m))) return false;
      seen.add(id);
      return true;
    });
    mapSel.innerHTML = list.map((m) => opt(m, MAP_LABELS[m] ?? m)).join("");
  };
  fillMaps();
  void fetch("/assets/cross/maps/bombsites.json").then((r) => r.json()).then((j) => { bombMaps = Object.keys(j.maps); fillMaps(); }).catch(() => {});
  modeSel.addEventListener("change", fillMaps);
  const v = (id: string) => (box.querySelector<HTMLInputElement | HTMLSelectElement>(`#${id}`)!).value;
  box.querySelector("#dl-x")!.addEventListener("click", () => box.remove());
  box.querySelector("#dl-go")!.addEventListener("click", () => {
    const p = new URLSearchParams(saved);
    for (const k of KEYS) p.delete(k);
    p.set("mode", v("dl-mode"));
    p.set("team", v("dl-team"));
    // spectator: you are not in the match, 8 bots per side (Destruição: they plant / defuse); the bot fields are ignored
    const spec = (box.querySelector("#dl-spec") as HTMLInputElement).checked;
    if (spec) p.set("spectate", "1");
    p.set("bots", spec ? "16" : v("dl-bots"));
    p.set("allies", spec ? "8" : v("dl-allies"));
    if (Number(v("dl-rounds")) > 0) p.set("rounds", v("dl-rounds"));
    if (v("dl-spawn")) p.set("bombspawn", v("dl-spawn"));
    if (v("dl-planted")) p.set("bombplanted", v("dl-planted"));
    if ((box.querySelector("#dl-rings") as HTMLInputElement).checked) p.set("bombrings", "1");
    history.replaceState(null, "", `${location.pathname}?${p}${location.hash}`);
    devSaved = saved;
    box.remove();
    start(v("dl-map"));
  });
}

let devSaved: string | null = null;
/** the query string to restore after a launcher match (null: none was started) */
export function takeDevSaved(): string | null {
  const s = devSaved;
  devSaved = null;
  return s;
}
