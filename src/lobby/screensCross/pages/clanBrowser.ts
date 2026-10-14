// Clan list + info panel of the clan menu (ClanNonMemberWin clanClanListWin / clanSubscriberWin, and the search tab of
// ClanMemberWin): 997 list pages (15 rows; the server reads the list start as one byte, so only the first 256 clans are
// reachable [LACUNA]), 800 detail per visible row for date / members and for the info panel. Search: the server ignores the
// name filter, so the page loads the list and filters the names here [RECRIADO].
import type { ClanClient, ClanDetail, ClanSummary } from "../../../net/clanClient.ts";
import type { I3Gui } from "../../ui/i3Gui.ts";
import { nickCss, onClick } from "./common.ts";
import { clanDate } from "../clanRules.ts";
import { paintMark } from "../clanMarkView.ts";

/** the list start is one byte on the wire (997 `C start`) */
const START_LIMIT = 256;

export interface BrowseNames {
  /** visible rows (controls `name(i)`, `day(i)`, `members(i)` for i = 1..rows) */
  rows: number;
  name: (i: number) => string;
  day: (i: number) => string;
  members: (i: number) => string;
  /** the list's scroll frame (ListScroll control) */
  scroll: string;
  /** info panel value controls (null: the window has no such field) */
  info: { name: string; master: string; rank: string; staff: string; order: string; exp: string; address: string | null; intro: string | null };
  viewAll: string;
  search: { edit: string; button: string } | null;
  /** emblem controls: a row's mark (`row(i)`, i = 1..rows; the row's own logo) and the info panel's mark (the picked clan's logo) */
  mark: { row: (i: number) => string; panel: string };
}

export class ClanBrowser {
  private all: ClanSummary[] = [];
  private total = 0;
  /** list index of the next page to ask */
  private loadedTo = 0;
  private done = false;
  private shown: ClanSummary[] = [];
  private top = 0;
  private filter = "";
  /** clan picked in the list (0 = none) */
  selected = 0;
  private details = new Map<number, ClanDetail>();
  private asking = new Set<number>();
  private missing = new Set<number>();
  /** one 800 at a time: ClanClient.ask takes the first 801 that comes, so parallel asks would all get the same clan */
  private detailQueue: Promise<void> = Promise.resolve();
  private thumb: (top: number, total: number, visible: number) => void;

  constructor(private gui: I3Gui, private names: BrowseNames, private client: () => ClanClient | null, private redraw: () => void, private failed: (what: string) => void) {
    for (let i = 1; i <= names.rows; i++) for (const c of [names.name(i), names.day(i), names.members(i)]) onClick(gui, c, () => this.pick(i));
    onClick(gui, names.viewAll, () => this.viewAll());
    if (names.search) {
      gui.edit(names.search.edit, {
        maxLength: 17,
        onInput: (v) => { this.filter = v.trim(); this.top = 0; this.applyFilter(); },
        onEnter: (v) => { this.filter = v.trim(); this.top = 0; void this.loadAll(); },
      });
      gui.button(names.search.button, () => { this.top = 0; void this.loadAll(); });
    }
    this.thumb = gui.scrollList(names.scroll, (d) => { this.top = Math.max(0, Math.min(this.visibleMax(), this.top + d)); this.redraw(); });
  }

  /** drop the list (the window closed or the account changed clan) */
  reset(): void {
    this.all = []; this.total = 0; this.loadedTo = 0; this.done = false; this.shown = []; this.top = 0; this.filter = ""; this.selected = 0;
    this.details.clear(); this.asking.clear(); this.missing.clear();
  }

  /** the picked clan's detail (null until it arrives) */
  get detail(): ClanDetail | null { return this.selected ? this.details.get(this.selected) ?? null : null; }
  get pickedId(): number { return this.selected; }
  get count(): number { return this.total; }

  private canLoad(): boolean { return !this.done && this.loadedTo < Math.min(this.total || START_LIMIT, START_LIMIT); }

  /** 997: the next page of the list (the first call opens the list) */
  async loadNext(): Promise<void> {
    const c = this.client();
    if (!c || !this.canLoad()) return;
    const r = await c.list(this.loadedTo);
    if (!r.ok || !r.data) { this.failed("list"); this.done = true; return; }
    this.total = r.data.total;
    this.all.push(...r.data.clans);
    this.loadedTo += r.data.clans.length;
    if (!r.data.clans.length || this.loadedTo >= this.total) this.done = true;
    this.applyFilter();
  }

  /** every page the server can name (search) */
  async loadAll(): Promise<void> {
    while (this.canLoad()) await this.loadNext();
    this.applyFilter();
  }

  /** "Ver tudo": the next rows; past the last one, the next page from the server, then the first rows again */
  private viewAll(): void {
    const next = this.top + this.names.rows;
    if (next < this.shown.length) { this.top = next; this.redraw(); return; }
    if (this.canLoad()) { void this.loadNext().then(() => { this.top = next < this.shown.length ? next : 0; this.redraw(); }); return; }
    this.top = 0;
    this.redraw();
  }

  private visibleMax(): number { return Math.max(0, this.shown.length - this.names.rows); }

  private applyFilter(): void {
    const f = this.filter.toLowerCase();
    this.shown = f ? this.all.filter((c) => c.name.toLowerCase().includes(f)) : this.all.slice();
    this.top = Math.min(this.top, this.visibleMax());
    this.redraw();
  }

  /** click on visible row i (1-based): picks the clan and asks its detail */
  private pick(i: number): void {
    const c = this.shown[this.top + i - 1];
    if (!c) return;
    this.selected = c.id;
    this.askDetail(c.id);
    this.redraw();
  }

  /** 800 once per clan (cached; a failed one is not asked again) */
  askDetail(id: number): void {
    if (this.details.has(id) || this.asking.has(id) || this.missing.has(id)) return;
    const c = this.client();
    if (!c) return;
    this.asking.add(id);
    this.detailQueue = this.detailQueue.then(() => c.detail(id)).then((r) => {
      if (r.ok && r.data) this.details.set(id, r.data); else this.missing.add(id);
    }, (e) => { this.missing.add(id); console.warn("[cross] clan detail", e); }).finally(() => {
      this.asking.delete(id);
      this.redraw();
    });
  }

  /** the visible rows and the info panel */
  paint(): void {
    const n = this.names, rows = this.shown.slice(this.top, this.top + n.rows);
    for (let i = 1; i <= n.rows; i++) {
      const c = rows[i - 1], d = c ? this.details.get(c.id) : undefined;
      if (c && !d) this.askDetail(c.id);
      for (const ctl of [n.name(i), n.day(i), n.members(i)]) this.gui.show(ctl, !!c);
      this.gui.setText(n.name(i), c?.name ?? "");
      this.gui.setText(n.day(i), d ? clanDate(d.createDate) : "");
      this.gui.setText(n.members(i), d ? `${d.members}/${d.maxPlayers}` : "");
      // 0x8591b6 (search) / 0x868137 (non-member): 0x4ad850(LisClanName, name +4, clan name colour +0x20); the 997 row's colour
      // byte is 0 on the wire, so it comes from the row's 800 detail. The exe marks the pick with the ListSelect bar (hidden
      // here): the yellow name of the picked row stands in for it [RECRIADO]
      this.gui.setColor(n.name(i), c && c.id === this.selected ? "#ffd200" : nickCss(d?.nameColor));
      paintMark(this.gui, n.mark.row(i), c ? c.logo : null);
    }
    this.thumb(this.top, this.shown.length, n.rows);
    const d = this.detail, f = n.info;
    this.gui.setText(f.name, d?.name ?? "");
    // 0x85950f (clanSearchClanNameValue) / 0x8676fa (clanNonMemberClanNameValue): the name in the clan name colour
    this.gui.setColor(f.name, nickCss(d?.nameColor));
    this.gui.setText(f.master, d?.ownerNick ?? "");
    this.gui.setText(f.rank, d ? `${d.unit}` : "");
    this.gui.setText(f.staff, d ? `${d.members}/${d.maxPlayers}` : "");
    this.gui.setText(f.order, d ? `${d.rank}` : "");
    this.gui.setText(f.exp, d ? `${d.exp}` : "");
    if (f.address) this.gui.setText(f.address, ""); // [LACUNA] the server has no forum address
    if (f.intro) this.gui.setText(f.intro, d?.info ?? "");
    paintMark(this.gui, n.mark.panel, d ? d.logo : null);
  }
}
