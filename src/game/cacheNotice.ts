// One-time box: the browser does not keep the downloaded game files (src/cache/cacheProbe.ts).
import { loadStrings, tOr } from "../lobby/ui/i18n.ts";
import { CrossMessageBox } from "./crossMessageBox.ts";

// [RECRIADO]: the original client has no such message (it installs to disk); the Cross message popup carries it.
const TEXT = "Seu navegador não está guardando os arquivos do jogo (aba anônima, cache desativado ou pouco espaço).\nCada partida vai baixar tudo de novo. Use uma aba normal e libere espaço em disco.";

export async function showCacheNotice(host: HTMLElement): Promise<void> {
  await loadStrings();
  const box = await CrossMessageBox.create(host, {
    caption: tOr("STBL_IDX_COMMON_MSGBOX_CAPTION", "Aviso"),
    message: TEXT,
    confirm: { label: tOr("STBL_IDX_BUTTON_OK", "Confirmar"), onClick: () => box.destroy() },
    modal: true,
  });
}
