/* The check-in server. One Netlify Function (netlify/functions/api.mjs) sends every /api/ request
   here. Storage is one Netlify Blobs store:
     meeting  the current meeting: settings, roster, check-ins, questions, rulings, and the log
     devices  officer devices and their roles (door, Sergeant-at-Arms, Chair, District Chair, admin)
     secret   the key that signs credentials and device links, made on first use
     fail/... wrong admin-key attempts, by scrambled connection
   Every change to the meeting is a conditional write, retried if two requests collide, so two doors
   can't check in the same person twice or hand out the same card number. */
import crypto from "node:crypto";
import { judge, quorum, present, windowState, KIND, PCO_KINDS, fmtDate } from "../../site/js/rules.js";
import { sampleRoster } from "./sample.mjs";

export const STORE_NAME = "cc-checkin";
export function netlifyStore(getStore) { return getStore({ name: STORE_NAME, consistency: "strong" }); }

const ZERO = "0".repeat(64);
const LOG_TAIL = 40;
const MAX_BODY = 16000;
const HOUR = 3600e3;
export const ROLE_NAMES = { door: "Door", saa: "Sergeant-at-Arms", chair: "Chair", ld: "District Chair", admin: "Admin" };
const CAN = {
  live: ["door", "saa", "chair", "ld", "admin"],
  scan: ["door", "saa", "admin"],
  door: ["door", "saa", "admin"],
  saa: ["saa", "admin"],
  chair: ["chair", "admin"],
  district: ["ld", "admin"],
  log: ["saa", "chair", "ld", "admin"],
  admin: ["admin"]
};
const HOW = { scan: "credential scan", name: "name search", saa: "the Sergeant-at-Arms after an ID check", chair: "the Chair's ruling" };

class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}
const fail = (status, message, extra) => { throw new HttpError(status, message, extra); };
function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}
const wait = ms => new Promise(r => setTimeout(r, ms));

/* Compare-and-swap on one stored document. fn gets a copy and returns the new value
   (or undefined for no change); it may throw to refuse. */
export async function cas(store, key, fn, tries = 10) {
  for (let i = 0; i < tries; i++) {
    const cur = await store.getWithMetadata(key, { type: "json" });
    const data = cur ? cur.data : null;
    const next = fn(data == null ? null : structuredClone(data));
    if (next === undefined) return { data, changed: false, etag: cur && cur.etag };
    const res = cur ? await store.setJSON(key, next, { onlyIfMatch: cur.etag }) : await store.setJSON(key, next, { onlyIfNew: true });
    if (res && res.modified) return { data: next, changed: true, etag: res.etag };
    await wait(10 + Math.random() * 30 * (i + 1));
  }
  fail(503, "The system is busy. Try again.");
}

/* ---------- signing ---------- */
const secrets = new WeakMap();
async function getSecret(store, env) {
  if (env.SIGNING_SECRET && String(env.SIGNING_SECRET).length >= 16) return String(env.SIGNING_SECRET);
  if (secrets.has(store)) return secrets.get(store);
  let s = await store.get("secret", { type: "json" });
  if (!s || !s.key) {
    await store.setJSON("secret", { key: crypto.randomBytes(32).toString("base64url"), created: Date.now() }, { onlyIfNew: true });
    s = await store.get("secret", { type: "json" });
  }
  secrets.set(store, s.key);
  return s.key;
}
const mac = (secret, msg) => crypto.createHmac("sha256", secret).update(msg).digest("base64url").slice(0, 22);
function safeEq(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function sameSecret(a, b) {
  const x = crypto.createHash("sha256").update(String(a)).digest(), y = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}
// A PCO's credential: CC1.<person>.<version>.<signature>. Short, so the QR code stays small and easy to scan.
export const credToken = (secret, p) => "CC1." + p.id + "." + p.ver + "." + mac(secret, "cc1." + p.id + "." + p.ver);
export const deviceToken = (secret, d) => "DV1." + d.id + "." + mac(secret, "dv1." + d.id);
const CRED_RE = /^CC1\.([a-z0-9]{4,16})\.(\d{1,6})\.([A-Za-z0-9_-]{22})$/;
const DEV_RE = /^DV1\.([a-z0-9]{4,16})\.([A-Za-z0-9_-]{22})$/;
function parseCred(secret, text) {
  const m = CRED_RE.exec(String(text || "").trim());
  if (!m) return null;
  return { pid: m[1], ver: Number(m[2]), valid: safeEq(m[3], mac(secret, "cc1." + m[1] + "." + m[2])) };
}
function randId(n = 6) {
  const a = "abcdefghjkmnpqrstuvwxyz23456789", b = crypto.randomBytes(n);
  let s = "";
  for (let i = 0; i < n; i++) s += a[b[i] % a.length];
  return s;
}
const bearer = req => { const h = req.headers.get("authorization") || ""; return h.startsWith("Bearer ") ? h.slice(7).trim() : ""; };
const clientIp = (req, context) => (context && context.ip) || req.headers.get("x-nf-client-connection-ip") || "unknown";

/* ---------- devices ---------- */
async function deviceList(store) { const d = await store.get("devices", { type: "json" }); return d && Array.isArray(d.list) ? d.list : []; }
async function authDevice(req, store, secret) {
  const m = DEV_RE.exec(bearer(req));
  if (!m || !safeEq(m[2], mac(secret, "dv1." + m[1]))) return null;
  return (await deviceList(store)).find(d => d.id === m[1] && !d.revoked) || null;
}
const pubDevice = d => ({ id: d.id, role: d.role, roleName: ROLE_NAMES[d.role], label: d.label, ld: d.ld == null ? null : d.ld });
async function addDevice(store, d) {
  await cas(store, "devices", data => {
    let list = (data && data.list) || [];
    list.push(d);
    // Keep the list short: old admin sign-ins drop off first.
    const admins = list.filter(x => x.role === "admin");
    if (admins.length > 30) { const drop = new Set(admins.slice(0, admins.length - 30).map(x => x.id)); list = list.filter(x => !drop.has(x.id)); }
    return { list: list.slice(-300) };
  });
}

/* ---------- the meeting ---------- */
const person = (m, pid) => m.people.find(p => p.id === String(pid || ""));
const pubPerson = p => ({ id: p.id, name: p.name, pct: p.pct, ld: p.ld, kind: p.kind, kindName: KIND[p.kind], office: p.office || "" });
function addLog(m, now, who, what) {
  const prev = m.log.length ? m.log[m.log.length - 1].h : ZERO;
  const e = { n: m.log.length + 1, t: now, who, what };
  e.h = crypto.createHash("sha256").update(prev + "|" + e.n + "|" + e.t + "|" + who + "|" + what).digest("hex");
  m.log.push(e);
}
export function verifyLog(log) {
  let prev = ZERO;
  for (const e of log) {
    const h = crypto.createHash("sha256").update(prev + "|" + e.n + "|" + e.t + "|" + e.who + "|" + e.what).digest("hex");
    if (h !== e.h) return { ok: false, at: e.n };
    prev = e.h;
  }
  return { ok: true, n: log.length };
}
function newMeeting(config, people, samples, now, by) {
  const m = { v: 1, config, people, samples: samples || null, ci: {}, guests: [], queue: [], rulings: {}, calledAt: null, quorumAt: null, closedAt: null, paperAt: null, reachedAt: null, cards: 101, nq: 1, log: [], started: now };
  addLog(m, now, by, "Opened check-in for " + config.name + " on " + fmtDate(config.date) + " (" + people.length + " people on the roster)");
  return m;
}
async function mutate(store, fn) {
  let result;
  const r = await cas(store, "meeting", m => {
    if (!m) fail(409, "No meeting is set up yet. The Secretary sets one up on the admin page.");
    result = fn(m);
    return m;
  });
  return { m: r.data, etag: r.etag, result };
}
// The Sergeant-at-Arms tells the Chair when quorum is reached (5.4.6); the system records the moment.
function noteQuorum(m, now) {
  if (m.reachedAt) return;
  const q = quorum(m);
  if (q.met) {
    m.reachedAt = now;
    addLog(m, now, "Check-in system", "Quorum reached: " + q.here + " voting members present, " + q.need + " needed (4.4.1)");
  }
}
function queueItem(m, now, by, pid, issue, extra) {
  const it = { q: m.nq++, pid: pid || null, issue, t: now, by, stage: "saa", ...(extra || {}) };
  m.queue.push(it);
  const p = pid && person(m, pid);
  const what = { dues: "dues not on record", dup: "credential already used tonight", forged: "credential failed the signature check", old: "an old credential", unknown: "a credential for someone not on the roster" }[issue];
  addLog(m, now, by, (p ? p.name : (extra && extra.claims) || "Someone") + " sent to the Sergeant-at-Arms: " + what);
  return it;
}
function doCheckin(m, p, by, how, now) {
  const j = judge(p, m.config.date, m.rulings[p.id]);
  const card = j.cls === "vote" ? m.cards++ : null;
  m.ci[p.id] = { t: now, by, card, how };
  addLog(m, now, by, p.name + " (" + p.pct + ") checked in by " + HOW[how] + ", " + (card ? "voting card " + card : "no voting card"));
  if (j.cls === "rule" && !m.queue.some(x => x.pid === p.id && x.issue === "dues")) queueItem(m, now, by, p.id, "dues");
  noteQuorum(m, now);
  return { card, cls: j.cls };
}
function giveCard(m, p, by, now) {
  const c = m.ci[p.id];
  if (!c || c.card || judge(p, m.config.date, m.rulings[p.id]).cls !== "vote") return null;
  c.card = m.cards++;
  addLog(m, now, by, p.name + " handed voting card " + c.card);
  noteQuorum(m, now);
  return c.card;
}

/* What the door sees when it scans a code. Changes nothing. */
function verdict(m, secret, text) {
  const c = parseCred(secret, text);
  if (!c) return { kind: "notcred" };
  const p = person(m, c.pid);
  if (!c.valid) return { kind: "forged", claims: p ? pubPerson(p) : null };
  if (!p) return { kind: "unknown" };
  if (c.ver !== p.ver) return { kind: "old", person: pubPerson(p) };
  const ci = m.ci[p.id];
  if (ci && !ci.left) return { kind: "dup", person: pubPerson(p), checkin: ci };
  const j = judge(p, m.config.date, m.rulings[p.id]);
  if (ci && ci.left) return { kind: "back", person: pubPerson(p), why: j.why, card: ci.card, ver: c.ver };
  return { kind: j.cls, person: pubPerson(p), why: j.why, card: j.cls === "vote" ? m.cards : null, ver: c.ver, queued: m.queue.some(x => x.pid === p.id) };
}

/* ---------- input ---------- */
async function readBody(req) {
  const text = await req.text();
  if (text.length > MAX_BODY) fail(413, "Too much data.");
  if (!text) return {};
  try { const v = JSON.parse(text); return v && typeof v === "object" ? v : {}; } catch (e) { fail(400, "Bad request."); }
}
function cleanText(v, min, max, what) {
  const s = String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (s.length < min || s.length > max) fail(400, what + (min > 0 ? " needs " + min + " to " + max + " characters." : " can be up to " + max + " characters."));
  return s;
}
function cleanDate(v, what) {
  const s = String(v || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || isNaN(Date.parse(s + "T12:00:00Z"))) fail(400, what + " needs a date.");
  return s;
}
function cleanPerson(b, base) {
  const p = { ...base };
  if ("name" in b || !base) p.name = cleanText(b.name, 2, 80, "Name");
  if ("pct" in b || !base) { p.pct = cleanText(b.pct, 1, 12, "Precinct"); if (!/^[0-9A-Za-z-]+$/.test(p.pct)) fail(400, "Precinct can use numbers, letters and a dash, like 27-488."); }
  if ("ld" in b || !base) { p.ld = Number(b.ld); if (!Number.isInteger(p.ld) || p.ld < 1 || p.ld > 49) fail(400, "Legislative District needs a number from 1 to 49."); }
  if ("kind" in b || !base) { p.kind = String(b.kind || "elected"); if (!KIND[p.kind]) fail(400, "Unknown role."); }
  if ("office" in b) p.office = cleanText(b.office, 0, 40, "Office");
  if ("appt" in b) p.appt = b.appt ? cleanDate(b.appt, "Appointment date") : "";
  for (const k of ["dues", "inactive", "missed2", "missedAny"]) if (k in b) p[k] = !!b[k];
  if (!base) {
    if (p.kind === "appointed" && !p.appt) fail(400, "An appointed PCO needs an appointment date (2.2.1.D).");
    Object.assign(p, { office: p.office || "", appt: p.appt || "", dues: "dues" in b ? !!b.dues : true, inactive: !!b.inactive, missed2: !!b.missed2, missedAny: !!b.missedAny, ver: 1 });
  }
  return p;
}
function need(dev, roles) { if (!roles.includes(dev.role)) fail(403, "This device's role (" + ROLE_NAMES[dev.role] + ") can't do that."); }
function todayIn(tz) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  return parts;
}

/* ---------- requests ---------- */
export async function handle(req, context, deps) {
  const { store, env } = deps;
  const now = deps.now ? deps.now() : Date.now();
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "");
  try {
    const secret = await getSecret(store, env);
    if (path === "/api/login" && req.method === "POST") return await login(req, context, store, env, secret, now);
    if (path === "/api/me" && req.method === "GET") return await me(req, store, secret, url);
    const dev = await authDevice(req, store, secret);
    if (!dev) return json(401, { error: "This device isn't signed in, or it was signed out. Open its link again, or sign in.", signedOut: true });
    if (path === "/api/whoami" && req.method === "GET") return json(200, { you: pubDevice(dev) });
    if (path === "/api/live" && req.method === "GET") { need(dev, CAN.live); return await live(store, dev, url); }
    if (path === "/api/log" && req.method === "GET") {
      need(dev, CAN.log);
      const m = await store.get("meeting", { type: "json" });
      return json(200, { log: m ? m.log : [] });
    }
    if (path === "/api/scan" && req.method === "POST") {
      need(dev, CAN.scan);
      const b = await readBody(req);
      const m = await store.get("meeting", { type: "json" });
      if (!m) fail(409, "No meeting is set up yet.");
      return json(200, { ...verdict(m, secret, b.text), window: windowState(m) });
    }
    if (path === "/api/act" && req.method === "POST") return await act(req, store, env, secret, dev, now);
    if (path === "/api/admin" && req.method === "GET") {
      need(dev, CAN.admin);
      const [m, list] = await Promise.all([store.get("meeting", { type: "json" }), deviceList(store)]);
      return json(200, {
        you: pubDevice(dev),
        today: todayIn(env.TIMEZONE || "America/Los_Angeles"),
        meeting: m ? { ...m, log: undefined, logLen: m.log.length, logTail: m.log.slice(-LOG_TAIL) } : null,
        devices: list.filter(d => !d.revoked).map(d => ({ ...pubDevice(d), created: d.created, token: deviceToken(secret, d) }))
      });
    }
    if (path === "/api/export" && req.method === "GET") { need(dev, CAN.admin); return await exportCsv(store, env, url); }
    return json(404, { error: "Not found." });
  } catch (e) {
    if (e instanceof HttpError) return json(e.status, { error: e.message, ...(e.extra || {}) });
    console.error(e);
    return json(500, { error: "Something went wrong on the server. Try again." });
  }
}

async function login(req, context, store, env, secret, now) {
  const key = String(env.ADMIN_KEY || "");
  if (key.length < 12) fail(503, "The admin key isn't set up. Set ADMIN_KEY (12 characters or more) in Netlify and redeploy.");
  const b = await readBody(req);
  const failKey = "fail/" + crypto.createHash("sha256").update(secret + "|" + clientIp(req, context)).digest("hex").slice(0, 32);
  const rec = await store.get(failKey, { type: "json" });
  const recent = ((rec && rec.t) || []).filter(t => t > now - HOUR);
  if (recent.length >= 10) fail(429, "Too many wrong keys from this connection. Try again in an hour.");
  if (!sameSecret(String(b.key || ""), key)) {
    recent.push(now);
    await store.setJSON(failKey, { t: recent });
    fail(401, "That key isn't right.");
  }
  const d = { id: randId(8), role: "admin", label: "Admin", ld: null, created: now };
  await addDevice(store, d);
  return json(200, { token: deviceToken(secret, d), you: pubDevice(d) });
}

// Reads the meeting, or answers 204 when it hasn't changed since the etag the page already has.
async function readMeeting(store, known) {
  let r = await store.getWithMetadata("meeting", known ? { type: "json", etag: known } : { type: "json" });
  if (!r && known) r = await store.getWithMetadata("meeting", { type: "json" });
  if (r && known && r.etag === known) return { same: true };
  if (r && r.data == null) r = await store.getWithMetadata("meeting", { type: "json" });
  return r ? { m: r.data, etag: r.etag } : { m: null };
}
async function live(store, dev, url) {
  const r = await readMeeting(store, url.searchParams.get("etag") || "");
  if (r.same) return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  if (!r.m) return json(200, { none: true, you: pubDevice(dev) });
  const { log, ...rest } = r.m;
  return json(200, { etag: r.etag, you: pubDevice(dev), meeting: { ...rest, logTail: log.slice(-LOG_TAIL), logLen: log.length } });
}
async function me(req, store, secret, url) {
  const c = parseCred(secret, bearer(req));
  if (!c || !c.valid) return json(401, { error: "This credential link isn't valid. Ask the Secretary for a new one.", invalid: true });
  const r = await readMeeting(store, url.searchParams.get("etag") || "");
  if (r.same) return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  if (!r.m) return json(404, { error: "There's no meeting set up right now.", none: true });
  const m = r.m, p = person(m, c.pid);
  if (!p) return json(404, { error: "This credential isn't on the current roster. Ask the Secretary.", gone: true });
  if (p.ver !== c.ver) return json(410, { error: "This credential was replaced. Ask the Secretary for your new link.", replaced: true });
  const ci = m.ci[p.id];
  return json(200, {
    etag: r.etag,
    meeting: { name: m.config.name, date: m.config.date },
    person: pubPerson(p),
    judge: judge(p, m.config.date, m.rulings[p.id]),
    checkin: ci ? { t: ci.t, card: ci.card, left: ci.left || null } : null,
    window: windowState(m),
    attendance: { missed2: !!p.missed2, missedAny: !!p.missedAny },
    queued: m.queue.some(x => x.pid === p.id)
  });
}

async function act(req, store, env, secret, dev, now) {
  const b = await readBody(req);
  const a = String(b.a || "");
  const by = dev.role === "admin" ? "Admin" : dev.label;
  const ok = (r, extra) => json(200, { ok: true, etag: r.etag, ...(r.result || {}), ...(extra || {}) });
  switch (a) {
    /* ----- the door ----- */
    case "checkin": {
      need(dev, CAN.door);
      return ok(await mutate(store, m => {
        const p = person(m, b.pid);
        if (!p) fail(404, "That person isn't on the roster.");
        const c = m.ci[p.id];
        if (c && c.left) { c.left = null; addLog(m, now, by, p.name + " came back in" + (c.card ? "; voting card " + c.card + " out again" : "")); return { card: c.card, back: true, name: p.name }; }
        if (c) fail(409, p.name + " is already checked in" + (c.card ? " with card " + c.card : "") + ".", { dup: true });
        const w = windowState(m);
        if (!w.open) fail(409, w.text, { closed: true });
        const how = b.how === "scan" ? "scan" : "name";
        if (how === "scan" && Number(b.ver) !== p.ver) fail(409, "That credential was replaced. Send them to the Sergeant-at-Arms.");
        return { ...doCheckin(m, p, by, how, now), name: p.name };
      }));
    }
    case "guest": {
      need(dev, CAN.door);
      const name = cleanText(b.name, 2, 80, "Guest name");
      return ok(await mutate(store, m => {
        m.guests.push({ name, t: now, by });
        addLog(m, now, by, name + " signed the guest list (SR J.3)");
        return { name };
      }));
    }
    case "ask": {
      need(dev, CAN.door);
      const issue = String(b.issue || "");
      if (!["dues", "dup", "forged", "old", "unknown"].includes(issue)) fail(400, "Unknown question.");
      return ok(await mutate(store, m => {
        const p = b.pid ? person(m, b.pid) : null;
        if (b.pid && !p) fail(404, "That person isn't on the roster.");
        const open = m.queue.find(x => x.pid === (p ? p.id : null) && x.issue === issue && p);
        if (open) return { q: open.q };
        return { q: queueItem(m, now, by, p ? p.id : null, issue, b.claims ? { claims: cleanText(b.claims, 0, 80, "Name") } : null).q };
      }));
    }
    /* ----- the Sergeant-at-Arms and the Chair ----- */
    case "resolve": {
      const action = String(b.action || "");
      const chairActs = ["allow", "deny"], saaActs = ["paid", "novote", "tochair", "dismiss", "turnaway", "admit", "reissue"];
      if (chairActs.includes(action)) need(dev, CAN.chair);
      else if (saaActs.includes(action)) need(dev, CAN.saa);
      else fail(400, "Unknown action.");
      const saaName = dev.role === "admin" ? "Admin" : "Sergeant-at-Arms";
      return ok(await mutate(store, m => {
        const it = m.queue.find(x => x.q === Number(b.q));
        if (!it) fail(404, "That question was already settled.");
        const p = it.pid ? person(m, it.pid) : null;
        const done = () => { m.queue = m.queue.filter(x => x !== it); };
        const year = m.config.date.slice(0, 4);
        if ((action !== "turnaway" && action !== "dismiss" && action !== "tochair") && !p) fail(409, "This question isn't tied to anyone on the roster. Turn them away or check them in by name.");
        switch (action) {
          case "paid": {
            p.dues = true;
            addLog(m, now, saaName, "Recorded " + year + " dues paid at the door for " + p.name);
            done();
            const card = m.ci[p.id] ? giveCard(m, p, saaName, now) : doCheckin(m, p, saaName, "saa", now).card;
            return { card, name: p.name };
          }
          case "novote": {
            m.rulings[p.id] = { vote: false, by: "Sergeant-at-Arms", why: year + " dues not paid", t: now };
            addLog(m, now, saaName, "Ruled " + p.name + " can't vote at this meeting: " + year + " dues not paid");
            done();
            if (!m.ci[p.id]) doCheckin(m, p, saaName, "saa", now);
            return { name: p.name };
          }
          case "tochair":
            it.stage = "chair";
            addLog(m, now, saaName, "Sent " + (p ? p.name + "'s" : "a") + " question to the Chair");
            return {};
          case "allow": {
            m.rulings[p.id] = { vote: true, by: "Chair", why: "settled for this meeting", t: now };
            addLog(m, now, "Chair", "Ruled " + p.name + " can vote at this meeting");
            done();
            const card = m.ci[p.id] ? giveCard(m, p, "Chair", now) : doCheckin(m, p, "Chair", "chair", now).card;
            return { card, name: p.name };
          }
          case "deny": {
            m.rulings[p.id] = { vote: false, by: "Chair", why: "", t: now };
            addLog(m, now, "Chair", "Ruled " + p.name + " can't vote at this meeting");
            done();
            if (!m.ci[p.id]) doCheckin(m, p, "Chair", "chair", now);
            return { name: p.name };
          }
          case "dismiss":
            addLog(m, now, saaName, "Settled: " + (p ? p.name + "'s " : "") + "second scan was the same person; no action");
            done();
            return {};
          case "turnaway":
            addLog(m, now, saaName, "Turned away someone showing " + (p ? p.name + "'s" : "a") + (it.issue === "forged" ? " altered" : "") + " credential");
            done();
            return {};
          case "admit": {
            if (present(m, p.id)) fail(409, p.name + " is already checked in.");
            done();
            if (it.issue === "forged") { p.ver++; addLog(m, now, saaName, "Reissued " + p.name + "'s credential (version " + p.ver + "); older ones no longer work"); }
            const r = m.ci[p.id] ? (m.ci[p.id].left = null, { card: m.ci[p.id].card }) : doCheckin(m, p, saaName, "saa", now);
            return { card: r.card, name: p.name };
          }
          case "reissue":
            p.ver++;
            addLog(m, now, saaName, "Someone else used " + p.name + "'s credential. Reissued it (version " + p.ver + "); older ones no longer work");
            done();
            return { name: p.name };
        }
      }));
    }
    case "leave":
    case "back": {
      need(dev, CAN.saa);
      return ok(await mutate(store, m => {
        const p = person(m, b.pid), c = p && m.ci[p.id];
        if (!c) fail(404, "They aren't checked in.");
        if (a === "leave") {
          if (c.left) fail(409, p.name + " already left.");
          c.left = now;
          addLog(m, now, by, p.name + " left" + (c.card ? "; voting card " + c.card + " returned" : ""));
        } else {
          if (!c.left) fail(409, p.name + " is in the room.");
          c.left = null;
          addLog(m, now, by, p.name + " came back in" + (c.card ? "; voting card " + c.card + " out again" : ""));
        }
        return { name: p.name, card: c.card };
      }));
    }
    case "call":
    case "declare":
    case "reopen":
    case "paper":
    case "digital": {
      need(dev, CAN.chair);
      return ok(await mutate(store, m => {
        if (a === "call") {
          if (m.calledAt) fail(409, "The meeting was already called to order.");
          m.calledAt = now;
          addLog(m, now, "Chair", "Called the meeting to order");
        } else if (a === "declare") {
          const q = quorum(m);
          if (!m.calledAt) fail(409, "Call the meeting to order first.");
          if (m.quorumAt) fail(409, "Quorum was already declared.");
          if (!q.met) fail(409, "Not at quorum yet: " + q.here + " present, " + q.need + " needed.");
          const close = "close" in b ? !!b.close : m.config.closeAtQuorum !== false;
          m.quorumAt = now;
          if (close) m.closedAt = now;
          addLog(m, now, "Chair", "Declared quorum: " + q.here + " present, " + q.need + " needed. " + (close ? "Check-in closed (4.7.4.B)" : "Check-in stays open by the Chair's order (4.7.4.B)"));
        } else if (a === "reopen") {
          if (!m.closedAt) fail(409, "Check-in is already open.");
          m.closedAt = null;
          addLog(m, now, "Chair", "Reopened check-in (4.7.4.B)");
        } else if (a === "paper") {
          if (m.paperAt) fail(409, "Paper sign-in is already in effect.");
          m.paperAt = now;
          addLog(m, now, "Chair", "Ordered paper sign-in (4.7.6)");
        } else {
          if (!m.paperAt) fail(409, "Digital check-in is already in use.");
          m.paperAt = null;
          addLog(m, now, "Chair", "Returned to digital check-in; paper sheets to be added by the Secretary");
        }
        return {};
      }));
    }
    /* ----- District Chairs ----- */
    case "inactive": {
      need(dev, CAN.district);
      return ok(await mutate(store, m => {
        const p = person(m, b.pid);
        if (!p) fail(404, "That person isn't on the roster.");
        if (dev.role === "ld" && p.ld !== dev.ld) fail(403, "Only LD " + p.ld + "'s District Chair can change that.");
        if (!PCO_KINDS.includes(p.kind)) fail(400, "Only PCOs can be marked inactive (2.6).");
        if (present(m, p.id)) fail(409, p.name + " is in the room. Change their status after the meeting.");
        p.inactive = !!b.on;
        addLog(m, now, dev.role === "ld" ? "District Chair, LD " + dev.ld : "Admin", (p.inactive ? "Marked " + p.name + " inactive" : "Marked " + p.name + " active again") + " (2.6)");
        return { name: p.name, inactive: p.inactive };
      }));
    }
    /* ----- the admin page ----- */
    case "setup": {
      need(dev, CAN.admin);
      const name = cleanText(b.name || "Central Committee meeting", 2, 80, "Meeting name");
      const date = cleanDate(b.date || todayIn(env.TIMEZONE || "America/Los_Angeles"), "Meeting");
      const config = { name, date, closeAtQuorum: true };
      const roster = b.sample ? sampleRoster(date, () => randId(6)) : { people: [], samples: null };
      const m = newMeeting(config, roster.people, roster.samples, now, "Admin");
      const r = await cas(store, "meeting", () => m);
      return json(200, { ok: true, etag: r.etag });
    }
    case "restart": {
      need(dev, CAN.admin);
      const r = await cas(store, "meeting", m => {
        if (!m) fail(409, "No meeting is set up yet.");
        return newMeeting(m.config, m.people, m.samples, now, "Admin");
      });
      return json(200, { ok: true, etag: r.etag });
    }
    case "settings": {
      need(dev, CAN.admin);
      return ok(await mutate(store, m => {
        const before = { ...m.config };
        if ("name" in b) m.config.name = cleanText(b.name, 2, 80, "Meeting name");
        if ("date" in b) m.config.date = cleanDate(b.date, "Meeting");
        if ("closeAtQuorum" in b) m.config.closeAtQuorum = !!b.closeAtQuorum;
        const changes = [];
        if (before.name !== m.config.name) changes.push("name to " + m.config.name);
        if (before.date !== m.config.date) changes.push("date to " + fmtDate(m.config.date));
        if (before.closeAtQuorum !== m.config.closeAtQuorum) changes.push(m.config.closeAtQuorum ? "check-in to close at quorum" : "check-in to stay open after quorum");
        if (changes.length) addLog(m, now, "Admin", "Changed the meeting's " + changes.join(", "));
        return {};
      }));
    }
    case "person-add": {
      need(dev, CAN.admin);
      const p = cleanPerson(b.person || {}, null);
      p.id = randId(6);
      const r = await mutate(store, m => {
        m.people.push(p);
        addLog(m, now, "Admin", "Added " + p.name + " (" + p.pct + ", " + KIND[p.kind] + ") to the roster");
        return { person: pubPerson(p) };
      });
      return ok(r, { token: credToken(secret, p) });
    }
    case "person-edit": {
      need(dev, CAN.admin);
      return ok(await mutate(store, m => {
        const p = person(m, b.pid);
        if (!p) fail(404, "That person isn't on the roster.");
        const next = cleanPerson(b.changes || {}, p);
        const said = [];
        if (next.dues !== p.dues) said.push(next.dues ? "dues paid" : "dues not on record");
        if (next.inactive !== p.inactive) said.push(next.inactive ? "inactive" : "active");
        if (next.name !== p.name || next.pct !== p.pct || next.ld !== p.ld || next.kind !== p.kind || next.office !== p.office || next.appt !== p.appt) said.push("details updated");
        if (next.missed2 !== p.missed2 || next.missedAny !== p.missedAny) said.push("attendance updated");
        Object.assign(p, next);
        if (said.length) addLog(m, now, "Admin", p.name + ": " + said.join(", "));
        return { person: pubPerson(p) };
      }));
    }
    case "credential":
    case "reissue-credential": {
      need(dev, CAN.admin);
      if (a === "credential") {
        const m = await store.get("meeting", { type: "json" });
        const p = m && person(m, b.pid);
        if (!p) fail(404, "That person isn't on the roster.");
        return json(200, { ok: true, token: credToken(secret, p), person: pubPerson(p) });
      }
      let token;
      const r = await mutate(store, m => {
        const p = person(m, b.pid);
        if (!p) fail(404, "That person isn't on the roster.");
        p.ver++;
        token = credToken(secret, p);
        addLog(m, now, "Admin", "Reissued " + p.name + "'s credential (version " + p.ver + "); older ones no longer work");
        return { person: pubPerson(p) };
      });
      return ok(r, { token });
    }
    case "test-fill": {
      // For trying the system with a couple of phones: checks in sample people who can vote,
      // leaving the six sample cases alone so they can still be scanned.
      need(dev, CAN.admin);
      const n = Math.max(1, Math.min(200, Math.floor(Number(b.n) || 0)));
      return ok(await mutate(store, m => {
        if (!m.samples) fail(409, "Test check-ins only work with the sample roster of fictional people.");
        const w = windowState(m);
        if (!w.open) fail(409, w.text);
        const keep = new Set(Object.values(m.samples));
        const pool = m.people.filter(p => !m.ci[p.id] && !keep.has(p.id) && judge(p, m.config.date, m.rulings[p.id]).cls !== "rule");
        for (let i = pool.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [pool[i], pool[j]] = [pool[j], pool[i]]; }
        const picked = pool.slice(0, n);
        picked.forEach((p, i) => doCheckin(m, p, "Test check-in", "name", now + i));
        return { added: picked.length };
      }));
    }
    case "device-add": {
      need(dev, CAN.admin);
      const role = String(b.role || "");
      if (!["door", "saa", "chair", "ld"].includes(role)) fail(400, "Pick a role for the device.");
      const ld = role === "ld" ? Number(b.ld) : null;
      if (role === "ld" && (!Number.isInteger(ld) || ld < 1 || ld > 49)) fail(400, "A District Chair device needs its district number.");
      const label = cleanText(b.label || (role === "ld" ? "District Chair, LD " + ld : ROLE_NAMES[role]), 2, 40, "Device name");
      const d = { id: randId(8), role, label, ld, created: now };
      await addDevice(store, d);
      return json(200, { ok: true, token: deviceToken(secret, d), device: pubDevice(d) });
    }
    case "device-revoke": {
      need(dev, CAN.admin);
      let found = false;
      await cas(store, "devices", data => {
        const list = (data && data.list) || [];
        const d = list.find(x => x.id === String(b.id || ""));
        if (!d) return undefined;
        found = true;
        d.revoked = now;
        return { list };
      });
      if (!found) fail(404, "That device isn't on the list.");
      return json(200, { ok: true });
    }
    default:
      fail(400, "Unknown action.");
  }
}

/* ---------- the official roll and the log, as CSV ---------- */
function csvCell(v) {
  let s = v == null ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // keep spreadsheets from running it as a formula
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
const csvRow = cells => cells.map(csvCell).join(",");
async function exportCsv(store, env, url) {
  const m = await store.get("meeting", { type: "json" });
  if (!m) fail(409, "No meeting is set up yet.");
  const tz = env.TIMEZONE || "America/Los_Angeles";
  const time = t => (t ? new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit", second: "2-digit" }).format(t) : "");
  const what = url.searchParams.get("what") === "log" ? "log" : "roll";
  const rows = [];
  if (what === "roll") {
    rows.push(csvRow(["Name", "Precinct", "LD", "Role", "Office", "Can vote", "Checked in", "By", "How", "Voting card", "Left"]));
    const ins = m.people.filter(p => m.ci[p.id]).sort((a, b) => m.ci[a.id].t - m.ci[b.id].t);
    for (const p of ins) {
      const c = m.ci[p.id], j = judge(p, m.config.date, m.rulings[p.id]);
      rows.push(csvRow([p.name, p.pct, p.ld, KIND[p.kind], p.office, j.cls === "vote" ? "yes" : j.cls === "rule" ? "pending ruling" : "no", time(c.t), c.by, HOW[c.how] || c.how, c.card || "", time(c.left)]));
    }
    for (const g of m.guests) rows.push(csvRow([g.name, "", "", "Guest", "", "no", time(g.t), g.by, "guest list", "", ""]));
    rows.push("");
  } else {
    rows.push(csvRow(["#", "Time", "By", "What", "Fingerprint"]));
    for (const e of m.log) rows.push(csvRow([e.n, time(e.t), e.who, e.what, e.h]));
    rows.push("");
  }
  const last = m.log.length ? m.log[m.log.length - 1].h : ZERO;
  rows.push(csvRow(["Meeting", m.config.name]));
  rows.push(csvRow(["Date", fmtDate(m.config.date)]));
  rows.push(csvRow(["Log entries", m.log.length]));
  rows.push(csvRow(["Log fingerprint", last]));
  const file = (what === "roll" ? "roll-" : "log-") + m.config.date + ".csv";
  return new Response("﻿" + rows.join("\r\n") + "\r\n", {
    status: 200,
    headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="' + file + '"', "cache-control": "no-store" }
  });
}
