// Smoke of the Cross phase / step slides (screensCross/slide.ts) at 60 Hz in a 1024x768 view: the timeline of
// window places (design px = .gui place + offset) and sounds for boot -> server list, server list -> channel list
// (exit 1/3 s, then entrance 0.5 s), and lobby -> inventory -> lobby (step and phase slide in the same frames).
//   npx --no-install tsx src/lobby/screensCross/dev/slide.smoke.ts
import assert from "node:assert/strict";
import { CrossStage, GuiSlide, tableSin, type CrossTarget } from "../slide.ts";

const W = 1024, H = 768, DT = 1 / 60;
const sounds: string[] = [];
let frame = 0;
const fx = new CrossStage((s) => sounds.push(`${frame}:${s}`));
const run = (n: number, log?: (f: number) => string | null) => {
  for (let i = 0; i < n; i++) {
    frame++;
    fx.frame(DT, W, H);
    const line = log?.(frame);
    if (line) console.log(line);
  }
};
const ask = (t: CrossTarget) => fx.want(t);
const r = (v: number) => Math.round(v * 10) / 10;

// table sin / cos: 512 entries per turn, within one step of Math.sin
for (let t = 0; t <= 1; t += 0.01) assert.ok(Math.abs(tableSin(t * Math.PI / 2) - Math.sin(t * Math.PI / 2)) < 0.013);

// one slide: in 0.5 s, out 1/3 s
const g = new GuiSlide();
g.slideIn();
let n = 0;
while (g.state !== 0) { g.update(DT, W, H); n++; }
assert.equal(n, 30, "slide in = 30 frames at 60 Hz (t += 2 dt)");
g.slideOut();
n = 0;
while ((g.state as number) !== 1) { g.update(DT, W, H); n++; }
assert.equal(n, 20, "slide out = 20 frames at 60 Hz (t += 3 dt)");
assert.deepEqual([g.x, g.y], [W, H]);

// boot: the server list enters (ssServerListWin y = 35 + offY)
console.log("== boot -> server list (ssServerListWin y)");
ask({ phase: "servers", step: null });
run(36, (f) => (f % 3 === 0 || f <= 3 ? `f${f} t=${r((f) * DT * 1000)}ms state=${fx.state} y=${r(35 + fx.slides.servers.y)}` : null));
assert.equal(fx.state, 4);
assert.equal(fx.slides.servers.y, 0);
assert.deepEqual(sounds, ["2:in"], "UI_Scroll_In on the entrance start frame (frame 1 takes the queued phase)");

// server list -> channel list: the list leaves downward, then ssServerWin comes in from the right (x = 522 + offX)
console.log("== server list -> channel list (ssServerListWin y, ssServerWin x)");
sounds.length = 0;
const f0 = frame;
ask({ phase: "channels", step: null });
let exitEnd = -1, inStart = -1, inEnd = -1;
run(70, (f) => {
  const sv = fx.slides.servers, ch = fx.slides.channels;
  if (exitEnd < 0 && sv.state === 1) exitEnd = f;
  if (inStart < 0 && ch.state === 2) inStart = f;
  if (inEnd < 0 && ch.state === 0) inEnd = f;
  return (f - f0) % 4 === 0 ? `f+${f - f0} state=${fx.state} serversY=${r(35 + sv.y)} (${sv.state}) channelsX=${r(522 + ch.x)} (${ch.state})` : null;
});
assert.equal(exitEnd - f0, 2 + 20, "exit: 1 frame to see the queue, 1 for OnExitStart, then 20 frames");
assert.equal(inStart - exitEnd, 3, "entrance starts 3 frames after the exit ends (states 7 -> 0 -> 1 -> SlideIn)");
assert.equal(inEnd - inStart, 30);
assert.deepEqual(sounds, [`${f0 + 2}:out`, `${inStart}:in`]);
assert.ok(!fx.input("servers") && fx.input("channels"));

// lobby -> inventory -> lobby
console.log("== lobby -> inventory (Lobby x, Inventory y) -> lobby");
ask({ phase: "lobby", step: null });
run(60);
assert.equal(fx.cur, "lobby");
assert.ok(fx.input("lobby"));
sounds.length = 0;
const f1 = frame;
ask({ phase: "lobby", step: "inventory" });
assert.deepEqual(sounds, [`${f1}:out`, `${f1}:in`], "ChangeStep: phase Scroll_Out + step Scroll_In at once");
assert.equal(fx.slides.inventory.y, H, "OnStart's OnUpdate(0) puts the step below the view");
run(30, (f) => ((f - f1) % 5 === 0 ? `f+${f - f1} lobbyX=${r(fx.slides.lobby.x)} (${fx.slides.lobby.state}) inventoryY=${r(fx.slides.inventory.y)} (${fx.slides.inventory.state})` : null));
assert.equal(fx.slides.lobby.state, 1);
assert.equal(fx.slides.inventory.state, 0);
assert.ok(!fx.input("lobby") && fx.input("inventory"));
sounds.length = 0;
ask({ phase: "lobby", step: null });
assert.deepEqual(sounds, [`${frame}:in`], "closing: step OnEnd (no sound), phase slides in (Scroll_In)");
run(30);
assert.equal(fx.slides.lobby.state, 0);
assert.equal(fx.slides.inventory.state, 1);
assert.ok(!fx.enabled.has("inventory"), "the step disables itself once out");
assert.equal(fx.state, 4, "a step never runs the phase state machine");
console.log("slide smoke ok");
