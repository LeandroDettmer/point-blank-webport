// Descrição do personagem (ivCharacterDescription no inventário, shopCharacterDescription na loja). O Cross original deixa
// vazio: nenhum cliente tem texto de descrição por personagem (Character.pef sem campo Description; strings BR/Hyper só
// têm o nome). [RECRIADO] só com números reais do pef: time pelo prefixo do ITEMID (601 rebelde, 602 OTP; confirmado nos
// nomes com facção, ex. Tarantula 601003 "(Rebeldes)", Acid Paul 602002 "(OTP)" [INFERIDO] pelo prefixo), HP (charaMaxHp)
// e velocidade / DamageRate (charaStats). Sem personagem na tabela = sem texto.
import { charaMaxHp } from "../../gameplay/charaHp.ts";
import { charaStats } from "../state/charaStats.ts";

const TEAM_BY_PREFIX: Record<number, [key: string, fallback: string]> = {
  601: ["STR_INVEN_RED_CHARA", "Personagem rebelde"],
  602: ["STR_INVEN_BLUE_CHARA", "Personagem da OTP"],
};

export function charaDescription(itemId: number, str: (k: string, f: string) => string): string {
  const c = charaStats(itemId);
  if (!c) return "";
  const team = TEAM_BY_PREFIX[Math.floor(itemId / 1000)];
  const lines = [
    team ? str(...team) : "",
    `HP: ${charaMaxHp(itemId)}`,
    // per-chara speed / DamageRate are not shown: the match applies one set for every chara (pbConfig PB_CHARA,
    // game/damage.ts), and the pef head rate is never a human headshot multiplier (damage.ts:9-12)
  ];
  return lines.filter(Boolean).join("\n");
}
