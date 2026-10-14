/** Bot names by slot: every peer derives the same name of an AI slot (the wire carries none). [RECRIADO] */
export const BOT_NAMES = [
  "Viper", "Hawk", "Kobra", "Tank", "Ghost", "Raven", "Blitz", "Rex", "Jaguar", "Nitro",
  "Sniper", "Falcon", "Shadow", "Bravo", "Delta", "Tiger", "Spike", "Wolf", "Zulu", "Echo",
];

export const botNameOfSlot = (slot: number): string => BOT_NAMES[slot % BOT_NAMES.length];
