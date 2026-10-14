// The Cross menu-bar pages (inventory / shop / profile / clan) and the 3D character: one entry point for app.ts. The pages build
// into their own layer, put under `above` (the menu bar: the menu bar and the message box stay on top of them). The clan menu
// is a controller page too (mbClan -> openClan, page "clan"): it replaces the lobby in the same layer.
import type { Lobby2017 } from "../../core/controller.ts";
import { CrossPreview } from "../preview.ts";
import type { PageCtx, Str } from "./common.ts";
import { ClanPage } from "./clan.ts";
import { CommunityPage, type OpenMenu } from "./community.ts";
import { InvenPage, useCosmeticItem } from "./inven.ts";
import { ProfilePage } from "./profile.ts";
import { ShopPage } from "./shop.ts";

export class CrossPages {
  private pages: { paint(): void }[] = [];
  private preview: CrossPreview;
  private clan: ClanPage | null = null;
  private community: CommunityPage | null = null;

  constructor(design: HTMLElement, above: HTMLElement | undefined, ctl: Lobby2017, str: Str, addFriend: (nick: string) => void, inviteFriend: (nick: string) => void, openMenu: OpenMenu) {
    this.preview = new CrossPreview(design, ctl);
    const layer = document.createElement("div");
    layer.style.cssText = "position:absolute;left:0;top:0;width:0;height:0;";
    design.insertBefore(layer, above ?? null);
    const ctx: PageCtx = { ctl, layer, str };
    ctl.cosmeticUse = (it) => useCosmeticItem(ctx, it);
    void Promise.all([InvenPage.create(ctx), ShopPage.create(ctx), ProfilePage.create(ctx)])
      .then((pages) => { this.pages = pages; ctl.draw(); })
      .catch((e) => console.warn("[cross] pages", e));
    void ClanPage.create(ctx)
      .then((clan) => { this.clan = clan; ctl.draw(); })
      .catch((e) => console.warn("[cross] clan", e));
    void CommunityPage.create(ctx, addFriend, inviteFriend, openMenu)
      .then((community) => { this.community = community; ctl.draw(); })
      .catch((e) => console.warn("[cross] community", e));
  }

  /** mbCommunity (menu bar): the Comunidade window */
  openCommunity(): void { this.community?.openWindow(); }
  communityOpen(): boolean { return !!this.community?.isOpen; }
  /** Buscar do menu de amigo (app.ts pickContext): seleciona o nick na lista de amigos */
  findFriend(nick: string): void { this.community?.findFriend(nick); }

  paint(): void {
    for (const p of this.pages) p.paint();
    this.clan?.paint();
    this.community?.paint();
    this.preview.paint();
  }
}
