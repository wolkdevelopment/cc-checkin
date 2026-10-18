/* The door (/door): scan each PCO's code, see the answer full-screen, check them in with one tap. */
import { api, act, esc, time, poller, toast, getToken, header, h } from "../lib.js";
import { judge, quorum, windowState, KIND } from "../rules.js";
import { createScanner } from "../camera.js";

function notSetUp(root, title, body) {
  root.innerHTML = header() + '<main class="wrap narrow"><section class="card raise"><h2>' + esc(title) + "</h2><div class=\"muted\">" + body + "</div></section></main>";
}

export async function mount(root) {
  if (!getToken("device")) return notSetUp(root, "This phone isn't set up as a door yet.", "<p>On the admin page, scan the door's QR code with this phone's camera.</p>");
  let you;
  try { you = (await api("/api/whoami")).data.you; }
  catch (e) { return notSetUp(root, e.status === 401 ? "This phone was signed out." : "Can't reach the server.", "<p>" + esc(e.message) + "</p>"); }
  if (!["door", "saa", "admin"].includes(you.role)) return notSetUp(root, "This device is the " + you.roleName + ".", '<p><a class="btn primary" href="/board">Open the live board</a></p>');

  root.innerHTML =
    '<div class="door">' +
    '<div class="door-bar"><span class="live-dot off" id="dot" aria-hidden="true"></span><span class="label">' + esc(you.label) + '</span><span class="count num" id="count" aria-live="polite">…</span></div>' +
    '<div class="cam" id="cam"><video id="video" playsinline muted></video>' +
    '<div class="finder" id="finder" hidden></div><p class="cam-hint" id="hint" hidden>Point at the code on their phone</p>' +
    '<div class="cam-start" id="start"><p>Scan each PCO\'s code. The camera only reads codes; nothing is recorded.</p><button class="btn primary big" id="go" type="button" style="max-width:320px">Start scanning</button><p class="small" id="camerr" hidden></p></div></div>' +
    '<div class="door-banner" id="banner" hidden></div>' +
    '<div class="door-tools"><button class="btn" id="find" type="button">Find by name</button><button class="btn" id="guest" type="button">Add a guest</button></div>' +
    "</div>";
  const $ = s => root.querySelector(s);
  let meeting = null, etag = "", overlay = null, sheet = null, lastBad = { text: "", t: 0 };
  const scanner = createScanner($("#video"), onScan);

  const poll = poller(async () => {
    try {
      const r = await api("/api/live?etag=" + encodeURIComponent(etag));
      $("#dot").className = "live-dot";
      if (r.status === 204) return;
      if (r.data.none) { meeting = null; $("#count").textContent = "No meeting set up"; return; }
      meeting = r.data.meeting; etag = r.data.etag;
      const q = quorum(meeting), w = windowState(meeting);
      $("#count").innerHTML = "<b>" + q.here + "</b> voting present<br>" + q.need + " needed";
      $("#banner").hidden = w.open;
      $("#banner").textContent = w.text;
    } catch (e) {
      $("#dot").className = "live-dot off";
      if (e.status === 401) { scanner.stop(); notSetUp(root, "This phone was signed out.", "<p>Ask the Secretary for a new door link.</p>"); poll.stop(); return; }
      throw e;
    }
  }, 4000);
  poll.start();

  $("#go").addEventListener("click", async () => {
    $("#go").disabled = true;
    try {
      await scanner.start();
      $("#start").hidden = true; $("#finder").hidden = false; $("#hint").hidden = false;
    } catch (e) {
      $("#camerr").hidden = false; $("#camerr").textContent = e.message;
      $("#go").disabled = false;
    }
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") scanner.pause();
    else if (scanner.on && !overlay && !sheet) scanner.resume().catch(e => toast(e.message, "bad"));
  });
  document.addEventListener("keydown", e => { if (e.key === "Escape") { if (sheet) sheet.close(); else if (overlay) closeOverlay(); } });

  function resume() { if (scanner.on && !overlay && !sheet) scanner.resume().catch(e => toast(e.message, "bad")); }
  function closeOverlay() { if (overlay) { overlay.remove(); overlay = null; } setTimeout(resume, 350); }
  function showOverlay(el) { if (overlay) overlay.remove(); overlay = el; document.body.appendChild(el); const b = el.querySelector(".btn.solid, .btn"); if (b) b.focus(); }

  async function onScan(raw) {
    let text = String(raw || "").trim();
    const at = text.indexOf("#CC1.");
    if (at >= 0) text = decodeURIComponent(text.slice(at + 1));
    if (!/^CC1\./.test(text)) {
      if (text !== lastBad.text || Date.now() - lastBad.t > 3000) toast("That isn't a check-in code.", "bad");
      lastBad = { text, t: Date.now() };
      setTimeout(resume, 900);
      return;
    }
    if (navigator.vibrate) navigator.vibrate(35);
    showOverlay(h('<div class="verdict"><div class="verdict-body"><p class="kicker">Checking</p><p class="headline">…</p></div></div>'));
    try {
      const v = (await api("/api/scan", { method: "POST", body: { text } })).data;
      showVerdict(v, "scan");
    } catch (e) { closeOverlay(); toast(e.message, "bad"); }
  }

  function personLine(p) { return esc(p.kindName) + (p.office ? " (" + esc(p.office) + ")" : "") + " · " + esc(p.pct) + " · LD " + p.ld; }
  function showVerdict(v, how) {
    const p = v.person || v.claims || null;
    const closed = v.window && !v.window.open;
    let cls, kicker, headline, sub = "", acts = [];
    const doCheckin = () => checkin(p, how, v.ver);
    switch (v.kind) {
      case "vote": cls = "vote"; kicker = "Voting member"; headline = "Hand card " + v.card; acts = [["solid", "Check in · card " + v.card, doCheckin, closed]]; break;
      case "non": cls = "non"; kicker = "Can't vote"; headline = "Badge only"; acts = [["solid", "Check in with a badge", doCheckin, closed]]; break;
      case "rule": cls = "rule"; kicker = "Needs a ruling"; headline = "Sergeant-at-Arms"; sub = "Send them to the Sergeant-at-Arms desk to settle it."; acts = [["solid", "Send to the Sergeant-at-Arms", () => ask(p, "dues")], ["", "Check in now, card after a ruling", doCheckin, closed]]; break;
      case "back": cls = "vote"; kicker = "Back in the room"; headline = v.card ? "Card " + v.card : "Welcome back"; sub = v.card ? "Their voting card goes back out." : ""; acts = [["solid", "Let them back in", doCheckin]]; break;
      case "dup": cls = "stop"; kicker = "Already checked in"; headline = "Don't admit"; sub = "Checked in at " + time(v.checkin.t) + " by " + v.checkin.by + (v.checkin.card ? ", card " + v.checkin.card : "") + ". If this isn't them, someone may be using their code."; acts = [["solid", "Send to the Sergeant-at-Arms", () => ask(p, "dup")]]; break;
      case "forged": cls = "stop"; kicker = "Code doesn't check out"; headline = "Don't admit"; sub = p ? "It was changed after it was issued." : "It was altered or made up."; acts = [["solid", "Send to the Sergeant-at-Arms", () => ask(p, "forged")]]; break;
      case "old": cls = "stop"; kicker = "Old code"; headline = "Don't admit"; sub = "This code was replaced. The Sergeant-at-Arms can check their ID."; acts = [["solid", "Send to the Sergeant-at-Arms", () => ask(p, "old")]]; break;
      case "unknown": cls = "stop"; kicker = "Not on the roster"; headline = "Don't admit"; sub = "This code isn't for anyone on tonight's roster."; acts = [["solid", "Send to the Sergeant-at-Arms", () => ask(null, "unknown")]]; break;
      default: closeOverlay(); toast("That isn't a check-in code.", "bad"); return;
    }
    const admitting = ["vote", "non", "rule", "back"].includes(v.kind);
    const el = h('<div class="verdict ' + cls + '" role="dialog" aria-modal="true" aria-label="' + esc(kicker) + '">' +
      '<div class="verdict-body"><p class="kicker">' + esc(kicker) + '</p><p class="headline">' + esc(headline) + "</p>" + (sub ? '<p class="sub">' + esc(sub) + "</p>" : "") +
      (p ? '<div class="who-box">' + (v.kind === "forged" ? '<span class="small">Claims to be</span>' : "") + "<b>" + esc(p.name) + "</b><span>" + personLine(p) + "</span></div>" : "") +
      (v.why ? '<ul class="why">' + v.why.map(x => '<li><span class="' + (x.ok ? "y" : "n") + '" aria-hidden="true">' + (x.ok ? "✓" : "✕") + "</span><span>" + esc(x.text) + '</span><span class="cite">' + esc(x.cite) + "</span></li>").join("") + "</ul>" : "") +
      (closed && admitting && v.kind !== "back" ? '<p class="who-box"><b>' + esc(v.window.text) + "</b></p>" : "") +
      "</div>" +
      '<div class="verdict-actions">' + (admitting ? '<p class="confirm">' + (how === "name" ? "No code: check their ID first." : "Confirm it's them.") + "</p>" : "") + "</div></div>");
    const box = el.querySelector(".verdict-actions");
    for (const [kind, label, fn, disabled] of acts) {
      const b = h('<button type="button" class="btn big ' + kind + '">' + esc(label) + "</button>");
      b.disabled = !!disabled;
      b.addEventListener("click", async () => {
        box.querySelectorAll("button").forEach(x => { x.disabled = true; });
        try { await fn(); } catch (e) { toast(e.message, "bad"); box.querySelectorAll("button").forEach(x => { x.disabled = false; }); }
      });
      box.appendChild(b);
    }
    const cancel = h('<button type="button" class="btn big">' + (admitting ? "Cancel" : "Scan the next person") + "</button>");
    cancel.addEventListener("click", closeOverlay);
    box.appendChild(cancel);
    showOverlay(el);
  }

  async function checkin(p, how, ver) {
    const r = (await act({ a: "checkin", pid: p.id, how, ver })).data;
    if (navigator.vibrate) navigator.vibrate([30, 40, 30]);
    showOverlay(h('<div class="verdict vote done" role="status"><div><div class="big-check" aria-hidden="true">✓</div>' +
      '<p class="headline">' + (r.back ? "Back in" : "Checked in") + '</p><p class="sub">' + esc(r.name) + "</p><p class=\"sub\">" + (r.card ? "Voting card " + r.card : "Name badge") + "</p></div></div>"));
    poll.now();
    setTimeout(closeOverlay, 1400);
  }
  async function ask(p, issue) {
    await act({ a: "ask", pid: p && p.id, issue, claims: p ? p.name : undefined });
    showOverlay(h('<div class="verdict rule done" role="status"><div><p class="kicker">Sent</p><p class="headline">Sergeant-at-Arms</p><p class="sub">' + (p ? esc(p.name) + " is waiting at their desk." : "They're waiting at the desk.") + "</p></div></div>"));
    poll.now();
    setTimeout(closeOverlay, 1500);
  }

  function openSheet(html, onClose) {
    scanner.pause();
    const el = h('<div class="sheet"><div class="sheet-in" role="dialog" aria-modal="true">' + html + "</div></div>");
    const close = () => { el.remove(); sheet = null; if (onClose) onClose(); resume(); };
    el.addEventListener("click", e => { if (e.target === el || e.target.closest("[data-close]")) close(); });
    document.body.appendChild(el);
    sheet = { el, close };
    return sheet;
  }
  function localVerdict(p) {
    const c = meeting.ci[p.id], j = judge(p, meeting.config.date, meeting.rulings[p.id]);
    const pub = { id: p.id, name: p.name, pct: p.pct, ld: p.ld, kind: p.kind, kindName: KIND[p.kind], office: p.office };
    const window = windowState(meeting);
    if (c && !c.left) return { kind: "dup", person: pub, checkin: c, window };
    if (c && c.left) return { kind: "back", person: pub, why: j.why, card: c.card, window };
    return { kind: j.cls, person: pub, why: j.why, card: j.cls === "vote" ? meeting.cards : null, window };
  }
  $("#find").addEventListener("click", () => {
    if (!meeting) { toast("Still loading the roster. Try again in a moment.", "bad"); return; }
    const s = openSheet('<div class="card-head"><h2>Find by name</h2><button class="btn slim" type="button" data-close>Close</button></div>' +
      '<div class="field"><label for="q">Name or precinct</label><input id="q" autocomplete="off" autocapitalize="words" placeholder="For example, Rhodes or 27-101" enterkeyhint="search"></div><div class="list" id="res"></div>');
    const input = s.el.querySelector("#q"), res = s.el.querySelector("#res");
    input.focus();
    input.addEventListener("input", () => {
      const q = input.value.trim().toLowerCase();
      if (q.length < 2) { res.innerHTML = ""; return; }
      const hits = meeting.people.filter(p => p.name.toLowerCase().includes(q) || p.pct.toLowerCase().includes(q)).slice(0, 8);
      res.innerHTML = hits.length ? hits.map(p => {
        const c = meeting.ci[p.id], j = judge(p, meeting.config.date, meeting.rulings[p.id]);
        const pill = c && !c.left ? '<span class="pill vote">Here</span>' : j.cls === "vote" ? '<span class="pill">Can vote</span>' : j.cls === "rule" ? '<span class="pill rule">Ruling</span>' : '<span class="pill non">No vote</span>';
        return '<button type="button" class="item pick" data-id="' + p.id + '" style="width:100%;border-left:0;border-right:0;border-bottom:0;background:none;text-align:left"><span class="main"><b>' + esc(p.name) + "</b><span>" + esc(KIND[p.kind]) + " · " + esc(p.pct) + " · LD " + p.ld + "</span></span>" + pill + "</button>";
      }).join("") : '<p class="muted">No one matches.</p>';
    });
    res.addEventListener("click", e => {
      const b = e.target.closest("[data-id]");
      if (!b) return;
      const p = meeting.people.find(x => x.id === b.dataset.id);
      s.close();
      showVerdict(localVerdict(p), "name");
    });
  });
  $("#guest").addEventListener("click", () => {
    const s = openSheet('<div class="card-head"><h2>Add a guest</h2><button class="btn slim" type="button" data-close>Close</button></div>' +
      '<p class="muted small">Guests sign the guest list (SR J.3). They get no badge and no vote.</p>' +
      '<div class="field"><label for="gname">Guest\'s name</label><input id="gname" autocomplete="off" autocapitalize="words"></div>' +
      '<button class="btn primary big" type="button" id="gsave">Add to the guest list</button>');
    const input = s.el.querySelector("#gname"), save = s.el.querySelector("#gsave");
    input.focus();
    const go = async () => {
      save.disabled = true;
      try { await act({ a: "guest", name: input.value }); toast(input.value.trim() + " is on the guest list."); s.close(); poll.now(); }
      catch (e) { toast(e.message, "bad"); save.disabled = false; }
    };
    save.addEventListener("click", go);
    input.addEventListener("keydown", e => { if (e.key === "Enter") go(); });
  });
}
