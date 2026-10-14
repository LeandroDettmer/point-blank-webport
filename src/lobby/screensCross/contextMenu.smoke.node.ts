// Smoke: itens do menu de contexto do Cross (contextMenu.ts) para lista do lobby, slot da sala e regra do Convite do Clã.
// node --experimental-transform-types src/lobby/screensCross/contextMenu.smoke.node.ts
import { CMC, NO_CLAN_LOGO, canClanInvite, lobbyMenuItems, roomMenuItems } from "./contextMenu.ts";

let fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name} -> ${JSON.stringify(got)}`);
};

// lobby (0x835170): eu = só Informações; outro = Info, PM, Adicionar; Convite do Clã só com canClanInvite
eq("lobby: eu = Informações", lobbyMenuItems(true, true), [CMC.DETAIL_INFO]);
eq("lobby: outro sem clã", lobbyMenuItems(false, false), [CMC.DETAIL_INFO, CMC.WHISPER, CMC.ADD_FRIEND]);
eq("lobby: outro com Convite do Clã", lobbyMenuItems(false, true), [CMC.DETAIL_INFO, CMC.WHISPER, CMC.ADD_FRIEND, CMC.CLAN_INVITE]);

// slot da sala (0x7d5cf0): meu slot nada; líder ganha Novo dono + Forçar saída
eq("room: meu slot = vazio", roomMenuItems(true, true, true), []);
eq("room: líder em outro slot", roomMenuItems(false, true, false), [CMC.GIVE_MASTER, CMC.FORCE_GET_AWAY, CMC.WHISPER, CMC.ADD_FRIEND]);
eq("room: membro com Convite do Clã", roomMenuItems(false, false, true), [CMC.WHISPER, CMC.ADD_FRIEND, CMC.CLAN_INVITE]);

// Convite do Clã: dono/auxiliar (access 1/2) e alvo sem clã
eq("clã: dono convida quem não tem clã", canClanInvite(1, NO_CLAN_LOGO), true);
eq("clã: auxiliar convida quem não tem clã", canClanInvite(2, NO_CLAN_LOGO), true);
eq("clã: membro não convida", canClanInvite(0, NO_CLAN_LOGO), false);
eq("clã: alvo já tem clã", canClanInvite(1, 5), false);
eq("clã: alvo sem dado de clã (undefined) não convida", canClanInvite(1, undefined), false);

if (fail) { console.log(`${fail} FAIL`); process.exit(1); }
console.log("contextMenu smoke ok");
