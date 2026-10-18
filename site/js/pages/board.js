/* The live board (/board): quorum, the Chair's controls, questions for the Sergeant-at-Arms,
   arrivals as they happen, every district, and the log. What shows depends on the device's role. */
import { api, act, esc, time, plural, poller, toast, getToken, header, h, busy } from "../lib.js";
import { judge, quorum, windowState, districts, present, KIND, PCO_KINDS, fmtDate } from "../rules.js";

const ISSUE = { dues: "Dues not on record", dup: "Code used twice", forged: "Altered code", old: "Old code", unknown: "Not on the roster" };

function blocked(root, title, body) {
  root.innerHTML = header() + '<main class="wrap narrow"><section class="card raise"><h2>' + esc(title) + '</h2><div class="muted">' + body + "</div></section></main>";
}

export async function mount(root) {
  if (!getToken("device")) return blocked(root, "This device isn't signed in.", "<p>Open the device link from the admin page.</p>");
  let you;
  try { you = (await api("/api/whoami")).data.you; }
  catch (e) { return blocked(root, e.status === 401 ? "This device was signed out." : "Can't reach the server.", "<p>" + esc(e.message) + "</p>"); }
  if (you.role === "door") { location.replace("/door"); return; }
  const role = you.role, isAdmin = role === "admin";
  const can = { chair: ["chair", "admin"].includes(role), saa: ["saa", "admin"].includes(role), log: true, ld: ["ld", "admin"].includes(role) };

  root.innerHTML = header('<span class="who" id="clock"></span><span class="pill acc">' + esc(you.label) + "</span>" + (isAdmin ? '<a class="btn slim" href="/admin">Admin page</a>' : "")) +
    '<main class="wrap stack">' +
    '<div class="row-flex"><div><h1 id="mname" style="font-size:1.35rem;font-weight:850;letter-spacing:-.01em">Live board</h1><p class="muted small" id="mdate"></p></div><span class="spacer"></span><span class="pill" id="window"></span><span class="who"><span class="live-dot off" id="dot"></span><span id="sync">Connecting…</span></span></div>' +
    '<div id="nomeeting" hidden class="card raise"><h2>No meeting is set up</h2><p class="muted">The Secretary sets one up on the admin page.</p></div>' +
    '<div class="grid lead" id="top"><section class="card raise" id="quorum"></section><section class="card" id="side"></section></div>' +
    '<section class="card" id="mine" hidden></section>' +
    '<div class="grid two"><div class="stack"><section class="card" id="queue"></section><section class="card" id="lds"></section>' +
    '<section class="card" id="floor"' + (can.saa ? "" : " hidden") + "></section></div>" +
    '<div class="stack"><section class="card" id="feed"></section><section class="card" id="log"></section></div></div>' +
    "</main>";
  const $ = s => root.querySelector(s);
  let m = null, etag = "", seen = null, myLd = role === "ld" ? you.ld : null, chainNote = "", closeChoice = null;

  const tickClock = () => { $("#clock").textContent = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); };
  tickClock();
  setInterval(tickClock, 15000);

  // The floor's search box keeps its text between updates, so it's built once.
  if (can.saa) {
    $("#floor").innerHTML = '<div class="card-head"><h3>Someone leaving? Take their card back</h3></div><div class="field"><label for="fq">Name or precinct</label><input id="fq" autocomplete="off" placeholder="Search people in the room"></div><div class="list" id="fout"></div>';
    $("#fq").addEventListener("input", renderFloor);
    $("#fout").addEventListener("click", e => {
      const b = e.target.closest("[data-floor]");
      if (!b) return;
      busy(b, async () => { const r = (await act({ a: b.dataset.floor, pid: b.dataset.id })).data; toast(b.dataset.floor === "leave" ? r.name + (r.card ? " handed back card " + r.card : " left") + "." : r.name + " is back in."); await poll.now(); })();
    });
  }

  const poll = poller(async () => {
    try {
      const r = await api("/api/live?etag=" + encodeURIComponent(etag));
      $("#dot").className = "live-dot";
      $("#sync").textContent = "Live";
      if (r.status === 204) return;
      if (r.data.none) { $("#nomeeting").hidden = false; $("#top").hidden = true; return; }
      $("#nomeeting").hidden = true; $("#top").hidden = false;
      m = r.data.meeting; etag = r.data.etag;
      render();
    } catch (e) {
      $("#dot").className = "live-dot off";
      $("#sync").textContent = e.status === 401 ? "Signed out" : "Reconnecting…";
      if (e.status === 401) { poll.stop(); toast("This device was signed out.", "bad"); return; }
      throw e;
    }
  }, 2000);
  poll.start();

  function render() {
    $("#mname").textContent = m.config.name;
    $("#mdate").textContent = fmtDate(m.config.date) + (m.calledAt ? " · Called to order " + time(m.calledAt) : "");
    const w = windowState(m);
    $("#window").className = "pill " + (w.open ? "vote" : "stop");
    $("#window").textContent = w.open ? "Check-in open" : w.why === "paper" ? "Paper sign-in" : "Check-in closed";
    renderQuorum(); renderSide(); renderMine(); renderQueue(); renderFeed(); renderLds(); if (can.saa) renderFloor(); renderLog();
  }

  function renderQuorum() {
    const q = quorum(m), max = Math.max(q.base, 1);
    const pct = Math.min(100, (q.here / max) * 100), mark = Math.min(100, (q.need / max) * 100);
    $("#quorum").className = "card raise score" + (q.met ? " met" : "");
    $("#quorum").innerHTML =
      '<div class="card-head"><h3>Quorum</h3>' + (q.met ? '<span class="pill vote">Reached' + (m.reachedAt ? " " + time(m.reachedAt) : "") + "</span>" : '<span class="pill">' + plural(q.need - q.here, "more needed", "more needed") + "</span>") + "</div>" +
      '<div class="big" aria-live="polite">' + q.here + " <small>present · " + q.need + " needed</small></div>" +
      '<div class="meter" aria-hidden="true"><i style="width:' + pct + '%"></i><u style="left:' + mark + '%"></u></div>' +
      '<p class="small muted">45% of ' + q.base + ": the " + q.pool + " who can vote, less " + q.chronic + " absent who missed both earlier meetings (4.4.1).</p>" +
      '<div class="kpis"><div class="kpi"><b>' + Object.keys(m.ci).length + "</b><span>checked in</span></div><div class=\"kpi\"><b>" + Object.values(m.ci).filter(c => c.card && !c.left).length + '</b><span>voting cards in the room</span></div><div class="kpi"><b>' + m.guests.length + "</b><span>guests</span></div></div>";
  }

  function renderSide() {
    const q = quorum(m), side = $("#side");
    if (!can.chair) {
      side.innerHTML = "<h3>The meeting</h3>" +
        '<p>' + (m.calledAt ? "Called to order at " + time(m.calledAt) + "." : "Not called to order yet.") + "</p>" +
        "<p>" + (m.quorumAt ? "The Chair declared quorum at " + time(m.quorumAt) + "." : q.met ? "Quorum is reached. The Chair sees it on this board (5.4.6)." : "Waiting for quorum.") + "</p>";
      return;
    }
    let html = '<div class="card-head"><h3>Chair</h3></div>';
    if (!m.calledAt) html += '<button class="btn primary big" data-chair="call" type="button">Call the meeting to order</button>';
    else if (!m.quorumAt) {
      const closeOn = closeChoice == null ? m.config.closeAtQuorum !== false : closeChoice;
      html += '<label class="check"><input type="checkbox" id="closeq"' + (closeOn ? " checked" : "") + "> Close check-in when I declare quorum (4.7.4.B)</label>" +
        '<button class="btn go big" data-chair="declare" type="button"' + (q.met ? "" : " disabled") + ">Declare quorum</button>" +
        (q.met ? "" : '<p class="small muted">' + plural(q.need - q.here, "more voting member", "more voting members") + " needed.</p>");
    } else html += '<p class="note vote">You declared quorum at ' + time(m.quorumAt) + ".</p>";
    if (m.closedAt && !m.paperAt) html += '<button class="btn" data-chair="reopen" type="button">Reopen check-in for late arrivals</button>';
    html += '<p class="small muted">If the system fails, order paper sign-in. Paper prevails (4.7.6).</p>' +
      (m.paperAt ? '<button class="btn" data-chair="digital" type="button">Return to digital check-in</button>' : '<button class="btn warn" data-chair="paper" type="button">Order paper sign-in</button>');
    side.innerHTML = html;
    const cq = side.querySelector("#closeq");
    if (cq) cq.addEventListener("change", () => { closeChoice = cq.checked; });
    side.querySelectorAll("[data-chair]").forEach(b => b.addEventListener("click", busy(b, async () => {
      const a = b.dataset.chair, body = { a };
      if (a === "declare") body.close = $("#closeq").checked;
      await act(body);
      toast({ call: "Called to order.", declare: "Quorum declared.", reopen: "Check-in reopened.", paper: "Paper sign-in ordered.", digital: "Back to digital check-in." }[a]);
      await poll.now();
    })));
  }

  function renderQueue() {
    const box = $("#queue");
    const items = m.queue.filter(x => (x.stage === "chair" ? can.chair || can.saa : can.saa || can.chair));
    let html = '<div class="card-head"><h3>Needs a ruling</h3><span class="pill ' + (items.length ? "rule" : "") + '">' + items.length + "</span></div>";
    if (!items.length) html += '<p class="muted">Nothing waiting. Questions from the door show up here.</p>';
    else html += '<div class="list">' + items.map(x => {
      const p = x.pid && m.people.find(y => y.id === x.pid);
      const name = p ? p.name : x.claims || "Someone";
      const inRoom = p && present(m, p.id);
      let acts = [];
      if (x.stage === "chair") acts = can.chair ? [["allow", "Can vote", "go"], ["deny", "Can't vote", ""]] : [];
      else if (can.saa) {
        if (x.issue === "dues") acts = [["paid", "Paid at the door", "go"], ["novote", "Can't vote today", ""], ["tochair", "Send to the Chair", ""]];
        else if (x.issue === "dup") acts = [["dismiss", "Same person, no action", ""], ["reissue", "Someone else used it: reissue", "warn"]];
        else if (x.issue === "forged") acts = p ? [["admit", "ID checks out: admit and reissue", "go"], ["turnaway", "Turn away", "warn"]] : [["turnaway", "Turn away", "warn"]];
        else if (x.issue === "old") acts = [["admit", "ID checks out: admit", "go"], ["turnaway", "Turn away", "warn"]];
        else acts = [["turnaway", "Turn away", "warn"]];
      }
      return '<div class="item"><div class="main"><b>' + esc(name) + "</b><span>" + esc(ISSUE[x.issue]) + (p ? " · " + esc(p.pct) : "") + " · " + time(x.t) + " · from " + esc(x.by) + (x.stage === "chair" ? " · with the Chair" : "") + (inRoom ? " · in the room, no card yet" : "") + "</span></div>" +
        '<div class="row-flex">' + acts.map(([a, label, kind]) => '<button class="btn slim ' + kind + '" type="button" data-q="' + x.q + '" data-act="' + a + '">' + esc(label) + "</button>").join("") + "</div></div>";
    }).join("") + "</div>";
    box.innerHTML = html;
    box.querySelectorAll("[data-act]").forEach(b => b.addEventListener("click", busy(b, async () => {
      const r = (await act({ a: "resolve", q: Number(b.dataset.q), action: b.dataset.act })).data;
      toast(r.card ? "Voting card " + r.card + " to " + r.name + "." : "Done.");
      await poll.now();
    })));
  }

  function renderFeed() {
    const ins = Object.entries(m.ci).sort((a, b) => b[1].t - a[1].t).slice(0, 10);
    const first = seen === null;
    const html = '<div class="card-head"><h3>Arrivals</h3><span class="pill">' + Object.keys(m.ci).length + "</span></div>" +
      (ins.length ? '<div class="list feed">' + ins.map(([id, c]) => {
        const p = m.people.find(x => x.id === id);
        if (!p) return "";
        const fresh = !first && !seen.has(id + c.t);
        return '<div class="item' + (fresh ? " fresh" : "") + '"><span class="avatar" aria-hidden="true">' + esc(p.name.split(" ").map(s => s[0]).join("").slice(0, 2)) + '</span><div class="main"><b>' + esc(p.name) + "</b><span>" + esc(p.pct) + " · " + time(c.t) + " · " + esc(c.by) + "</span></div>" +
          (c.left ? '<span class="pill">Left</span>' : c.card ? '<span class="pill vote">Card ' + c.card + "</span>" : '<span class="pill non">Badge</span>') + "</div>";
      }).join("") + "</div>" : '<p class="muted">No one yet. Arrivals show up here as the door scans them.</p>');
    $("#feed").innerHTML = html;
    seen = new Set(Object.entries(m.ci).map(([id, c]) => id + c.t));
  }

  function renderLds() {
    const tiles = districts(m).map(ld => {
      const q = quorum(m, ld), pct = q.need ? Math.min(100, (q.here / q.need) * 100) : 0;
      return '<button type="button" class="ld-tile' + (q.met ? " met" : "") + '" data-ld="' + ld + '" style="text-align:left;cursor:pointer;font:inherit;color:inherit"><b>LD ' + ld + '</b><span class="num">' + q.here + " here · " + q.need + " needed" + (q.met ? " ✓" : "") + '</span><span class="bar"><i style="width:' + pct + '%"></i></span></button>';
    }).join("");
    $("#lds").innerHTML = '<div class="card-head"><h3>Caucus quorum by district</h3><span class="small muted">Tap a district to see who\'s there (SR J.3)</span></div><div class="ld-tiles">' + tiles + "</div>";
    $("#lds").querySelectorAll("[data-ld]").forEach(b => b.addEventListener("click", () => { myLd = Number(b.dataset.ld); renderMine(); $("#mine").scrollIntoView({ behavior: "smooth", block: "start" }); }));
  }

  function renderMine() {
    const box = $("#mine");
    if (myLd == null) { box.hidden = true; return; }
    box.hidden = false;
    const q = quorum(m, myLd), canEdit = isAdmin || (role === "ld" && you.ld === myLd);
    const people = m.people.filter(p => p.ld === myLd).sort((a, b) => (present(m, b.id) - present(m, a.id)) || a.pct.localeCompare(b.pct, undefined, { numeric: true }));
    box.innerHTML = '<div class="card-head"><h2>LD ' + myLd + " caucus</h2>" + (role !== "ld" ? '<button class="btn slim" type="button" id="closeld">Close</button>' : "") + "</div>" +
      '<div class="kpis"><div class="kpi"><b>' + q.here + '</b><span>here who can vote</span></div><div class="kpi"><b>' + q.base + '</b><span>counted for quorum</span></div><div class="kpi"><b>' + q.need + (q.met ? " ✓" : "") + "</b><span>caucus quorum</span></div></div>" +
      '<div class="scroll-x"><table><thead><tr><th>Precinct</th><th>Name</th><th>Status</th><th></th></tr></thead><tbody>' + people.map(p => {
        const c = m.ci[p.id], j = judge(p, m.config.date, m.rulings[p.id]);
        const st = c && !c.left ? (c.card ? '<span class="pill vote">Here · card ' + c.card + "</span>" : '<span class="pill non">Here · no vote</span>')
          : c && c.left ? '<span class="pill">Left ' + time(c.left) + "</span>"
          : j.cls === "vote" ? '<span class="pill">' + (p.missed2 ? "Absent · missed 2" : "Absent") + "</span>"
          : j.cls === "rule" ? '<span class="pill rule">Dues question</span>'
          : '<span class="pill non">' + esc(p.inactive ? "Inactive (2.6)" : KIND[p.kind]) + "</span>";
        const btn = canEdit && PCO_KINDS.includes(p.kind) && !present(m, p.id) ? '<button class="btn slim" type="button" data-inactive="' + p.id + '" data-on="' + (p.inactive ? "0" : "1") + '">' + (p.inactive ? "Mark active" : "Mark inactive") + "</button>" : "";
        return "<tr><td class=\"nowrap\">" + esc(p.pct) + "</td><td>" + esc(p.name) + (p.office ? ' <span class="muted small">' + esc(p.office) + "</span>" : "") + "</td><td>" + st + "</td><td>" + btn + "</td></tr>";
      }).join("") + "</tbody></table></div>" +
      '<p class="small muted">' + (canEdit ? "Inactive PCOs can't vote and aren't counted for quorum (2.6)." : "Only this district's District Chair can change who's inactive.") + "</p>";
    const close = box.querySelector("#closeld");
    if (close) close.addEventListener("click", () => { myLd = null; renderMine(); });
    box.querySelectorAll("[data-inactive]").forEach(b => b.addEventListener("click", busy(b, async () => {
      const r = (await act({ a: "inactive", pid: b.dataset.inactive, on: b.dataset.on === "1" })).data;
      toast(r.name + (r.inactive ? " is marked inactive." : " is active again."));
      await poll.now();
    })));
  }

  function renderFloor() {
    const out = $("#fout"), q = $("#fq").value.trim().toLowerCase();
    if (!m || q.length < 2) { out.innerHTML = '<p class="small muted">Cards coming back keep the count of who\'s present true for votes.</p>'; return; }
    const hits = m.people.filter(p => m.ci[p.id] && (p.name.toLowerCase().includes(q) || p.pct.toLowerCase().includes(q))).slice(0, 6);
    out.innerHTML = hits.length ? hits.map(p => {
      const c = m.ci[p.id];
      return '<div class="item"><div class="main"><b>' + esc(p.name) + "</b><span>" + (c.card ? "Card " + c.card : "No card") + (c.left ? " · left " + time(c.left) : " · in the room") + "</span></div>" +
        '<button class="btn slim" type="button" data-floor="' + (c.left ? "back" : "leave") + '" data-id="' + p.id + '">' + (c.left ? "Back in the room" : "Card back") + "</button></div>";
    }).join("") : '<p class="muted small">No one checked in matches.</p>';
  }

  function renderLog() {
    const box = $("#log");
    box.innerHTML = '<div class="card-head"><h3>Log</h3><span class="pill">' + m.logLen + " entries</span></div>" +
      '<p class="small muted">The auditable record (4.7.2). Each entry carries a fingerprint of the one before it, so a changed entry shows up.</p>' +
      '<div class="row-flex"><button class="btn slim" type="button" id="verify">Check the log</button>' + (isAdmin ? '<a class="btn slim" href="/admin#records">Download</a>' : "") + "</div>" + chainNote +
      '<ol class="log">' + m.logTail.slice().reverse().slice(0, 15).map(e => '<li><span class="meta"><span>#' + e.n + " · " + time(e.t) + " · " + esc(e.who) + "</span><span>" + e.h.slice(0, 8) + "</span></span><span>" + esc(e.what) + "</span></li>").join("") + "</ol>";
    const b = box.querySelector("#verify");
    b.addEventListener("click", busy(b, async () => {
      const log = (await api("/api/log")).data.log;
      const res = await verifyChain(log);
      chainNote = res.ok ? '<p class="note vote small">All ' + res.n + " entries check out.</p>" : '<p class="note stop small">Entry ' + res.at + " doesn't match its fingerprint. It was changed after it was written.</p>";
      renderLog();
    }));
  }
}

async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, "0")).join("");
}
export async function verifyChain(log) {
  let prev = "0".repeat(64);
  for (const e of log) {
    if ((await sha256(prev + "|" + e.n + "|" + e.t + "|" + e.who + "|" + e.what)) !== e.h) return { ok: false, at: e.n };
    prev = e.h;
  }
  return { ok: true, n: log.length };
}
