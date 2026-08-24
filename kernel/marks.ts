/** Presence: anything you do leaves a mark. Nothing is a gate. */

export const DEED_WEIGHT: Record<string, number> = {
  join: 1,
  look: 1,
  walk: 1,
  say: 2,
  make: 3,
  found: 4,
  give: 2,
  agree: 3,
  sign: 3,
  go_home: 1,
  talk: 2,
  use: 1,
  become: 2,
};

export type DeedCounts = {
  join: number;
  look: number;
  walk: number;
  say: number;
  make: number;
  found: number;
  give: number;
  agree: number;
  sign: number;
  go_home: number;
  talk: number;
  use: number;
  become: number;
};

export const EMPTY_DEEDS: DeedCounts = {
  join: 0,
  look: 0,
  walk: 0,
  say: 0,
  make: 0,
  found: 0,
  give: 0,
  agree: 0,
  sign: 0,
  go_home: 0,
  talk: 0,
  use: 0,
  become: 0,
};

export const MARK_CATALOG: { id: string; label: string; hint: string; test: (d: DeedCounts, depth: number, visits: string[]) => boolean }[] = [
  { id: "newcomer", label: "Newcomer", hint: "You arrived.", test: (d) => d.join >= 1 },
  { id: "walker", label: "Walker", hint: "Eight walks.", test: (d) => d.walk >= 8 },
  { id: "scribe", label: "Scribe", hint: "Five notes on the walls.", test: (d) => d.say >= 5 },
  { id: "maker", label: "Maker", hint: "Three things made.", test: (d) => d.make >= 3 },
  { id: "settler", label: "Settler", hint: "You founded a place.", test: (d) => d.found >= 1 },
  { id: "pactbound", label: "Pactbound", hint: "You signed.", test: (d) => d.sign >= 1 || d.agree >= 1 },
  { id: "interlocutor", label: "Interlocutor", hint: "You spoke with someone here.", test: (d) => d.talk >= 1 },
  { id: "named", label: "Named", hint: "You said who you are.", test: (d) => d.become >= 1 },
  { id: "witness", label: "Witness", hint: "You looked, often.", test: (d) => d.look >= 16 },
  { id: "cartographer", label: "Cartographer", hint: "You stood in the listed settlements.", test: (_d, _depth, visits) =>
      ["arrival", "hall", "archive", "workshop", "maps", "watch", "atrium"].every((id) => visits.includes(id)) },
  { id: "keeper", label: "Keeper", hint: "The city has a deep shape of you.", test: (_d, depth) => depth >= 40 },
];

export function conferMarks(deeds: DeedCounts, depth: number, visits: string[], current: string[]): string[] {
  const next = new Set(current);
  for (const m of MARK_CATALOG) {
    if (m.test(deeds, depth, visits)) next.add(m.id);
  }
  return [...next];
}
