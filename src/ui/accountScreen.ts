import { registerAccount, loginAccount, tokenToBytes, AccountApiError } from "../net/accountApi.js";
import { Stage } from "../lobby/ui/LayoutRenderer.ts";

export interface AccountSession {
  token: Uint8Array;
  username: string;
}

const STYLE_ID = "pb-account-screen-style";
const LOGIN_ART = "/assets/ui/cross/brand/login-bg.png"; // pbx ui cross-brand: Login.i3i, top 1024 x 768

// Rects in design px (1024 x 768) of the fields baked into the LOGIN box of the art [INFERIDO: measured on the texture, +-1 px]
const ID_RECT = "left:387px;top:433px;width:249px;height:34px";
const PW_RECT = "left:387px;top:500px;width:249px;height:36px";

function ensureStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    .pb-account-overlay { position: fixed; inset: 0; z-index: 10000; background: #000; }
    .pb-account-art { background: url(${LOGIN_ART}) 0 0 / 1024px 768px no-repeat; }
    .pb-account-input {
      position: absolute; box-sizing: border-box; margin: 0; padding: 0 6px; border: 0; outline: 0;
      background: transparent; color: #fff; caret-color: #ffb040; font: 14px Arial, sans-serif;
    }
    /* browser autofill paints its own light background and dark text over the baked field: keep the field transparent */
    .pb-account-input:-webkit-autofill, .pb-account-input:-webkit-autofill:hover, .pb-account-input:-webkit-autofill:focus {
      -webkit-text-fill-color: #fff; caret-color: #ffb040; transition: background-color 600000s 0s, color 600000s 0s;
    }
    .pb-account-input:autofill { background: transparent; }
    .pb-account-btn {
      position: absolute; box-sizing: border-box; margin: 0; padding: 0; border: 1px solid #4a4a4a; border-radius: 2px;
      background: #161616; color: #8c8c8c; font: bold 12px Arial, sans-serif; letter-spacing: 0.05em; cursor: pointer;
    }
    .pb-account-btn:hover { border-color: #7a7a7a; color: #ddd; }
    .pb-account-btn.active { color: #fff; border-color: #e0a03a; background: #2a2014; }
    .pb-account-btn:disabled { opacity: 0.5; cursor: default; }
    .pb-account-error {
      position: absolute; left: 262px; top: 608px; width: 500px; display: none; text-align: center;
      font: 12px Arial, sans-serif; color: #ff9d9d; text-shadow: 0 1px 2px #000; white-space: nowrap;
    }
    .pb-account-error.visible { display: block; }
  `;
  document.head.appendChild(style);
}

export function showAccountScreen(): Promise<AccountSession> {
  ensureStyles();

  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "pb-account-overlay";
    document.body.appendChild(overlay);

    // the Cross login is an i3Gui window on the 1024 x 768 stage: same fit as the lobby (app.ts)
    const stage = new Stage(overlay, 1024, 768, true);
    stage.design.classList.add("pb-account-art");
    stage.design.innerHTML = `
      <input class="pb-account-input" id="pb-acc-username" type="text" autocomplete="username" maxlength="16" style="${ID_RECT}" />
      <input class="pb-account-input" id="pb-acc-password" type="password" autocomplete="current-password" maxlength="64" style="${PW_RECT}" />
      <button class="pb-account-btn active" id="pb-acc-submit" type="button" style="left:387px;top:552px;width:121px;height:24px">ENTRAR</button>
      <button class="pb-account-btn" id="pb-acc-mode" type="button" style="left:515px;top:552px;width:121px;height:24px">CADASTRAR</button>
      <div class="pb-account-error" id="pb-acc-error"></div>
    `;

    let mode: "login" | "register" = "login";
    const modeBtn = stage.design.querySelector<HTMLButtonElement>("#pb-acc-mode")!;
    const submitBtn = stage.design.querySelector<HTMLButtonElement>("#pb-acc-submit")!;
    const usernameInput = stage.design.querySelector<HTMLInputElement>("#pb-acc-username")!;
    const passwordInput = stage.design.querySelector<HTMLInputElement>("#pb-acc-password")!;
    const errorBox = stage.design.querySelector<HTMLElement>("#pb-acc-error")!;

    // [RECRIADO] the original LOGIN box has no register mode: the submit button and the CADASTRAR / VOLTAR switch are ours
    function setMode(next: "login" | "register"): void {
      mode = next;
      modeBtn.textContent = next === "login" ? "CADASTRAR" : "VOLTAR";
      submitBtn.textContent = next === "login" ? "ENTRAR" : "CRIAR CONTA";
      passwordInput.autocomplete = next === "login" ? "current-password" : "new-password";
      hideError();
    }

    function showError(message: string): void {
      errorBox.textContent = message;
      errorBox.classList.add("visible");
    }

    function hideError(): void {
      errorBox.classList.remove("visible");
    }

    modeBtn.addEventListener("click", () => setMode(mode === "login" ? "register" : "login"));

    async function submit(): Promise<void> {
      hideError();
      const username = usernameInput.value.trim();
      const password = passwordInput.value;

      if (!/^[a-zA-Z0-9_]{4,16}$/.test(username)) {
        showError("Usuário deve ter 4-16 caracteres (letras, números, _)");
        return;
      }
      if (password.length < 6) {
        showError("Senha deve ter ao menos 6 caracteres");
        return;
      }

      submitBtn.disabled = true;
      submitBtn.textContent = "AGUARDE...";
      try {
        const result = mode === "login"
          ? await loginAccount(username, password)
          : await registerAccount(username, password);

        stage.destroy();
        overlay.remove();
        resolve({ token: tokenToBytes(result.token), username: result.nickname });
      } catch (err) {
        const message = err instanceof AccountApiError ? err.message : "Falha de conexão com o servidor de contas";
        showError(message);
        submitBtn.disabled = false;
        submitBtn.textContent = mode === "login" ? "ENTRAR" : "CRIAR CONTA";
      }
    }

    submitBtn.addEventListener("click", () => void submit());
    for (const input of [usernameInput, passwordInput]) {
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") void submit();
      });
    }
  });
}
