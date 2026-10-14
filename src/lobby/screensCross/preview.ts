// Background of the Cross lobby pages: the CReadyBg showroom (showroom.ts) with the player's character in it, drawn by the
// 2017 lobby's ItemPreview (screens/preview3d.ts) on one full-stage canvas under every window. The character / weapon is
// the one the Lobby2017 controller picks for the page (Lobby2017.showroom: team character, equipped primary, the inspected
// player in the room, the selected shop weapon...).
import { loadCharaAsset } from "../assetLoader.ts";
import type { Lobby2017 } from "../core/controller.ts";
import type { Page } from "../core/model.ts";
import { ItemPreview, charaLod } from "../screens/preview3d.ts";
import type { ItemTab } from "../state/itemInfo.ts";
import { CrossShowroom, type CameraLook } from "./showroom.ts";

/** CStageReady::ChangeStep 0x5135d0: no step (servers, lobby, room) = Idle (0x513a04), profile = Left (0x513a87);
 * CStepInventory (0x842604) and CStepShop (0x84d697) ask Right */
const LOOK: Record<Page, CameraLook> = { channels: 0, lobby: 0, room: 0, inventory: 2, shop: 2, profile: 1, clan: 0 };

// Background fetch of the models a shop / inventory grid shows, before the player clicks one: the preview loads the clicked
// model only on click (showroom.ts / preview3d.ts show), so the first click waited for the download. Each grid paint replaces
// the queue (a page change or a scroll drops what has not started); two loads at a time. The click joins a load in flight
// (assetLoader.ts once, worldModel glbCache), so it never fetches twice. A failed id is not retried this session.
const LANES = 2;
let queue: [kind: "chara" | "weapon", id: number][] = [];
let lanes = 0;
const failed = new Set<string>();

/** `tab` of the grid: chara = the character (body + arms), weapon = the weapon the preview holds (createWeaponModel); item shows no 3D */
export function prefetchModels(tab: ItemTab, ids: number[]): void {
  const kind = tab === "chara" ? "chara" : tab === "weapon" ? "weapon" : null;
  queue = kind ? ids.filter((id) => id && !failed.has(`${kind}:${id}`)).map((id) => [kind, id]) : [];
  pump();
}

function pump(): void {
  while (lanes < LANES && queue.length) {
    const [kind, id] = queue.shift()!;
    lanes++;
    const load = kind === "chara"
      ? loadCharaAsset(id, charaLod()).then(() => true)
      : import("../../weapons/worldModel.ts").then((m) => m.createWeaponModel(id)).then((w) => !!w); // lazy: as preview3d does
    void load.catch(() => false).then((ok) => {
      if (!ok) failed.add(`${kind}:${id}`);
      lanes--;
      pump();
    });
  }
}

export class CrossPreview {
  private showroom = new CrossShowroom();
  private view: ItemPreview;
  private ro: ResizeObserver;

  /** `design`: the stage's design element. The canvas goes into the stage itself (the whole window), under the stretched
   * design box: fixed vertical FOV, aspect of the window (showroom.ts FOV_DEG), as the exe's viewer */
  constructor(design: HTMLElement, private ctl: Lobby2017) {
    const host = design.parentElement ?? design;
    this.view = new ItemPreview(1024, 768, this.showroom);
    this.view.el.style.left = "0px";
    this.view.el.style.top = "0px";
    host.insertBefore(this.view.el, host.firstChild);
    const fit = () => this.view.resize(host.clientWidth, host.clientHeight);
    this.ro = new ResizeObserver(fit);
    this.ro.observe(host);
    fit();
    void this.view.show(0, true).catch(() => {});
  }

  paint(): void {
    const c = this.ctl;
    this.showroom.setLook(LOOK[c.page]);
    if (c.loading) return; // the character on screen stays until the page has loaded
    // no character before a channel is entered (the server list has no preview3d overlay) [INFERIDO]
    // the room shows its character on the 2017 MapInfo scene's "chara" tab only: the Cross room always has it
    if (c.page === "room" && c.roomTab !== "chara") { c.roomTab = "chara"; queueMicrotask(() => c.draw()); }
    const pv = c.showroom();
    // the Cross profile keeps the showroom character (CStepProfile 0x867000-0x86a000 only calls the look wrapper 0x6fb8d0,
    // nothing hides it): the lobby's character and weapon (team red chara, primary) [INFERIDO]
    const s = c.page === "profile" ? c.session : null;
    const itemId = s ? s.player.teamCharas().red : pv.itemId;
    const weaponId = s ? s.player.weaponLoadout().primary : pv.weaponId;
    void this.view.show(itemId, true, weaponId).catch(() => {});
  }

  dispose(): void {
    this.ro.disconnect();
    this.view.dispose();
  }
}
