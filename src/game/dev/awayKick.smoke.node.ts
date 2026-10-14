// Node smoke test: in-battle away kick clock (awayChecker.ts, CStageBattle 0x76c360) with a fake clock.
//   node --experimental-transform-types src/game/dev/awayKick.smoke.node.ts
import { AWAY_CAUTION_LEAD_SEC, AWAY_COUNTDOWN_SEC, AWAY_INPUT_SEC, AwayTimer, awayRearm, type AwayTick } from "../awayChecker.ts";

let fails = 0;
const check = (name: string, ok: boolean, info = "") => {
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${info ? "  " + info : ""}`);
};

/** runs `sec` of frames at `hz`; returns every tick plus the time of the first warn / kick */
function run(t: AwayTimer, sec: number, hz = 60, opt: { input?: (time: number) => boolean; paused?: (time: number) => boolean } = {}) {
  const dt = 1 / hz;
  let time = 0, warnAt = -1, kickAt = -1, kicks = 0;
  const warns = new Set<number>();
  for (let i = 0; i < Math.round(sec * hz); i++) {
    time += dt;
    const tick: AwayTick = t.update(dt, opt.input?.(time) ?? false, opt.paused?.(time) ?? false);
    if (tick.warn !== null) { warns.add(tick.warn); if (warnAt < 0) warnAt = time; }
    if (tick.kick) { kicks++; if (kickAt < 0) kickAt = time; }
  }
  return { warnAt, kickAt, kicks, warns };
}
const near = (a: number, b: number, eps = 0.05) => Math.abs(a - b) <= eps;

check("limit is the exe 60 s, caution 5 s before (exe 60 / 55)", AWAY_INPUT_SEC === 60 && AWAY_CAUTION_LEAD_SEC === 5 && AWAY_COUNTDOWN_SEC === 5);

// 1. no input at all: caution at 55 s, kick at 60 s, once
{
  const r = run(new AwayTimer(), 400);
  check("idle: caution box at limit - 5 s", near(r.warnAt, AWAY_INPUT_SEC - AWAY_CAUTION_LEAD_SEC), `warnAt=${r.warnAt.toFixed(2)}`);
  check("idle: kick at the limit", near(r.kickAt, AWAY_INPUT_SEC), `kickAt=${r.kickAt.toFixed(2)}`);
  check("idle: one kick only", r.kicks === 1, `kicks=${r.kicks}`);
  // cvttss2si: the box shows the truncated rest, 4..0 (5 only on the frame it opens in the exe, before its first redraw)
  check("countdown text 4..0", [4, 3, 2, 1, 0].every((n) => r.warns.has(n)) && !r.warns.has(6), [...r.warns].join(","));
}

// 2. input every 50 s: never kicked
{
  const r = run(new AwayTimer(), 30 * 60, 60, { input: (t) => Math.floor(t * 60) % (50 * 60) === 0 });
  check("input every 50 s: no caution, no kick", r.warnAt < 0 && r.kicks === 0, `warnAt=${r.warnAt} kicks=${r.kicks}`);
}

// 3. input during the caution closes the box and re-arms the full limit
{
  const t = new AwayTimer();
  const r = run(t, 600, 60, { input: (s) => near(s, 57, 0.009) });
  check("input in the countdown: box closes, kick moves to input + limit", near(r.kickAt, 57 + AWAY_INPUT_SEC, 0.05), `kickAt=${r.kickAt.toFixed(2)}`);
}

// 4. round end / result screen pause the clock: no kick while paused, the rest runs after
{
  const r = run(new AwayTimer(), 600, 60, { paused: (s) => s >= 30 && s < 90 });
  check("paused 60 s: kick 60 s later", near(r.kickAt, AWAY_INPUT_SEC + 60), `kickAt=${r.kickAt.toFixed(2)}`);
  const p = run(new AwayTimer(), 600, 60, { paused: (s) => s > 1 });
  check("paused from the start: never kicked", p.kicks === 0 && p.warnAt < 0);
}

// 5. hidden tab: main.ts stepOnly drives update at ~1 Hz with the real elapsed time
{
  const r = run(new AwayTimer(), 400, 1);
  check("1 Hz hidden-tab steps: kick at the limit", near(r.kickAt, AWAY_INPUT_SEC, 1.01), `kickAt=${r.kickAt}`);
}

// 6. reset() = SetAwayInputTime: full time again after a kick
{
  const t = new AwayTimer();
  run(t, 61);
  t.reset();
  const r = run(t, 400);
  check("reset after a kick: armed again", near(r.kickAt, AWAY_INPUT_SEC), `kickAt=${r.kickAt.toFixed(2)}`);
}

// 7. dead / spectating re-arm (0x76c460..0x76c4b8, alive = 0x76d120): Bomb / Annihilation only
{
  check("awayRearm: input always re-arms", awayRearm(true, false, true) && awayRearm(true, true, true));
  check("awayRearm: dead in a round mode re-arms", awayRearm(false, true, false));
  check("awayRearm: alive in a round mode does not", !awayRearm(false, true, true));
  check("awayRearm: dead in TDM does not (dead time counts)", !awayRearm(false, false, false));

  // Bomb, no input at all, dead from 10 s to 200 s (then a new round spawns him): no kick while dead, the full limit after
  const dead = (s: number) => s >= 10 && s < 200;
  const bomb = run(new AwayTimer(), 600, 60, { input: (s) => awayRearm(false, true, !dead(s)) });
  check("Bomb dead 190 s: no caution / kick while dead", bomb.warnAt < 0 || bomb.warnAt >= 200, `warnAt=${bomb.warnAt.toFixed(2)}`);
  check("Bomb dead: kick = respawn + limit", near(bomb.kickAt, 200 + AWAY_INPUT_SEC), `kickAt=${bomb.kickAt.toFixed(2)}`);
  check("Bomb dead: caution = respawn + limit - 5 s", near(bomb.warnAt, 200 + AWAY_INPUT_SEC - AWAY_CAUTION_LEAD_SEC), `warnAt=${bomb.warnAt.toFixed(2)}`);

  // Bomb, sits the whole match out as a spectator (joined a running round): never kicked
  const spec = run(new AwayTimer(), 30 * 60, 60, { input: () => awayRearm(false, true, false) });
  check("Bomb spectator 30 min: never kicked", spec.kicks === 0 && spec.warnAt < 0, `kicks=${spec.kicks}`);

  // Bomb, killed during the caution countdown: the box closes on that frame (0x520e40) and the clock is full again
  const t = new AwayTimer();
  const open = run(t, 57.5);
  const closed = t.update(1 / 60, awayRearm(false, true, false), false);
  check("Bomb killed in the countdown: box closes", open.warnAt > 0 && closed.warn === null && !closed.kick);
  const k = run(new AwayTimer(), 600, 60, { input: (s) => awayRearm(false, true, !(s >= 57 && s < 100)) });
  check("Bomb killed in the countdown: kick = respawn + limit", near(k.kickAt, 100 + AWAY_INPUT_SEC), `kickAt=${k.kickAt.toFixed(2)}`);

  // TDM: dead time counts (respawn modes are not in the exe's list), same kick time as never dying
  const tdm = run(new AwayTimer(), 400, 60, { input: (s) => awayRearm(false, false, !(s >= 10 && s < 20)) });
  check("TDM dead 10 s: kick at the limit (dead time counts)", near(tdm.kickAt, AWAY_INPUT_SEC), `kickAt=${tdm.kickAt.toFixed(2)}`);
}

console.log(fails ? `\n${fails} FAILED` : "\nall ok");
process.exit(fails ? 1 : 0);
