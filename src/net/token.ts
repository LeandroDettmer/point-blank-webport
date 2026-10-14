// The BR server authenticates by launcher token only (LOGIN_REQ carries no user/password):
// AccountManager.GetAccountDB(base64(tokenBytes)) -> SELECT * FROM accounts WHERE token=@valor.
// The web client derives a deterministic 16-byte token from user/password so an account can be
// provisioned with one SQL update:
// token = base64(SHA-256("pbweb::" + password)[0..16])
import { fromBase64, toBase64 } from "./bytes.ts";

export async function deriveWebToken(username: string, password: string): Promise<Uint8Array> {
  const data = new TextEncoder().encode(`pbweb:${username}:${password}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  return digest.slice(0, 16);
}

export async function deriveWebTokenBase64(username: string, password: string): Promise<string> {
  return toBase64(await deriveWebToken(username, password));
}

/** Token field input: "b64:<base64>" or raw text sent as UTF-8. */
export function parseTokenInput(input: string): Uint8Array {
  return input.startsWith("b64:") ? fromBase64(input.slice(4)) : new TextEncoder().encode(input);
}

/** Tokens tried when the token field is empty: the web convention above. */
export async function candidateTokens(username: string, password: string): Promise<{ label: string; bytes: Uint8Array }[]> {
  return [{ label: "web (sha256)", bytes: await deriveWebToken(username, password) }];
}
