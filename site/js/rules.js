/* Who can vote, and what makes a quorum. Shared by the server and the pages so both always agree.
   Section numbers refer to the PCRP Bylaws (and SR = Standing Rules). */

export const KIND = {
  elected: "Elected PCO",
  appointed: "Appointed PCO",
  captain: "Precinct Captain",
  officer: "CC officer",
  apptofficer: "Appointed officer",
  member: "Party member"
};
export const PCO_KINDS = ["elected", "appointed"];
export const QUORUM_PCT = 45; // 4.4.1

export function daysBetween(a, b) {
  return Math.round((Date.parse(b + "T12:00:00Z") - Date.parse(a + "T12:00:00Z")) / 864e5);
}
export function addDays(iso, n) {
  const d = new Date(iso + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export function fmtDate(iso, withDay = true) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso || "")) return "";
  const d = new Date(iso + "T12:00:00Z");
  return (withDay ? DAYS[d.getUTCDay()] + ", " : "") + MONTHS[d.getUTCMonth()] + " " + d.getUTCDate() + ", " + d.getUTCFullYear();
}

/* Can this person vote at a meeting on `date`? Returns { cls, why } where cls is
   "vote", "non" (can't vote) or "rule" (needs a ruling), and why lists the reasons with their sections.
   A ruling made at this meeting by the Sergeant-at-Arms or the Chair settles a "rule" case. */
export function judge(p, date, ruling) {
  const out = { cls: "vote", why: [] };
  const add = (ok, text, cite) => out.why.push({ ok, text, cite });
  const year = String(date || "").slice(0, 4);
  if (p.kind === "member") { add(false, "Party member, not a PCO", "1.2"); out.cls = "non"; return out; }
  if (p.kind === "apptofficer") { add(false, (p.office || "Appointed officer") + ": appointed officers don't vote", "5.5"); out.cls = "non"; return out; }
  if (p.kind === "captain") { add(false, "Precinct Captain: takes part, doesn't vote", "2.4"); out.cls = "non"; return out; }
  if (p.kind === "officer") add(true, "Elected CC officer" + (p.office ? " (" + p.office + ")" : ""), "1.2");
  if (p.kind === "elected") add(true, "Elected PCO", "2.1");
  if (p.kind === "appointed") {
    const d = p.appt ? daysBetween(p.appt, date) : -1;
    if (d < 0) { add(false, "Appointment date not on record", "2.2.1.D"); out.cls = "non"; }
    else if (d < 60) { add(false, "Appointed " + d + " days ago; votes from " + fmtDate(addDays(p.appt, 60), false), "2.2.1.D"); out.cls = "non"; }
    else add(true, "Appointed PCO, " + d + " days ago", "2.2.1.D");
  }
  if (p.inactive) { add(false, "Marked inactive by the District Chair", "2.6"); out.cls = "non"; }
  if (p.dues) add(true, year + " dues paid", "SR B");
  else { add(false, year + " dues not on record", "SR B"); if (out.cls === "vote") out.cls = "rule"; }
  if (ruling && out.cls !== "non") {
    add(ruling.vote, ruling.by + (ruling.vote ? " ruled they can vote" : " ruled they can't vote") + (ruling.why ? ": " + ruling.why : ""), ruling.by === "Chair" ? "Chair" : "5.4.6");
    out.cls = ruling.vote ? "vote" : "non";
  }
  return out;
}

export const present = (m, id) => { const c = m.ci[id]; return !!(c && !c.left); };

/* Quorum (4.4.1): 45% of the members authorized to vote, leaving out absentees who missed the
   previous two meetings. Pass a district number for a caucus. */
export function quorum(m, ld) {
  let pool = 0, here = 0, chronic = 0;
  for (const p of m.people) {
    if (ld != null && p.ld !== ld) continue;
    if (judge(p, m.config.date, m.rulings[p.id]).cls !== "vote") continue;
    pool++;
    const c = m.ci[p.id];
    if (c && !c.left) here++;
    else if (!c && p.missed2) chronic++;
  }
  const base = pool - chronic, need = Math.ceil((base * QUORUM_PCT) / 100);
  return { pool, here, chronic, base, need, met: need > 0 && here >= need };
}

/* Is check-in open? Closed at the Chair's declaration of quorum unless the Chair keeps it open
   (4.7.4.B); paper sign-in replaces it if the system fails (4.7.6). */
export function windowState(m) {
  if (m.paperAt) return { open: false, why: "paper", text: "Paper sign-in is in effect (4.7.6)" };
  if (m.closedAt) return { open: false, why: "closed", text: "Check-in closed when the Chair declared quorum (4.7.4.B)" };
  return { open: true, why: "", text: "Check-in open" };
}

export function districts(m) {
  return [...new Set(m.people.map(p => p.ld))].sort((a, b) => a - b);
}
