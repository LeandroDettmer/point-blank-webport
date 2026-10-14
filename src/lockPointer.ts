// Pointer lock with raw mouse counts (no OS acceleration): the original reads raw DirectInput counts
// (i3InputDx 0x100ae220). Browsers without `unadjustedMovement` (Firefox/Safari) fall back to the plain lock.
export function lockPointer(): Promise<void> {
  const body = document.body as { requestPointerLock(o?: { unadjustedMovement: boolean }): Promise<void> | void };
  try {
    return Promise.resolve(body.requestPointerLock({ unadjustedMovement: true })).catch(() =>
      Promise.resolve(body.requestPointerLock()));
  } catch {
    return Promise.resolve(body.requestPointerLock());
  }
}
