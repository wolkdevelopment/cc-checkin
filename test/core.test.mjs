/* The server: sign-in, credentials, the door, rulings, the Chair, District Chairs, the log, and
   what happens when several devices act at the same moment. Uses the in-memory store. */
import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryBlobs } from "../dev/memory-blobs.mjs";
import { handle, netlifyStore, verifyLog, credToken } from "../netlify/lib/core.mjs";
import { quorum, judge } from "../site/js/rules.js";

const ADMIN_KEY = "test-admin-key-123";
function setup() {
  const store = netlifyStore(createMemoryBlobs().getStore);
  let clock = Date.parse("2026-11-12T18:30:00-08:00");
  const deps = { store, env: { ADMIN_KEY }, now: () => clock };
  async function call(method, path, { token, body, ip = "1.1.1.1" } = {}) {
    const headers = { "content-type": "application/json" };
    if (token) headers.authorization = "Bearer " + token;
    const res = await handle(new Request("http://x" + path, { method, headers, body: body ? JSON.stringify(body) : undefined }), { ip }, deps);
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
    return { status: res.status, data, headers: res.headers };
  }
  const tick = ms => { clock += ms; };
  return { store, call, tick, deps };
}
async function ready() {
  const t = setup();
  const login = await t.call("POST", "/api/login", { body: { key: ADMIN_KEY } });
  assert.equal(login.status, 200);
  const admin = login.data.token;
  const s = await t.call("POST", "/api/act", { token: admin, body: { a: "setup", sample: true, name: "Central Committee meeting", date: "2026-11-12" } });
  assert.equal(s.status, 200, JSON.stringify(s.data));
  const devs = {};
  for (const [k, role, ld] of [["door", "door"], ["door2", "door"], ["saa", "saa"], ["chair", "chair"], ["ld27", "ld", 27]]) {
    const r = await t.call("POST", "/api/act", { token: admin, body: { a: "device-add", role, ld, label: k === "door2" ? "Door 2" : undefined } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    devs[k] = r.data.token;
  }
  const info = await t.call("GET", "/api/admin", { token: admin });
  const m = info.data.meeting;
  const cred = async pid => (await t.call("POST", "/api/act", { token: admin, body: { a: "credential", pid } })).data.token;
  const act = (who, body) => t.call("POST", "/api/act", { token: who, body });
  const live = async who => (await t.call("GET", "/api/live", { token: who })).data.meeting;
  return { ...t, admin, devs, m, cred, act, live };
}

test("admin sign-in: wrong keys lock out, the right key works", async () => {
  const t = setup();
  for (let i = 0; i < 10; i++) assert.equal((await t.call("POST", "/api/login", { body: { key: "nope" } })).status, 401);
  assert.equal((await t.call("POST", "/api/login", { body: { key: ADMIN_KEY } })).status, 429, "locked out after 10 wrong keys");
  const other = await t.call("POST", "/api/login", { body: { key: ADMIN_KEY }, ip: "2.2.2.2" });
  assert.equal(other.status, 200);
  assert.equal((await t.call("GET", "/api/whoami", { token: other.data.token })).data.you.role, "admin");
  assert.equal((await t.call("GET", "/api/live", { token: "DV1.abcdefgh.AAAAAAAAAAAAAAAAAAAAAA" })).status, 401);
});

test("the sample roster has every case, and the rules match the bylaws", async () => {
  const t = await ready();
  const s = t.m.samples, get = id => t.m.people.find(p => p.id === id), date = t.m.config.date;
  assert.equal(judge(get(s.eligible), date).cls, "vote");
  assert.equal(judge(get(s.officer), date).cls, "vote");
  assert.equal(judge(get(s.appointed), date).cls, "non");
  assert.match(judge(get(s.appointed), date).why.map(w => w.text).join(" "), /41 days/);
  assert.equal(judge(get(s.captain), date).cls, "non");
  assert.equal(judge(get(s.dues), date).cls, "rule");
  assert.equal(judge(get(s.inactive), date).cls, "non");
  const q = quorum(t.m);
  assert.equal(q.need, Math.ceil((q.base * 45) / 100));
  assert.ok(q.chronic > 0, "absentees who missed two meetings drop out of the base");
});

test("credential page, scan, check in, and the duplicate", async () => {
  const t = await ready();
  const pid = t.m.samples.eligible, token = await t.cred(pid);
  assert.match(token, /^CC1\.[a-z0-9]+\.1\.[A-Za-z0-9_-]{22}$/);
  let me = await t.call("GET", "/api/me", { token });
  assert.equal(me.status, 200);
  assert.equal(me.data.judge.cls, "vote");
  assert.equal(me.data.checkin, null);
  const etag = me.data.etag;
  assert.equal((await t.call("GET", "/api/me?etag=" + encodeURIComponent(etag), { token })).status, 204, "nothing changed");

  const v = await t.call("POST", "/api/scan", { token: t.devs.door, body: { text: token } });
  assert.equal(v.data.kind, "vote");
  assert.equal(v.data.card, 101);
  const c = await t.act(t.devs.door, { a: "checkin", pid, how: "scan", ver: v.data.ver });
  assert.equal(c.status, 200);
  assert.equal(c.data.card, 101);

  me = await t.call("GET", "/api/me?etag=" + encodeURIComponent(etag), { token });
  assert.equal(me.status, 200, "the PCO's page sees the change");
  assert.equal(me.data.checkin.card, 101);

  const again = await t.call("POST", "/api/scan", { token: t.devs.door2, body: { text: token } });
  assert.equal(again.data.kind, "dup");
  assert.equal(again.data.checkin.card, 101);
  assert.equal((await t.act(t.devs.door2, { a: "checkin", pid, how: "scan", ver: 1 })).status, 409);
});

test("two doors scanning the same person at the same moment: only one check-in", async () => {
  const t = await ready();
  const pid = t.m.samples.eligible;
  const rs = await Promise.all([t.devs.door, t.devs.door2, t.devs.door, t.devs.door2].map(d => t.act(d, { a: "checkin", pid, how: "name" })));
  assert.deepEqual(rs.map(r => r.status).sort(), [200, 409, 409, 409]);
  const m = await t.live(t.devs.saa);
  assert.equal(Object.keys(m.ci).length, 1);
});

test("many check-ins at once: every voter gets a different card, nothing is lost", async () => {
  const t = await ready();
  const date = t.m.config.date;
  const voters = t.m.people.filter(p => judge(p, date).cls === "vote").slice(0, 30);
  const rs = await Promise.all(voters.map((p, i) => t.act(i % 2 ? t.devs.door : t.devs.door2, { a: "checkin", pid: p.id, how: "name" })));
  assert.ok(rs.every(r => r.status === 200), JSON.stringify(rs.find(r => r.status !== 200)?.data));
  const cards = rs.map(r => r.data.card).sort((a, b) => a - b);
  assert.deepEqual(cards, Array.from({ length: 30 }, (_, i) => 101 + i));
  const m = await t.live(t.devs.chair);
  assert.equal(Object.keys(m.ci).length, 30);
  const full = await t.call("GET", "/api/log", { token: t.admin });
  assert.deepEqual(verifyLog(full.data.log), { ok: true, n: full.data.log.length });
});

test("altered, old and unknown credentials are caught", async () => {
  const t = await ready();
  const pid = t.m.samples.captain, token = await t.cred(pid);
  const [cc, id, ver, sig] = token.split(".");
  const flipped = sig[0] === "A" ? "B" + sig.slice(1) : "A" + sig.slice(1);
  assert.equal((await t.call("POST", "/api/scan", { token: t.devs.door, body: { text: [cc, id, ver, flipped].join(".") } })).data.kind, "forged");
  const other = t.m.samples.eligible;
  assert.equal((await t.call("POST", "/api/scan", { token: t.devs.door, body: { text: [cc, other, ver, sig].join(".") } })).data.kind, "forged", "someone else's id with this signature");
  assert.equal((await t.call("POST", "/api/scan", { token: t.devs.door, body: { text: "hello" } })).data.kind, "notcred");
  const re = await t.act(t.admin, { a: "reissue-credential", pid });
  assert.equal(re.status, 200);
  assert.equal((await t.call("POST", "/api/scan", { token: t.devs.door, body: { text: token } })).data.kind, "old");
  assert.equal((await t.call("GET", "/api/me", { token })).status, 410, "the old link says it was replaced");
  assert.equal((await t.call("POST", "/api/scan", { token: t.devs.door, body: { text: re.data.token } })).data.kind, "non");
});

test("dues question: in without a card, then the Sergeant-at-Arms clears it", async () => {
  const t = await ready();
  const pid = t.m.samples.dues;
  const v = await t.call("POST", "/api/scan", { token: t.devs.door, body: { text: await t.cred(pid) } });
  assert.equal(v.data.kind, "rule");
  const c = await t.act(t.devs.door, { a: "checkin", pid, how: "scan", ver: 1 });
  assert.equal(c.data.card, null);
  let m = await t.live(t.devs.saa);
  const it = m.queue.find(x => x.pid === pid);
  assert.equal(it.issue, "dues");
  assert.equal((await t.act(t.devs.door, { a: "resolve", q: it.q, action: "paid" })).status, 403, "the door can't rule");
  const r = await t.act(t.devs.saa, { a: "resolve", q: it.q, action: "paid" });
  assert.equal(r.status, 200);
  assert.equal(r.data.card, 101);
  m = await t.live(t.devs.saa);
  assert.equal(m.queue.length, 0);
  assert.equal(m.ci[pid].card, 101);
});

test("the Chair: call to order, quorum, closing and reopening check-in, paper", async () => {
  const t = await ready();
  assert.equal((await t.act(t.devs.chair, { a: "declare" })).status, 409, "must call to order first");
  assert.equal((await t.act(t.devs.door, { a: "call" })).status, 403, "the door can't");
  assert.equal((await t.act(t.devs.chair, { a: "call" })).status, 200);
  assert.equal((await t.act(t.devs.chair, { a: "declare" })).status, 409, "not at quorum");
  const date = t.m.config.date, q = quorum(t.m);
  // People who missed the last two meetings rejoin the quorum base when they show up (4.4.1),
  // which raises the number needed; pick from everyone else so q.need stays fixed.
  const voters = t.m.people.filter(p => judge(p, date).cls === "vote" && !p.missed2).slice(0, q.need);
  for (const p of voters) assert.equal((await t.act(t.devs.door, { a: "checkin", pid: p.id, how: "name" })).status, 200);
  let m = await t.live(t.devs.chair);
  assert.ok(m.reachedAt, "quorum noted when reached");
  assert.equal((await t.act(t.devs.chair, { a: "declare" })).status, 200);
  m = await t.live(t.devs.chair);
  assert.ok(m.closedAt, "closes at quorum by default (4.7.4.B)");
  const late = t.m.people.filter(p => judge(p, date).cls === "vote" && !m.ci[p.id])[0];
  const r = await t.act(t.devs.door, { a: "checkin", pid: late.id, how: "name" });
  assert.equal(r.status, 409);
  assert.match(r.data.error, /4\.7\.4\.B/);
  assert.equal((await t.act(t.devs.chair, { a: "reopen" })).status, 200);
  assert.equal((await t.act(t.devs.door, { a: "checkin", pid: late.id, how: "name" })).status, 200);
  assert.equal((await t.act(t.devs.chair, { a: "paper" })).status, 200);
  const p2 = t.m.people.filter(p => judge(p, date).cls === "vote" && !m.ci[p.id] && p.id !== late.id)[0];
  assert.match((await t.act(t.devs.door, { a: "checkin", pid: p2.id, how: "name" })).data.error, /4\.7\.6/);
});

test("card back and back in change the count", async () => {
  const t = await ready();
  const pid = t.m.samples.eligible;
  await t.act(t.devs.door, { a: "checkin", pid, how: "name" });
  const before = quorum(await t.live(t.devs.saa)).here;
  assert.equal((await t.act(t.devs.saa, { a: "leave", pid })).status, 200);
  assert.equal(quorum(await t.live(t.devs.saa)).here, before - 1);
  const v = await t.call("POST", "/api/scan", { token: t.devs.door, body: { text: await t.cred(pid) } });
  assert.equal(v.data.kind, "back");
  assert.equal((await t.act(t.devs.door, { a: "checkin", pid, how: "scan", ver: 1 })).data.back, true);
  assert.equal(quorum(await t.live(t.devs.saa)).here, before);
});

test("District Chairs mark inactive only in their own district, and only absent PCOs", async () => {
  const t = await ready();
  const own = t.m.people.find(p => p.ld === 27 && p.kind === "elected" && !p.inactive && p.id !== t.m.samples.eligible);
  const other = t.m.people.find(p => p.ld === 26 && p.kind === "elected");
  assert.equal((await t.act(t.devs.ld27, { a: "inactive", pid: other.id, on: true })).status, 403);
  assert.equal((await t.act(t.devs.ld27, { a: "inactive", pid: own.id, on: true })).status, 200);
  await t.act(t.devs.door, { a: "checkin", pid: t.m.samples.eligible, how: "name" });
  assert.equal((await t.act(t.devs.ld27, { a: "inactive", pid: t.m.samples.eligible, on: true })).status, 409);
  const m = await t.live(t.devs.ld27);
  assert.equal(m.people.find(p => p.id === own.id).inactive, true);
});

test("guests, forged-code questions, adding a person, devices, the CSV roll", async () => {
  const t = await ready();
  assert.equal((await t.act(t.devs.door, { a: "guest", name: "Robin Hayes" })).status, 200);
  const ask = await t.act(t.devs.door, { a: "ask", issue: "forged", claims: "Someone" });
  assert.equal(ask.status, 200);
  assert.equal((await t.act(t.devs.saa, { a: "resolve", q: ask.data.q, action: "turnaway" })).status, 200);
  const add = await t.act(t.admin, { a: "person-add", person: { name: "Test Person", pct: "27-488", ld: 27, kind: "elected" } });
  assert.equal(add.status, 200, JSON.stringify(add.data));
  assert.equal((await t.call("GET", "/api/me", { token: add.data.token })).data.judge.cls, "vote");
  assert.equal((await t.act(t.admin, { a: "person-add", person: { name: "X", pct: "27-1", ld: 27, kind: "elected" } })).status, 400);
  assert.equal((await t.act(t.admin, { a: "person-add", person: { name: "New Appointee", pct: "27-490", ld: 27, kind: "appointed" } })).status, 400, "needs a date");
  await t.act(t.devs.door, { a: "checkin", pid: add.data.person.id, how: "name" });
  const csv = await t.call("GET", "/api/export?what=roll", { token: t.admin });
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get("content-disposition"), /roll-2026-11-12\.csv/);
  assert.match(csv.data, /Test Person,27-488,27,Elected PCO/);
  assert.match(csv.data, /Robin Hayes/);
  assert.match(csv.data, /Log fingerprint,[0-9a-f]{64}/);
  assert.equal((await t.call("GET", "/api/export?what=roll", { token: t.devs.door })).status, 403);
  const info = await t.call("GET", "/api/admin", { token: t.admin });
  const door = info.data.devices.find(d => d.label === "Door 2");
  assert.equal((await t.act(t.admin, { a: "device-revoke", id: door.id })).status, 200);
  assert.equal((await t.call("GET", "/api/live", { token: t.devs.door2 })).status, 401, "a signed-out device stops working");
  assert.equal((await t.call("GET", "/api/live", { token: await t.cred(t.m.samples.eligible) })).status, 401, "a PCO credential can't open officer screens");
});

test("the live feed answers 204 when nothing changed", async () => {
  const t = await ready();
  const first = await t.call("GET", "/api/live", { token: t.devs.chair });
  const etag = first.data.etag;
  assert.equal((await t.call("GET", "/api/live?etag=" + encodeURIComponent(etag), { token: t.devs.chair })).status, 204);
  await t.act(t.devs.door, { a: "guest", name: "Dale Prescott" });
  const after = await t.call("GET", "/api/live?etag=" + encodeURIComponent(etag), { token: t.devs.chair });
  assert.equal(after.status, 200);
  assert.equal(after.data.meeting.guests.length, 1);
  assert.equal(after.data.meeting.log, undefined, "the full log isn't sent every time");
});

test("test check-ins fill the room but leave the sample cases alone", async () => {
  const t = await ready();
  const r = await t.act(t.admin, { a: "test-fill", n: 40 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.added, 40);
  const m = await t.live(t.devs.chair);
  assert.equal(Object.keys(m.ci).length, 40);
  for (const id of Object.values(m.samples)) assert.equal(m.ci[id], undefined);
  assert.equal(m.queue.length, 0);
  assert.equal((await t.act(t.devs.door, { a: "test-fill", n: 5 })).status, 403);
});
