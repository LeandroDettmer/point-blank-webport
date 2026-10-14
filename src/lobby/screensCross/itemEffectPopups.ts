// "Usar" of the cash effect items that are not names: crosshair colour (1600014), PB Inspector (1600085), muzzle colour
// (1600187), nick border colour (1600205) and clan name colour (1600005). Names and the nick colour
// live in itemNamePopups.ts; this module reuses its colour popup (useItemChangeColorPopup) and the crosshair popup
// (pbHud/crosshairColorPopup.ts). Server: server itemHandlers.ts handleUseItem (1052 argument per effect).
// [RECRIADO] the PB Inspector slot dialog and its equipment text (the exe's inspector window is not in the Cross pack),
// the palette of the muzzle / border / clan colours (the 10-box colour popup) and the captions that have no key in String_Brazil.
import { openCrosshairColorPopup } from "../../game/pbHud/crosshairColorPopup.ts";
import { crosshairIndex, setCrosshairIndex } from "../../gameplay/settings.ts";
import type { InventoryItem } from "../types.ts";
import type { InspectorEquip } from "../state/itemUse.ts";
import { itemName } from "../state/itemNames.ts";
import { useEffectOf } from "../state/singleEquip.ts";
import { type PageCtx } from "./pages/common.ts";
import { nickColorPopup } from "./itemNamePopups.ts";

export type EffectKind = "crosshair" | "inspector" | "muzzle" | "border" | "clanColor";

const KIND_OF: Record<number, EffectKind> = {
  1600014: "crosshair", 1600085: "inspector", 1600187: "muzzle", 1600205: "border", 1600005: "clanColor",
};

/** the kind of a use item this module opens (null = not one of them); the cash items map through useEffectOf */
export function effectItemKind(itemId: number): EffectKind | null {
  return KIND_OF[useEffectOf(itemId)] ?? null;
}

const hex = (code: number): string => `0x${(code >>> 0).toString(16)}`;

// ---- PB Inspector (1600085): a room slot picked in a dialog, then the slot's equipment in the message box [RECRIADO]

const SLOT_LABELS: [keyof Omit<InspectorEquip, "blocks">, string][] = [["accessory", "Acessório"], ["dino", "Dino"], ["spray", "Spray"], ["nameCard", "Cartão de nome"]];
const BLOCK_LABELS: [number, string][] = [
  [0, "Arma primária"], [1, "Arma secundária"], [2, "Faca"], [3, "Granada"], [4, "Arma especial"], [8, "Personagem"],
  [9, "Cabeça"], [10, "Rosto"], [11, "Jaqueta"], [12, "Bolso"], [13, "Luva"], [14, "Cinto"], [15, "Coldre"], [16, "Pele"], [17, "Boina"],
];

export function inspectorText(e: InspectorEquip, nick: string): string {
  const lines = [`${nick}`];
  for (const [k, label] of SLOT_LABELS) {
    const p = e[k];
    if (p.itemId) lines.push(`${label}: ${itemName(p.itemId).name}`);
  }
  for (const [i, label] of BLOCK_LABELS) {
    const p = e.blocks[i];
    if (p?.itemId) lines.push(`${label}: ${itemName(p.itemId).name}`);
  }
  return lines.length > 1 ? lines.join("\n") : `${nick}\nSem equipamento.`;
}

/** dialog with a native select of the room's players; resolves to the slot index or null (cancel) */
function pickSlot(ctx: PageCtx, title: string, rows: { slot: number; label: string }[]): Promise<number | null> {
  return new Promise((done) => {
    const back = document.createElement("div");
    back.style.cssText = "position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.45);z-index:70";
    const panel = document.createElement("div");
    panel.style.cssText = "background:#1d2530;color:#fff;padding:16px;min-width:260px;font:14px Arial,sans-serif;border:1px solid #567";
    const head = document.createElement("div");
    head.textContent = title;
    head.style.marginBottom = "10px";
    const sel = document.createElement("select");
    sel.style.cssText = "width:100%;font:14px Arial,sans-serif";
    for (const r of rows) {
      const o = document.createElement("option");
      o.value = String(r.slot);
      o.textContent = r.label;
      sel.appendChild(o);
    }
    const row = document.createElement("div");
    row.style.cssText = "display:flex;gap:8px;justify-content:flex-end;margin-top:12px";
    const close = (v: number | null) => { back.remove(); done(v); };
    const mk = (label: string, fn: () => void) => {
      const b = document.createElement("button");
      b.textContent = label;
      b.style.cssText = "min-width:72px;padding:4px 8px;font:13px Arial,sans-serif";
      b.addEventListener("click", fn);
      return b;
    };
    row.append(
      mk(ctx.str("STBL_IDX_CLAN_BUTTON_OK", "Confirmar"), () => close(Number(sel.value))),
      mk(ctx.str("STBL_IDX_CLAN_BUTTON_CANCEL", "Cancelar"), () => close(null)),
    );
    panel.append(head, sel, row);
    back.appendChild(panel);
    document.body.appendChild(back);
  });
}

async function useInspectorItem(ctx: PageCtx, item: InventoryItem): Promise<void> {
  const c = ctx.ctl, s = c.session;
  if (!s) return;
  const room = c.roomScreen?.room;
  if (!room) { c.say("O inspetor só funciona dentro da sala.", true); return; } // [RECRIADO] text
  const rows = room.slots.filter((x) => x.nick && x.state !== 1).map((x) => ({ slot: x.slot, label: `${x.slot + 1} - ${x.nick}`, nick: x.nick }));
  if (rows.length === 0) { c.say("Não há jogadores na sala.", true); return; } // [RECRIADO] text
  const slot = await pickSlot(ctx, itemName(item.itemId).name, rows);
  if (slot === null) return;
  const r = await s.inspect(item, slot);
  if (r.code !== 1 || !r.equip) { c.say(`Não foi possível usar o inspetor (${hex(r.code)}).`, true); return; }
  c.msg = { text: inspectorText(r.equip, rows.find((x) => x.slot === slot)?.nick ?? ""), onOk: () => {}, onCancel: () => {} };
  c.draw();
}

// ---- entry point

/** "Usar" of an effect item: opens its popup and sends 1052 on OK. Only call it when effectItemKind() is set. */
export async function useEffectItem(ctx: PageCtx, item: InventoryItem, kind: EffectKind): Promise<void> {
  const c = ctx.ctl, s = c.session;
  if (!s) return;
  const name = itemName(item.itemId).name;
  switch (kind) {
    case "crosshair": {
      const idx = await openCrosshairColorPopup(document.body, crosshairIndex());
      if (idx === null) return;
      const code = await s.useItemByte(item, idx);
      if (code !== 1) { c.say(`Não foi possível trocar a cor da mira (${hex(code)}).`, true); return; }
      setCrosshairIndex(idx); // the battle HUD follows the setting (hud.ts onCrosshair)
      c.say("Cor da mira alterada.", true); // [RECRIADO] text
      return;
    }
    case "inspector":
      await useInspectorItem(ctx, item);
      return;
    case "border":
    case "clanColor":
    case "muzzle": {
      // 1600205 reads 1 byte; 1600005 / 1600187 read a u32 (server handleUseItem)
      const send = (index: number) => (kind === "border" ? s.useItemByte(item, index) : s.useItemU32(item, index));
      const title: Record<"border" | "clanColor" | "muzzle", [string, string]> = {
        border: ["STR_HEADER_COLOR_NICK_BORDER", "Borda do apelido"],
        clanColor: ["STR_HEADER_COLOR_CLAN_NAME", "Cor do nome do clã"],
        muzzle: ["STR_HEADER_COLOR_MUZZLE", "Cor da chama do cano"],
      };
      const p = await nickColorPopup(ctx);
      // 0x8a5050 (clan name colour): opens on my clan's colour (basic info +0x5f), ApplyValue = my clan name (+0x48, 0x8a5112);
      // the border / muzzle popups are not among the 0x4ad850 callers: no current colour, no applied name [INFERIDO]
      const pr = s.player.state.profile, clan = kind === "clanColor";
      p.show(name, clan ? pr?.clanNameColor ?? 0 : 0, {
        ok: (index) => void send(index).then((code) => {
          if (code !== 1) { c.say(`Não foi possível trocar a cor (${hex(code)}).`, true); return; }
          p.close();
          c.say("Cor alterada.", true); // [RECRIADO] text
        }, () => c.say("Não foi possível trocar a cor.", true)),
      }, title[kind], clan ? { label: ["STR_POPUP_APPLIED_CLAN_NAME", "Nome do clã aplicado:"], name: pr?.clanName ?? "" } : null);
      return;
    }
  }
}
