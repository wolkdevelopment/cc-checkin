/* A PCO's credential (/me#CC1...): the QR code for the door and this person's status, live.
   The code is drawn on the phone, so it shows even with no signal. */
import { getToken, setToken, clearToken, api, esc, time, poller, header } from "../lib.js";
import { svg } from "../qr.js";
import { fmtDate } from "../rules.js";

export async function mount(root) {
  const fromLink = decodeURIComponent(location.hash.slice(1)).trim();
  if (/^CC1\./.test(fromLink)) { setToken("cred", fromLink); history.replaceState(null, "", "/me"); }
  const token = getToken("cred");
  if (!token) {
    root.innerHTML = header() + '<main class="wrap narrow"><section class="card raise"><h2>No credential on this phone</h2><p class="muted">Open the link the Secretary sent you. It puts your check-in code on this phone.</p></section></main>';
    return;
  }
  root.innerHTML = header() +
    '<main class="wrap narrow stack">' +
    '<article class="pass" aria-live="polite">' +
    '<div class="pass-head"><span class="label" id="mname">Central Committee</span><b id="mdate">&nbsp;</b></div>' +
    '<div class="pass-status" id="status"><span class="ico" aria-hidden="true">…</span><span>Checking your status…</span></div>' +
    '<div class="pass-body"><div><div class="pass-name" id="pname">&nbsp;</div><div class="muted" id="pmeta">&nbsp;</div></div>' +
    '<div class="qrbox" id="qr"></div></div>' +
    '<p class="pass-foot" id="foot">Turn your screen brightness up and hold it toward the door scanner.</p>' +
    "</article>" +
    '<section class="card" id="more" hidden></section>' +
    "</main>";
  root.querySelector("#qr").innerHTML = svg(token, "Your check-in code");
  const $ = s => root.querySelector(s);
  let etag = "", data = null;

  function render(problem) {
    const st = $("#status");
    if (problem) {
      st.className = "pass-status stop";
      st.innerHTML = '<span class="ico" aria-hidden="true">!</span><span>' + esc(problem) + "</span>";
      return;
    }
    if (!data) return;
    const m = data.meeting, p = data.person, j = data.judge, c = data.checkin, w = data.window;
    $("#mname").textContent = m.name;
    $("#mdate").textContent = fmtDate(m.date);
    $("#pname").textContent = p.name;
    $("#pmeta").textContent = p.kindName + (p.office ? " (" + p.office + ")" : "") + " · " + p.pct + " · LD " + p.ld;
    let cls, ico, title, sub;
    if (c && !c.left) { cls = "done"; ico = "✓"; title = "Checked in"; sub = time(c.t) + (c.card ? " · Voting card " + c.card : " · Name badge, no voting card"); }
    else if (c && c.left) { cls = "non"; ico = "↩"; title = "You stepped out"; sub = "Left at " + time(c.left) + ". Show this code to come back in."; }
    else if (!w.open) { cls = "stop"; ico = "!"; title = "Check-in is closed"; sub = w.text; }
    else if (j.cls === "vote") { cls = "vote"; ico = "✓"; title = "You can vote"; sub = "Show this code at the door"; }
    else if (j.cls === "rule") { cls = "rule"; ico = "?"; title = "See the Sergeant-at-Arms"; sub = (j.why.find(x => !x.ok) || {}).text || ""; }
    else { cls = "non"; ico = "i"; title = "You can't vote at this meeting"; sub = (j.why.find(x => !x.ok) || {}).text || ""; }
    st.className = "pass-status " + cls;
    st.innerHTML = '<span class="ico" aria-hidden="true">' + ico + "</span><span>" + esc(title) + (sub ? "<small>" + esc(sub) + "</small>" : "") + "</span>";
    $("#foot").textContent = c && !c.left ? "Keep this handy; ballots may be checked against it." : "Turn your screen brightness up and hold it toward the door scanner.";
    const more = $("#more");
    more.hidden = false;
    more.innerHTML =
      "<h3>Why</h3><ul class=\"why\">" + j.why.map(x => '<li><span class="' + (x.ok ? "y" : "n") + '" aria-hidden="true">' + (x.ok ? "✓" : "✕") + "</span><span>" + esc(x.text) + '</span><span class="cite">' + esc(x.cite) + "</span></li>").join("") + "</ul>" +
      (data.attendance.missed2 ? '<p class="small muted">You missed the last two meetings. While you\'re absent, you aren\'t counted toward quorum (4.4.1).</p>' : "") +
      (data.queued && !(c && !c.left) ? '<p class="note rule small">The door sent your question to the Sergeant-at-Arms.</p>' : "") +
      '<p class="small muted">Check-in is in person only. It doesn\'t allow voting from home (4.7.7).</p>' +
      '<p class="small"><button class="link-btn" id="forget" type="button">Not you? Remove this code from this phone</button></p>';
    $("#forget").addEventListener("click", () => { clearToken("cred"); location.replace("/"); });
  }

  const poll = poller(async () => {
    try {
      const r = await api("/api/me?etag=" + encodeURIComponent(etag), { token });
      if (r.status === 204) return;
      data = r.data; etag = data.etag;
      render();
      if (data.checkin && !data.checkin.left) poll.stop(); // done for tonight; reopening the page checks again
    } catch (e) {
      if (e.status === 410) { render("This code was replaced. Ask the Secretary for your new link."); poll.stop(); }
      else if (e.status === 401 || e.status === 404) { render(e.message); poll.stop(); }
      else if (e.data && e.data.offline) { if (!data) render("Offline. Your code still works at the door."); throw e; }
      else throw e;
    }
  }, 3000);
  poll.start();
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") { poll.start(); keepAwake(); } });

  // Keep the screen on while someone waits in line.
  let lock = null;
  async function keepAwake() { try { if ("wakeLock" in navigator && !lock) { lock = await navigator.wakeLock.request("screen"); lock.addEventListener("release", () => { lock = null; }); } } catch (e) { lock = null; } }
  keepAwake();
}
