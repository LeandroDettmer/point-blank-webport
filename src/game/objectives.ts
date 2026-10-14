// Destroy mode objectives. A side is a colour: blue = the CT team's objective, red = the FR team's.
// Team ids as the room gives them (slot % 2): 0 = FR (red), 1 = CT (blue). The bars are per colour: Bar1 = red objective,
// Bar2 = blue objective (server ultraSync 1 / 2). A bar at 0 gives the round to the side that is NOT the bar's colour
// (the C# EndRound: Bar1 == 0 -> !swap ? CT : FR).
// TEAM_SWAP moves the teams to the other colour every round, so the side of a team flips with `swap`.

export type ObjectiveSide = "blue" | "red";

/** the colour a team plays this round: CT (1) = blue, FR (0) = red, flipped by TEAM_SWAP */
export const sideOf = (team: number, swap = false): ObjectiveSide => ((team === 1) !== swap ? "blue" : "red");

/** a team damages the objective of the other colour only (DamageObjectForUser 0x586f60: blue slots hit the red objective) */
export const isEnemyObjective = (objective: ObjectiveSide, team: number, swap = false): boolean => sideOf(team, swap) !== objective;

/** the server's ObjectModel.ultraSync of an objective colour: red = Animation 256 (bar1), blue = 257 (bar2) */
export const barOf = (objective: ObjectiveSide): 1 | 2 => (objective === "red" ? 1 : 2);
