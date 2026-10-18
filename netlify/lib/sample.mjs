/* A fictional roster for trying the system: 189 PCO seats across seven districts, with Precinct
   Captains, officers, party members, and one of each tricky case in LD 27. */
import { addDays } from "../../site/js/rules.js";

const FIRST = ["Alex", "Bailey", "Carmen", "Dana", "Elena", "Frank", "Gloria", "Hector", "Irene", "Jamal", "Karen", "Luis", "Marisol", "Nolan", "Opal", "Pete", "Quinn", "Rosa", "Sam", "Tara", "Uma", "Victor", "Wendy", "Yvonne", "Zach", "Abby", "Brent", "Celia", "Derek", "Erin", "Floyd", "Grace", "Hank", "Ivy", "Joel", "Kim", "Leo", "Mona", "Ned", "Olive", "Paul", "Ruth", "Seth", "Tess", "Vince", "Willa", "Gus", "Hazel", "Ian", "June", "Kurt", "Lena", "Mark", "Nina", "Owen", "Pam", "Ray", "Sue", "Ted", "Vera"];
const LAST = ["Abbott", "Barnes", "Castillo", "Dalton", "Ellison", "Fuller", "Garza", "Hale", "Ingram", "Jensen", "Keller", "Lindqvist", "Moreno", "Nakamura", "Okafor", "Pruitt", "Quintana", "Rhodes", "Sorensen", "Tran", "Underwood", "Vasquez", "Whitaker", "Yates", "Zeller", "Ashby", "Brandt", "Coburn", "Dunmore", "Eckert", "Fenwick", "Gallo", "Harlan", "Iverson", "Kemper", "Larkin", "Mercer", "Northrup", "Oakes", "Pellegrini", "Ramsey", "Strand", "Talbot", "Varga", "Wexler", "Haugen", "Tanaka", "Ostrander", "Kowalski", "Delacroix"];
const LDS = [2, 25, 26, 27, 28, 29, 31], SEATS = [22, 30, 27, 38, 24, 26, 22];

function rngFrom(seed) {
  let r = seed | 0;
  return () => { let t = (r = (r + 0x6d2b79f5) | 0); t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export function sampleRoster(date, makeId) {
  const rnd = rngFrom(20261112), used = new Set(), people = [];
  const name = () => { for (;;) { const s = FIRST[Math.floor(rnd() * FIRST.length)] + " " + LAST[Math.floor(rnd() * LAST.length)]; if (!used.has(s)) { used.add(s); return s; } } };
  const add = o => {
    const p = { id: makeId(), name: o.name || name(), pct: o.pct, ld: o.ld, kind: o.kind, office: o.office || "", appt: o.appt || "", dues: o.dues !== false, inactive: !!o.inactive, missed2: !!o.missed2, missedAny: !!o.missedAny, ver: 1 };
    people.push(p);
    return p;
  };
  LDS.forEach((ld, li) => {
    for (let i = 0; i < SEATS[li]; i++) {
      const kind = rnd() < 0.13 ? "appointed" : "elected";
      const appt = kind === "appointed" ? addDays(date, -(rnd() < 0.3 ? 20 + Math.floor(rnd() * 39) : 75 + Math.floor(rnd() * 200))) : "";
      const missedAny = rnd() < 0.3;
      add({ kind, ld, pct: ld + "-" + (101 + i * 4), appt, dues: rnd() > 0.04, inactive: rnd() < 0.03, missedAny, missed2: missedAny && rnd() < 0.38 });
    }
    for (let c = 0; c < 2; c++) add({ kind: "captain", ld, pct: ld + "-" + (101 + (SEATS[li] + c) * 4) });
  });
  // One of each case in LD 27, so they're easy to find.
  const ld27 = people.filter(p => p.ld === 27 && (p.kind === "elected" || p.kind === "appointed"));
  Object.assign(ld27[0], { kind: "elected", appt: "", dues: true, inactive: false, missedAny: false, missed2: false });
  Object.assign(ld27[3], { kind: "appointed", appt: addDays(date, -41), dues: true, inactive: false });
  Object.assign(ld27[5], { kind: "elected", appt: "", dues: false, inactive: false, missed2: false });
  Object.assign(ld27[7], { kind: "elected", appt: "", dues: true, inactive: true });
  const special = new Set([ld27[0], ld27[3], ld27[5], ld27[7]]);
  [["Chair", 26], ["Vice Chair", 29], ["Secretary", 25], ["Sergeant-at-Arms", 27], ["State Committeeman", 2], ["State Committeewoman", 31]].forEach(([office, ld]) => {
    const p = people.filter(x => x.ld === ld && x.kind === "elected" && !x.office && !special.has(x))[1];
    Object.assign(p, { office, dues: true, inactive: false, missed2: false });
  });
  const treasurer = add({ kind: "officer", office: "Treasurer", ld: 28, pct: "28-209" });
  add({ kind: "apptofficer", office: "Parliamentarian", ld: 27, pct: "27-261" });
  [25, 27, 28, 31, 2].forEach((ld, k) => add({ kind: "member", ld, pct: ld + "-" + (113 + k * 8) }));
  const samples = {
    eligible: ld27[0].id,
    officer: treasurer.id,
    appointed: ld27[3].id,
    captain: people.find(p => p.kind === "captain" && p.ld === 27).id,
    dues: ld27[5].id,
    inactive: ld27[7].id
  };
  return { people, samples };
}
