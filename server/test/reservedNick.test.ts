// Reserved names (web/accounts/validation.ts): nobody registers or picks a nick the client draws as the server / staff speaking.
//   node --test test/reservedNick.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { isReservedNick } from "../src/web/accounts/validation.ts";

test("reserved nicks are refused whatever the case or padding", () => {
  for (const n of ["Server", "SERVER", " server ", "Servidor", "GM", "Admin", "moderador"]) assert.equal(isReservedNick(n), true, n);
});

test("ordinary nicks stay allowed (also ones that merely contain a reserved word)", () => {
  for (const n of ["testes", "ServerFan", "gmail", "adminx", "Player1"]) assert.equal(isReservedNick(n), false, n);
});

test("lookalikes of a reserved nick are refused (CREATE_NICK takes Unicode)", () => {
  for (const n of [
    "Ѕеrvеr", // Cyrillic S and e
    "Ｓｅｒｖｅｒ", // fullwidth
    "ꜱᴇʀᴠᴇʀ", // small caps
    "Ser​ver", // zero width space
    "Sérvér", // accents
    "\u{1d406}\u{1d40c}", // math bold GM
    "GMㅤ", // Hangul filler
    "Αdmіn", // Greek A, Cyrillic i
  ]) assert.equal(isReservedNick(n), true, JSON.stringify(n));
  for (const n of ["João", "Сергей", "サーバー"]) assert.equal(isReservedNick(n), false, n);
});
