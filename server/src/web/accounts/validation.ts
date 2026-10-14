import { z } from "zod";

export const credentialsSchema = z.object({
  username: z
    .string()
    .regex(/^[a-zA-Z0-9_]{4,16}$/, "username must be 4-16 chars: letters, digits, underscore"),
  password: z.string().min(6, "password must be at least 6 characters").max(64),
});

export type Credentials = z.infer<typeof credentialsSchema>;

/** names a player must not take: the client draws chat lines of these as the server / staff speaking (lobby chat "Server" lines, GM notices) */
const RESERVED_NICK = /^(server|servidor|system|sistema|admin|administrator|administrador|gm|gamemaster|moderator|moderador|staff|support|suporte)$/i;

// CREATE_NICK (2326) keeps the Unicode nicks of the original, so the check compares what the nick LOOKS like [RECRIADO]:
// Cyrillic / Greek / small-cap letters drawn like the Latin ones (written as escapes: in the source they would look the same).
const LOOKALIKE: Record<string, string> = {
  a: "аАΑαᴀ", b: "вВΒ", c: "сС", d: "ԁᴅ", e: "еЕΕεᴇ",
  f: "ꜰ", g: "ɡɢ", h: "нНһΗ", i: "іІӏӀΙιıɪ", j: "јЈ",
  k: "кКΚκ", m: "мМΜᴍ", n: "пΝηɴ", o: "оОΟοᴏ",
  p: "рРΡρᴘ", r: "ʀ", s: "ѕЅꜱ", t: "тТΤτᴛ", u: "υᴜ",
  v: "νѵᴠ", x: "хХΧχ", y: "уУүҮΥʏ", z: "Ζ",
};
const FOLD = new Map(Object.entries(LOOKALIKE).flatMap(([to, from]) => [...from].map((ch) => [ch, to] as const)));
/** NFKD (fullwidth / math letters -> ASCII, accents split off), marks and invisible characters (zero width, Hangul fillers) dropped, lookalikes mapped */
const looks = (nick: string): string =>
  [...nick.normalize("NFKD").replace(/[\p{M}\p{Cf}ᅟᅠㅤﾠ]/gu, "")].map((ch) => FOLD.get(ch) ?? ch).join("").trim();
export const isReservedNick = (nick: string): boolean => RESERVED_NICK.test(looks(nick));
