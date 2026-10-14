/** perf probe counters (ms summed per frame), printed and reset every 2 s by main.ts perfTick */
export interface BotPerf { loop: number; perceive: number; move: number; visual: number; fire: number; steps: number }

export function botPerf(): BotPerf {
  const g = globalThis as { __pbPerfBots?: BotPerf };
  return (g.__pbPerfBots ??= { loop: 0, perceive: 0, move: 0, visual: 0, fire: 0, steps: 0 });
}
