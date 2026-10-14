import { PB_CHARA } from "../gameplay/pbConfig";
import { jsonOnce } from "../jsonOnce";
import { FAMILY_PB } from "./pbFamilyDefaults";
import { mineStat, throwableStat } from "./throwables";
import type { ClassParams, Family, PartRates, PbWeaponBlock, WeaponDef, WeaponStat, WeaponsJson } from "./types";

// Built-in fallback so the system is usable before weapons.json arrives (same numbers as the XML; handling comes from
// the generated FAMILY_PB pef blocks).
const FALLBACK_STATS: WeaponStat[] = [
  { id: 103015, name: "AK-47 SOPMOD", slot: 1, slotName: "primary", classType: 3, className: "Assault", family: "AR",
    loadedBullet: 30, totalBullet: 150, damage: 33, fireDelay: 0.09, rpm: 667, helmetPenetrate: 85, range: 160, sfx: "AssaultRifle_AK-47" },
  { id: 104033, name: "AKS74U", slot: 1, slotName: "primary", classType: 4, className: "SMG", family: "SMG",
    loadedBullet: 30, totalBullet: 210, damage: 26, fireDelay: 0.09, rpm: 667, helmetPenetrate: 85, range: 60, sfx: "SMG_AKS74U" },
  { id: 202022, name: "Colt45", slot: 2, slotName: "secondary", classType: 2, className: "HandGun", family: "HG",
    loadedBullet: 7, totalBullet: 28, damage: 25, fireDelay: 0.2, rpm: 300, helmetPenetrate: 83, range: 55, sfx: "HandGun_Colt45", changeTime: 0.6667 },
  { id: 301001, name: "M-7", slot: 3, slotName: "melee", classType: 1, className: "Knife", family: "KNIFE",
    loadedBullet: 0, totalBullet: 0, damage: 60, fireDelay: 0.4, rpm: 150, helmetPenetrate: 43, range: 1.5, sfx: "Melee_M-7", changeTime: 0.5 },
  { id: 407001, name: "K-400", slot: 4, slotName: "explosive", classType: 7, className: "ThrowingGrenade", family: "GRENADE",
    loadedBullet: 1, totalBullet: 1, damage: 90, fireDelay: 1, rpm: 60, helmetPenetrate: 94, range: 30, sfx: "Throw_K-400", changeTime: 0.5 },
];

// Family-level values with no pef source. fireMode is only used when the pef has no AutoFireCount.
const FAMILY_MODE: Record<string, ClassParams["fireMode"]> = {
  AR: "auto", SMG: "auto", MG: "auto", SR: "bolt", SG: "pump", HG: "semi", KNIFE: "melee", GRENADE: "throw",
};
/**
 * Grenade fuse fallback, only for items with no Explosion_Time. The real fuse is the pef Explosion_Time (K-400 0.9 s):
 * WeaponGrenade::OnUpdate 0x630830 adds dt to weapon+0xa540 once the throw flag 2 is set (on the first update after a
 * throw with speed > 0.2, 0x630889) and explodes (state 0x10) when it passes GetExplosionTime 0x616fd0 = weaponInfo
 * vf+0x88 (CGrenadeGunInfo::GetExplosion_Time) + equip bonuses; a grenade also goes off after 15 s alive (+0xa544).
 */
const GRENADE_FUSE = 2.5;
/**
 * [RECRIADO] swap time for items without a 1PV AI (35 SkillShop/Supply/arrows) and before weapons.json loads: the most
 * common 1PV Change i3AIState duration (0.6667 s on 528 of the 1118 mapped weapons; AUG A3 and Colt45 have it too).
 */
const CHANGE_TIME_DEFAULT = 0.6667;

/** pef-3.123 Character.AcidPol.DamageRate (default soldier). */
export const DEFAULT_HITZONE: PartRates = { ...PB_CHARA.damageRate };

/** Weapon.pef block -> runtime params. */
export function buildParams(fam: Family, s: WeaponStat, pb: PbWeaponBlock | undefined, fuse = GRENADE_FUSE): ClassParams {
  // no pef block at all -> the family representative; a pef block with a missing key -> the exe default below
  const rep: PbWeaponBlock = pb ? { src: "" } : FAMILY_PB[fam] ?? FAMILY_PB.AR;
  const p: PbWeaponBlock = pb ?? rep;
  const v = <K extends keyof PbWeaponBlock>(k: K) => (p[k] ?? rep[k]) as NonNullable<PbWeaponBlock[K]>;
  const r = { ...rep.recoil, ...p.recoil };
  const c = { ...rep.crosshair, ...p.crosshair };
  const m = { ...rep.moveNormal, ...p.moveNormal };
  const auto = p.autoFireCount;
  const scope = fam !== "KNIFE" && fam !== "GRENADE" && (p.extType === "Scope" || p.zoomType === 3) && (p.fovOnScope ?? 0) > 0;
  const x = p.ext ?? {};
  const params: ClassParams = {
    fireMode: s.fireMode ?? FAMILY_MODE[fam] ?? "semi",
    damage: pb?.damage ?? s.damage,
    range: pb?.range ?? s.range,
    reloadTime: v("reloadTime") ?? 0,
    reloadPerShell: p.reloadBulletCount === 1 && (p.loadBullet ?? s.loadedBullet) > 1,
    changeTime: s.changeTime ?? CHANGE_TIME_DEFAULT,
    loadBulletTime: p.needToLoadBullet ? p.loadBulletTime ?? s.loadBulletClip : undefined,
    zoomFov: scope ? p.fovOnScope : p.fovOnZoom,
    zoomFov2: scope && (p.fovOnScope2 ?? 0) > 0 ? p.fovOnScope2 : undefined,
    scope,
    pellets: Math.max(1, p.fireBulletCount ?? 1),
    burstCount: auto !== undefined && auto > 1 ? auto : undefined,
    burstDelay: auto !== undefined && auto > 1 ? p.autoFireDelay : undefined,
    // no DPD_Rate key (knives, grenades) = no distance falloff
    dpdRate: p.dpdRate ?? 0,
    helmetPenetrate: p.helmetPenetrate,
    bulletWeight: v("bulletWeight") ?? 100,
    moveNormal: { stand: m.stand ?? 100, fire: m.fire ?? 100, sit: m.sit ?? 100, zoom: m.zoom ?? 0, scope: m.scope ?? 0 },
    spread: {
      deviation: v("deviation") ?? 0,
      deviationMax: v("deviationMax") ?? 0,
      deviationDecrement: p.deviationDecrement,
      deviationDiminutionDistance: p.deviationDiminutionDistance,
      cross: {
        stand: c.stand ?? 0, sit: c.sit ?? 0, walk: c.walk ?? 0, move: c.move ?? 0, jump: c.jump ?? 0, fire: c.fire ?? 0,
        zoom: c.zoom ?? 0, noZoom: c.noZoom ?? 0, moveSit: c.moveSit ?? 0, walkSit: c.walkSit ?? 0, damage: c.damage ?? 0,
        min: c.min ?? 0, max: c.max ?? 0, expand: c.expand ?? 0, speedFactor: c.speedFactor ?? 1,
        // exe defaults when the key is absent (CWeaponInfo 0x690 / 0x6b4)
        expandTime: c.expandTime ?? 0, contractTime: c.contractTime ?? 0.4,
      },
    },
    recoil: {
      vertAngle: r.vertAngle ?? 0, vertMax: r.vertMax ?? 0, vertCount: r.vertCount ?? 0, oneVert: r.oneVert === 1,
      oneHorz: r.oneHorz === 1, horzAngle: r.horzAngle ?? 0, horzMax: r.horzMax ?? 0, horzCount: r.horzCount ?? 0,
      // exe default 1.0 when the key is absent (CGunInfo vf234 / vf238)
      vertRecoverTime: r.vertRecoverTime ?? 1, horzRecoverTime: r.horzRecoverTime ?? 1, camSyncRate: r.camSyncRate ?? 1,
    },
    ext: { type: p.extType, deviationFactor: x.deviationFactor, recoilVertFactor: x.recoilVertFactor,
      recoilHorzFactor: x.recoilHorzFactor, recoilHorzCount: x.recoilHorzCount, recoilVertCount: x.recoilVertCount },
    fallback: !pb,
  };
  if (fam === "KNIFE") {
    const k = { ...rep.melee, ...p.melee };
    params.melee = {
      damageA: k.damageA1 ?? s.damage, timeA: k.timeA1 ?? 0.1,
      // CMeleeWeaponInfo zeroes the local (0x5ecebc) before reading AttackTimeB%d (0x5eced0): a missing B time is 0.0 s
      // (Field Shovel 301025 has no AttackTimeB in the Cross pef, so its RMB hit lands at once)
      damageB: k.damageB1 ?? s.damage, timeB: k.timeB1 ?? 0, delayB: k.fireDelay2 ?? 1,
    };
    // Second hit of one swing: the pef's A2 / B2 (AttackTimeA2 / B2, AttackDamageA2 / B2). The two-hand classes always
    // have it (Bone Knife 0.15 / 0.5 s, Kunai 0.3 / 0.45 s, Knuckle A1 0.2 / A2 0.4 s, one fist each); a single blade
    // gets it when the pef asks for 2 hits on that button (AutoFireCount = LMB hits: Ballistic Knife A2 0.466,
    // FryingPan / HairDryer A2 1; AutoFireCount2 = RMB hits: GH5007 B2 0.86, Keris 1, Karambit 0.7, Death-Scythe
    // 1.11). ChineseCleaver A2 -1 and the Shovel B2 with AutoFireCount2 1 stay single. [INFERIDO] the AutoFireCount gate
    const dual = s.className === "DualKnife" || s.className === "Knuckle";
    if ((k.timeA2 ?? 0) > 0 && (dual || (auto ?? 1) >= 2)) Object.assign(params.melee, { damageA2: k.damageA2, timeA2: k.timeA2 });
    if ((k.timeB2 ?? 0) > 0 && (dual || (k.autoFireCount2 ?? 1) >= 2)) Object.assign(params.melee, { damageB2: k.damageB2, timeB2: k.timeB2 });
  }
  if (fam === "GRENADE") {
    const g = { ...rep.grenade, ...p.grenade };
    params.fuse = g.explosionTime ?? fuse;
    params.throwSpeed = g.throwSpeed;
    params.throwDelay = g.throwDelay;
    params.explosionRadius = g.explosionRange;
    params.explosionSlope = g.explosionSlope;
  }
  return params;
}

/**
 * Melee items whose pef block is a copy of a DualKnife (Kunai 301107: base "Dual/Dual_Kunai", Extension1 Type "Throw"):
 * className Knife, but the AI (DualKnife/Kunai), the two blades and the A2 / B2 hits are the dual's.
 */
export function dualKnifeAlias<T extends WeaponStat>(w: T): T {
  return w.className === "Knife" && /^Dual\/Dual_(\w*Knife|Kunai)/i.test(w.pb?.base ?? "") ? { ...w, className: "DualKnife" } : w;
}

export class WeaponDb {
  hitzone: PartRates = { ...DEFAULT_HITZONE };
  grenadeFuse = GRENADE_FUSE;
  defaultLoadout: Record<string, number> = { primary: 103037, secondary: 202022, melee: 301001, grenade: 407001 };
  private stats = new Map<number, WeaponStat>(FALLBACK_STATS.map((w) => [w.id, w]));
  loaded = false;

  async load(url: string): Promise<void> {
    const j = await jsonOnce<WeaponsJson>(url);
    this.hitzone = { ...DEFAULT_HITZONE, ...(j.hitzone ?? {}) };
    this.grenadeFuse = j.classes?.GRENADE?.fuse ?? GRENADE_FUSE;
    this.defaultLoadout = { ...this.defaultLoadout, ...j.defaultLoadout };
    for (const w of j.weapons) this.stats.set(w.id, dualKnifeAlias(w));
    this.loaded = true;
  }

  stat(id: number): WeaponStat | undefined {
    return this.stats.get(id);
  }

  all(): WeaponStat[] {
    return [...this.stats.values()];
  }

  find(name: string, family?: Family): WeaponStat | undefined {
    const n = name.toLowerCase();
    return this.all().find((w) => w.name.toLowerCase() === n && (!family || w.family === family));
  }

  def(id: number): WeaponDef | undefined {
    // server throwables missing from weapons.json (C-5 PBWC2016 407053, ...): their class base + own pef block
    const base = this.stats.get(id) ?? throwableStat(id, (b) => this.stats.get(b));
    if (!base) return undefined;
    const s = mineStat(id, base); // Claymore: 2017 explosion block (weapons.json has the 3.123 one)
    const fam = s.family === "OTHER" ? (s.slot === 3 ? "KNIFE" : s.slot === 4 ? "GRENADE" : "AR") : s.family;
    const params = buildParams(fam, s, s.pb, this.grenadeFuse);
    return { ...s, family: fam, fireMode: params.fireMode, params };
  }
}
