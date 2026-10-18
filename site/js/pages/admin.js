/* The Secretary's admin page (/admin): sign in, test with phones, people, devices, the meeting, records. */
import { api, act, esc, time, plural, toast, getToken, setToken, clearToken, header, h, busy, copyText, linkFor, confirmButton } from "../lib.js";
import { svg } from "../qr.js";
import { judge, quorum, windowState, KIND, PCO_KINDS, fmtDate } from "../rules.js";
import { verifyChain } from "./board.js";

const TABS = [["test", "Test with your phones"], ["people", "People"], ["devices", "Devices"], ["meeting", "Meeting"], ["records", "Records"]];
const SAMPLES = [["eligible", "Can vote"], ["officer", "CC officer"], ["appointed", "Appointed 41 days ago"], ["captain", "Precinct Captain"], ["dues", "Dues not on record"], ["inactive", "Inactive"]];
const ROLE_OPTS = [["door", "Door"], ["saa", "Sergeant-at-Arms"], ["chair", "Chair"], ["ld", "District Chair"]];
const STATUS = { vote: ["vote", "Can vote"], non: ["non", "Can't vote"], rule: ["rule", "Needs a ruling"] };

export async function mount(root) {
  let you = null;
  if (getToken("device")) {
    try { you = (await api("/api/whoami")).data.you; } catch (e) { if (e.status === 401) clearToken("device"); }
  }
  if (!you || you.role !== "admin") return signIn(root, you);

  root.innerHTML = header('<span class="pill acc">Admin</span><a class="btn slim" href="/board">Live board</a><a class="btn slim" href="/door">Door</a>') +
    '<main class="wrap stack"><div id="summary"></div><nav class="tabs" role="tablist" id="tabs"></nav><div id="panel"></div></main>';
  const $ = s => root.querySelector(s);
  let A = null, tab = (location.hash.slice(1) || "test"), picked = null, pickedToken = null, pq = "", tq = "", personOpen = null, newDevice = null;
  if (!TABS.some(t => t[0] === tab)) tab = "test";

  async function load() { A = (await api("/api/admin")).data; render(); }
  function render() {
    const m = A.meeting;
    $("#tabs").innerHTML = TABS.map(([k, label]) => '<button role="tab" type="button" data-tab="' + k + '" aria-selected="' + (k === tab) + '">' + label + "</button>").join("");
    $("#tabs").hidden = !m;
    if (!m) { $("#summary").innerHTML = ""; return renderSetup($("#panel"), true); }
    const q = quorum(m), w = windowState(m);
    $("#summary").innerHTML = '<div class="row-flex"><div><h1 style="font-size:1.35rem;font-weight:850">' + esc(m.config.name) + '</h1><p class="muted small">' + fmtDate(m.config.date) + " · " + plural(m.people.length, "person", "people") + " on the roster</p></div><span class=\"spacer\"></span>" +
      '<span class="pill ' + (w.open ? "vote" : "stop") + '">' + (w.open ? "Check-in open" : "Check-in closed") + '</span><span class="pill">' + q.here + " of " + q.need + " for quorum</span></div>";
    $("#panel").onclick = null;
    ({ test: renderTest, people: renderPeople, devices: renderDevices, meeting: renderMeeting, records: renderRecords })[tab]($("#panel"), m);
  }
  window.addEventListener("hashchange", () => {
    const t = location.hash.slice(1);
    if (A && TABS.some(x => x[0] === t) && t !== tab) { tab = t; render(); }
  });
  $("#tabs").addEventListener("click", e => {
    const b = e.target.closest("[data-tab]");
    if (!b) return;
    tab = b.dataset.tab;
    history.replaceState(null, "", "/admin#" + tab);
    render();
  });

  /* ----- test with your phones ----- */
  function renderTest(panel, m) {
    const door = A.devices.find(d => d.role === "door");
    panel.innerHTML =
      '<div class="grid three steps">' +
      '<section class="card step"><h2>Phone 1 shows a PCO\'s code</h2><p class="muted small">Pick a test person, then scan this code with Phone 1\'s camera app and open the link.</p>' +
      (m.samples ? '<div class="chips" id="presets">' + SAMPLES.map(([k, label]) => '<button type="button" class="chip" data-sample="' + k + '" aria-pressed="' + (picked === m.samples[k]) + '">' + label + "</button>").join("") + "</div>" : "") +
      '<div class="field"><label for="tq">' + (m.samples ? "Or find anyone" : "Find a person") + '</label><input id="tq" autocomplete="off" placeholder="Name or precinct"></div><div class="list" id="tres"></div>' +
      '<div id="tcred"></div></section>' +
      '<section class="card step"><h2>Phone 2 is the door</h2><p class="muted small">Scan this with Phone 2\'s camera, open the link, then tap <b>Start scanning</b>.</p>' +
      (door ? '<div class="qrbox sm">' + svg(linkFor("/join", door.token), "Door link") + '</div><p class="small center"><b>' + esc(door.label) + '</b></p><button class="btn slim" type="button" id="copydoor">Copy the door link</button>'
        : '<button class="btn primary" type="button" id="mkdoor">Make a door link</button>') + "</section>" +
      '<section class="card step"><h2>This computer shows the live board</h2><p class="muted small">Keep it open while Phone 2 scans Phone 1. The count changes within a couple of seconds.</p>' +
      '<a class="btn primary big" href="/board" target="_blank" rel="noopener">Open the live board</a>' +
      "<h3>Then try</h3><ul class=\"small\" style=\"padding-left:1.1em;display:grid;gap:6px\"><li>Scan the same code twice. The second scan is refused.</li><li>Put <b>Dues not on record</b> on Phone 1. The question goes to the Sergeant-at-Arms on the board.</li><li>On Phone 2, tap <b>Find by name</b> for someone without a phone.</li>" +
      (m.samples ? '<li>Fill the room, then call to order and declare quorum on the board: <button class="btn slim" type="button" id="fill">Check in 40 test people</button></li>' : "") + "</ul></section></div>";
    const q = panel.querySelector("#tq"), res = panel.querySelector("#tres");
    q.value = tq;
    const search = () => {
      tq = q.value;
      const s = tq.trim().toLowerCase();
      if (s.length < 2) { res.innerHTML = ""; return; }
      res.innerHTML = m.people.filter(p => p.name.toLowerCase().includes(s) || p.pct.toLowerCase().includes(s)).slice(0, 6)
        .map(p => '<button type="button" class="item pick" data-pick="' + p.id + '" style="width:100%;background:none;border-left:0;border-right:0;border-bottom:0;text-align:left"><span class="main"><b>' + esc(p.name) + "</b><span>" + esc(KIND[p.kind]) + " · " + esc(p.pct) + "</span></span></button>").join("") || '<p class="muted small">No one matches.</p>';
    };
    q.addEventListener("input", search);
    search();
    panel.onclick = async e => {
      const s = e.target.closest("[data-sample]"), p = e.target.closest("[data-pick]");
      try {
        if (s) await pick(m.samples[s.dataset.sample]);
        else if (p) await pick(p.dataset.pick);
      } catch (err) { toast(err.message, "bad"); }
    };
    async function pick(pid) {
      picked = pid;
      pickedToken = (await act({ a: "credential", pid })).data.token;
      panel.querySelectorAll("[data-sample]").forEach(b => b.setAttribute("aria-pressed", String(m.samples && m.samples[b.dataset.sample] === pid)));
      showPicked();
    }
    function showPicked() {
      const box = panel.querySelector("#tcred");
      const p = m.people.find(x => x.id === picked);
      if (!p || !pickedToken) { box.innerHTML = ""; return; }
      const j = judge(p, m.config.date, m.rulings[p.id]), [cls, label] = STATUS[j.cls], c = m.ci[p.id];
      box.innerHTML = '<div class="qrbox sm">' + svg(linkFor("/me", pickedToken), "Credential link for " + p.name) + "</div>" +
        "<p><b>" + esc(p.name) + '</b> <span class="pill ' + cls + '">' + label + "</span>" + (c ? ' <span class="pill vote">Checked in</span>' : "") + "</p>" +
        '<p class="small muted">' + esc((j.why.find(x => !x.ok) || j.why[0] || {}).text || "") + "</p>" +
        '<button class="btn slim" type="button" id="copycred">Copy this link</button>';
      box.querySelector("#copycred").addEventListener("click", () => copyText(linkFor("/me", pickedToken)));
    }
    if (picked) showPicked();
    const copyDoor = panel.querySelector("#copydoor");
    if (copyDoor) copyDoor.addEventListener("click", () => copyText(linkFor("/join", door.token)));
    const mk = panel.querySelector("#mkdoor");
    if (mk) mk.addEventListener("click", busy(mk, async () => { await act({ a: "device-add", role: "door", label: "Door 1" }); await load(); }));
    const fill = panel.querySelector("#fill");
    if (fill) fill.addEventListener("click", busy(fill, async () => { const r = (await act({ a: "test-fill", n: 40 })).data; toast(plural(r.added, "test person", "test people") + " checked in."); await load(); }));
  }

  /* ----- people ----- */
  function renderPeople(panel, m) {
    panel.innerHTML = '<div class="grid lead"><section class="card"><div class="card-head"><h2>People</h2><span class="pill">' + m.people.length + '</span><button class="btn slim primary" type="button" id="addp">Add a person</button></div>' +
      '<div class="field"><input id="pq" autocomplete="off" placeholder="Search by name or precinct" aria-label="Search people"></div><div class="scroll-x" id="ptable"></div></section>' +
      '<section class="card" id="pdetail"><p class="muted">Pick someone to see their code, change their dues or status, or reissue their code.</p></section></div>';
    const input = panel.querySelector("#pq");
    input.value = pq;
    const table = () => {
      pq = input.value;
      const s = pq.trim().toLowerCase();
      const list = m.people.filter(p => !s || p.name.toLowerCase().includes(s) || p.pct.toLowerCase().includes(s)).slice(0, 80);
      panel.querySelector("#ptable").innerHTML = "<table><thead><tr><th>Name</th><th>Precinct</th><th>Role</th><th>Status</th></tr></thead><tbody>" + list.map(p => {
        const j = judge(p, m.config.date, m.rulings[p.id]), [cls, label] = STATUS[j.cls], c = m.ci[p.id];
        return '<tr data-person="' + p.id + '" style="cursor:pointer"><td><button type="button" class="link-btn" data-person="' + p.id + '">' + esc(p.name) + "</button></td><td class=\"nowrap\">" + esc(p.pct) + "</td><td>" + esc(KIND[p.kind]) + (p.office ? " · " + esc(p.office) : "") + '</td><td><span class="pill ' + cls + '">' + label + "</span>" + (c ? ' <span class="pill vote">In</span>' : "") + "</td></tr>";
      }).join("") + "</tbody></table>" + (m.people.length > list.length && !s ? '<p class="small muted">Showing ' + list.length + " of " + m.people.length + ". Search to find others.</p>" : "");
    };
    input.addEventListener("input", table);
    table();
    panel.querySelector("#ptable").addEventListener("click", e => { const b = e.target.closest("[data-person]"); if (b) { personOpen = b.dataset.person; detail(); } });
    panel.querySelector("#addp").addEventListener("click", () => { personOpen = "new"; detail(); });
    if (personOpen) detail();

    async function detail() {
      const box = panel.querySelector("#pdetail");
      if (personOpen === "new") return addForm(box);
      const p = m.people.find(x => x.id === personOpen);
      if (!p) { box.innerHTML = '<p class="muted">Pick someone.</p>'; return; }
      const j = judge(p, m.config.date, m.rulings[p.id]), [cls, label] = STATUS[j.cls], c = m.ci[p.id];
      box.innerHTML = '<div class="card-head"><h2>' + esc(p.name) + '</h2><span class="pill ' + cls + '">' + label + "</span></div>" +
        '<p class="muted">' + esc(KIND[p.kind]) + (p.office ? " (" + esc(p.office) + ")" : "") + " · " + esc(p.pct) + " · LD " + p.ld + (p.appt ? " · appointed " + fmtDate(p.appt, false) : "") + "</p>" +
        (c ? '<p class="note vote small">Checked in at ' + time(c.t) + " by " + esc(c.by) + (c.card ? ", card " + c.card : "") + (c.left ? "; left at " + time(c.left) : "") + "</p>" : "") +
        '<ul class="why">' + j.why.map(x => '<li><span class="' + (x.ok ? "y" : "n") + '">' + (x.ok ? "✓" : "✕") + "</span><span>" + esc(x.text) + '</span><span class="cite">' + esc(x.cite) + "</span></li>").join("") + "</ul>" +
        '<div id="cred"><p class="small muted">Loading their code…</p></div>' +
        "<h3>Status</h3>" +
        '<label class="check"><input type="checkbox" data-flag="dues"' + (p.dues ? " checked" : "") + "> " + m.config.date.slice(0, 4) + " dues paid (SR B)</label>" +
        (PCO_KINDS.includes(p.kind) ? '<label class="check"><input type="checkbox" data-flag="inactive"' + (p.inactive ? " checked" : "") + "> Inactive (2.6)</label>" : "") +
        '<label class="check"><input type="checkbox" data-flag="missed2"' + (p.missed2 ? " checked" : "") + "> Missed the last two meetings (4.4.1)</label>" +
        '<label class="check"><input type="checkbox" data-flag="missedAny"' + (p.missedAny ? " checked" : "") + "> Missed a meeting this term (no proxy, 4.5)</label>" +
        '<div class="row-flex"><button class="btn warn slim" type="button" id="reissue">Reissue their code</button></div><p class="small muted">Reissuing stops the old code from working, for a lost phone or a shared code.</p>';
      box.querySelectorAll("[data-flag]").forEach(cb => cb.addEventListener("change", async () => {
        cb.disabled = true;
        try { await act({ a: "person-edit", pid: p.id, changes: { [cb.dataset.flag]: cb.checked } }); toast("Saved."); await load(); }
        catch (e) { toast(e.message, "bad"); cb.checked = !cb.checked; cb.disabled = false; }
      }));
      confirmButton(box.querySelector("#reissue"), "Tap again to reissue", async () => {
        try { await act({ a: "reissue-credential", pid: p.id }); toast("Reissued. The old code no longer works."); await load(); } catch (e) { toast(e.message, "bad"); }
      });
      try {
        const token = (await act({ a: "credential", pid: p.id })).data.token, link = linkFor("/me", token);
        box.querySelector("#cred").innerHTML = "<h3>Their code</h3><div class=\"qrbox sm\">" + svg(link, "Credential link for " + p.name) + "</div>" +
          '<div class="row-flex"><button class="btn slim" type="button" id="copyl">Copy link</button><a class="btn slim" href="mailto:?subject=' + encodeURIComponent("Your check-in code for " + m.config.name) + "&body=" + encodeURIComponent("Open this link on your phone before the meeting. Show the code at the door.\n\n" + link + "\n\nKeep it to yourself: it checks you in.") + '">Email it</a></div>' +
          '<p class="small muted">Send this link only to ' + esc(p.name) + ". It checks them in.</p>";
        box.querySelector("#copyl").addEventListener("click", () => copyText(link));
      } catch (e) { box.querySelector("#cred").innerHTML = '<p class="note stop small">' + esc(e.message) + "</p>"; }
    }
    function addForm(box) {
      box.innerHTML = '<div class="card-head"><h2>Add a person</h2></div>' +
        '<div class="fields"><div class="field"><label for="nn">Name</label><input id="nn" autocomplete="off"></div>' +
        '<div class="field"><label for="np">Precinct</label><input id="np" autocomplete="off" placeholder="27-488"></div>' +
        '<div class="field"><label for="nl">Legislative District</label><input id="nl" inputmode="numeric" autocomplete="off" placeholder="27"></div>' +
        '<div class="field"><label for="nk">Role</label><select id="nk">' + Object.entries(KIND).map(([k, v]) => '<option value="' + k + '">' + v + "</option>").join("") + "</select></div>" +
        '<div class="field"><label for="no">Office (optional)</label><input id="no" autocomplete="off" placeholder="Sergeant-at-Arms"></div>' +
        '<div class="field" id="apptf" hidden><label for="na">Appointed on</label><input id="na" type="date"></div></div>' +
        '<label class="check"><input type="checkbox" id="nd" checked> ' + m.config.date.slice(0, 4) + " dues paid</label>" +
        '<div class="row-flex"><button class="btn primary" type="button" id="save">Add to the roster</button><button class="btn" type="button" id="cancel">Cancel</button></div><div id="added"></div>';
      const kind = box.querySelector("#nk");
      kind.addEventListener("change", () => { box.querySelector("#apptf").hidden = kind.value !== "appointed"; });
      box.querySelector("#cancel").addEventListener("click", () => { personOpen = null; detail(); });
      const save = box.querySelector("#save");
      save.addEventListener("click", busy(save, async () => {
        const person = { name: box.querySelector("#nn").value, pct: box.querySelector("#np").value, ld: Number(box.querySelector("#nl").value), kind: kind.value, office: box.querySelector("#no").value, dues: box.querySelector("#nd").checked };
        if (kind.value === "appointed") person.appt = box.querySelector("#na").value;
        const r = (await act({ a: "person-add", person })).data;
        toast(r.person.name + " is on the roster.");
        personOpen = r.person.id;
        picked = r.person.id; pickedToken = r.token;
        await load();
      }));
    }
  }

  /* ----- devices ----- */
  function renderDevices(panel) {
    panel.innerHTML = '<div class="grid two"><section class="card"><div class="card-head"><h2>Devices</h2><span class="pill">' + A.devices.length + "</span></div>" +
      '<p class="small muted">Each officer\'s phone or computer opens its own link once. Signing a device out stops its link from working.</p><div class="list">' +
      A.devices.map(d => '<div class="item"><div class="main"><b>' + esc(d.label) + "</b><span>" + esc(d.roleName) + (d.ld ? " · LD " + d.ld : "") + " · added " + new Date(d.created).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) + (d.id === you.id ? " · this browser" : "") + "</span></div>" +
        (d.role !== "admin" ? '<button class="btn slim" type="button" data-show="' + d.id + '">Show link</button>' : "") + '<button class="btn slim warn" type="button" data-revoke="' + d.id + '">Sign out</button></div>').join("") + "</div></section>" +
      '<section class="card"><h2>Add a device</h2><div class="fields"><div class="field"><label for="dr">Role</label><select id="dr">' + ROLE_OPTS.map(([k, v]) => '<option value="' + k + '">' + v + "</option>").join("") + "</select></div>" +
      '<div class="field" id="dlf" hidden><label for="dl">District</label><input id="dl" inputmode="numeric" placeholder="27"></div>' +
      '<div class="field"><label for="dn">Name (optional)</label><input id="dn" autocomplete="off" placeholder="Door 2"></div></div>' +
      '<button class="btn primary" type="button" id="dadd">Make the link</button><div id="dshow"></div></section></div>';
    const role = panel.querySelector("#dr");
    role.addEventListener("change", () => { panel.querySelector("#dlf").hidden = role.value !== "ld"; });
    const show = d => {
      const link = linkFor("/join", d.token);
      panel.querySelector("#dshow").innerHTML = "<h3>" + esc(d.label) + '</h3><div class="qrbox sm">' + svg(link, "Device link for " + d.label) + '</div><p class="small muted">Scan with that phone\'s camera, or send the link to its owner. Anyone with it can act as ' + esc(d.label) + '.</p><button class="btn slim" type="button" id="dcopy">Copy link</button>';
      panel.querySelector("#dcopy").addEventListener("click", () => copyText(link));
    };
    const add = panel.querySelector("#dadd");
    add.addEventListener("click", busy(add, async () => {
      const r = (await act({ a: "device-add", role: role.value, ld: Number(panel.querySelector("#dl").value) || undefined, label: panel.querySelector("#dn").value || undefined })).data;
      newDevice = { ...r.device, token: r.token };
      await load();
    }));
    if (newDevice) { show(newDevice); newDevice = null; }
    panel.querySelectorAll("[data-show]").forEach(b => b.addEventListener("click", () => show(A.devices.find(d => d.id === b.dataset.show))));
    panel.querySelectorAll("[data-revoke]").forEach(b => confirmButton(b, "Tap again", async () => {
      try {
        await act({ a: "device-revoke", id: b.dataset.revoke });
        if (b.dataset.revoke === you.id) { clearToken("device"); location.reload(); return; }
        toast("Signed out."); await load();
      } catch (e) { toast(e.message, "bad"); }
    }));
  }

  /* ----- the meeting ----- */
  function renderMeeting(panel, m) {
    panel.innerHTML = '<div class="grid two"><section class="card"><h2>This meeting</h2><div class="fields">' +
      '<div class="field"><label for="mn">Name</label><input id="mn" value="' + esc(m.config.name) + '"></div><div class="field"><label for="md">Date</label><input id="md" type="date" value="' + esc(m.config.date) + '"></div></div>' +
      '<label class="check"><input type="checkbox" id="mc"' + (m.config.closeAtQuorum !== false ? " checked" : "") + "> Close check-in when the Chair declares quorum (4.7.4.B). The Chair can still choose on the board.</label>" +
      '<p class="small muted">The date decides who has passed 60 days since appointment (2.2.1.D) and which year\'s dues count.</p>' +
      '<button class="btn primary" type="button" id="msave">Save</button></section>' +
      '<section class="card"><h2>Start fresh</h2><p class="small muted">Clears every check-in, question, ruling and the log. The roster stays.</p><button class="btn warn" type="button" id="restart">Clear check-ins and start over</button>' +
      '<div id="newm"></div></section></div>';
    const save = panel.querySelector("#msave");
    save.addEventListener("click", busy(save, async () => {
      await act({ a: "settings", name: panel.querySelector("#mn").value, date: panel.querySelector("#md").value, closeAtQuorum: panel.querySelector("#mc").checked });
      toast("Saved."); await load();
    }));
    confirmButton(panel.querySelector("#restart"), "Tap again to clear everything", async () => {
      try { await act({ a: "restart" }); toast("Started over."); await load(); } catch (e) { toast(e.message, "bad"); }
    });
    renderSetup(panel.querySelector("#newm"), false);
  }
  function renderSetup(box, first) {
    box.innerHTML = (first ? '<section class="card raise narrow" style="margin:0 auto">' : "<div class=\"stack\" style=\"margin-top:14px\">") +
      "<h2>" + (first ? "Set up a meeting" : "Set up a different meeting") + "</h2>" +
      (first ? '<p class="muted">Start with the sample roster of fictional people to try everything with your phones. You can set up the real one later.</p>' : '<p class="small muted">Replaces the roster, check-ins and log.</p>') +
      '<div class="fields"><div class="field"><label for="sn">Name</label><input id="sn" value="Central Committee meeting"></div><div class="field"><label for="sd">Date</label><input id="sd" type="date" value="' + esc(A.today) + '"></div></div>' +
      '<label class="check"><input type="radio" name="roster" value="sample" checked> Sample roster: 210 fictional people across seven districts</label>' +
      '<label class="check"><input type="radio" name="roster" value="empty"> Empty roster: I\'ll add people myself</label>' +
      '<button class="btn ' + (first ? "primary" : "warn") + '" type="button" id="setup">' + (first ? "Set it up" : "Replace the meeting") + "</button>" + (first ? "</section>" : "</div>");
    const run = async () => {
      await act({ a: "setup", name: box.querySelector("#sn").value, date: box.querySelector("#sd").value, sample: box.querySelector("input[name=roster]:checked").value === "sample" });
      picked = null; pickedToken = null; personOpen = null; tab = "test";
      toast("The meeting is set up."); await load();
    };
    const b = box.querySelector("#setup");
    if (first) b.addEventListener("click", busy(b, run));
    else confirmButton(b, "Tap again to replace everything", async () => { try { await run(); } catch (e) { toast(e.message, "bad"); } });
  }

  /* ----- records ----- */
  function renderRecords(panel, m) {
    panel.innerHTML = '<div class="grid two"><section class="card"><h2>The official roll</h2><p class="small muted">The digital record is the official roll for the meeting (4.7.5.B). Each file ends with the log\'s final fingerprint.</p>' +
      '<div class="row-flex"><button class="btn primary" type="button" data-dl="roll">Download the roll (CSV)</button><button class="btn" type="button" data-dl="log">Download the log (CSV)</button></div></section>' +
      '<section class="card"><div class="card-head"><h2>The log</h2><span class="pill">' + m.logLen + ' entries</span></div><button class="btn slim" type="button" id="verify">Check the log</button><div id="vres"></div>' +
      '<ol class="log">' + m.logTail.slice().reverse().map(e => '<li><span class="meta"><span>#' + e.n + " · " + time(e.t) + " · " + esc(e.who) + "</span><span>" + e.h.slice(0, 8) + "</span></span><span>" + esc(e.what) + "</span></li>").join("") + "</ol></section></div>";
    panel.querySelectorAll("[data-dl]").forEach(b => b.addEventListener("click", busy(b, () => download(b.dataset.dl))));
    const v = panel.querySelector("#verify");
    v.addEventListener("click", busy(v, async () => {
      const r = await verifyChain((await api("/api/log")).data.log);
      panel.querySelector("#vres").innerHTML = r.ok ? '<p class="note vote small">All ' + r.n + " entries check out.</p>" : '<p class="note stop small">Entry ' + r.at + " doesn't match its fingerprint.</p>";
    }));
  }
  async function download(what) {
    const res = await fetch("/api/export?what=" + what, { headers: { authorization: "Bearer " + getToken("device") }, cache: "no-store" });
    if (!res.ok) { let msg = "Couldn't download."; try { msg = (await res.json()).error || msg; } catch (e) { /* keep */ } throw new Error(msg); }
    const name = (/filename="([^"]+)"/.exec(res.headers.get("content-disposition") || "") || [])[1] || what + ".csv";
    const url = URL.createObjectURL(await res.blob());
    const a = h('<a hidden download="' + esc(name) + '" href="' + url + '"></a>');
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
  }

  try { await load(); } catch (e) { $("#panel").innerHTML = '<p class="note stop">' + esc(e.message) + "</p>"; }
}

function signIn(root, you) {
  root.innerHTML = header() + '<main class="wrap narrow"><form class="card raise" id="f"><h2>Secretary sign-in</h2>' +
    (you ? '<p class="note small">This browser is signed in as ' + esc(you.label) + ". Signing in here replaces that.</p>" : "") +
    '<div class="field"><label for="k">Admin key</label><input id="k" type="password" autocomplete="current-password" required></div>' +
    '<button class="btn primary big" type="submit">Sign in</button><p class="small muted">The admin key is the ADMIN_KEY set in Netlify.</p></form></main>';
  const f = root.querySelector("#f");
  f.addEventListener("submit", async e => {
    e.preventDefault();
    const btn = f.querySelector("button");
    btn.disabled = true;
    try {
      const r = (await api("/api/login", { method: "POST", body: { key: f.querySelector("#k").value }, token: null })).data;
      setToken("device", r.token);
      location.reload();
    } catch (err) { toast(err.message, "bad"); btn.disabled = false; }
  });
}
