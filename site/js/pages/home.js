/* The front page: sends each device to its own screen. */
import { getToken, clearToken, api, esc, header } from "../lib.js";

const PAGE = { door: ["/door", "Open the door scanner"], saa: ["/board", "Open the live board"], chair: ["/board", "Open the live board"], ld: ["/board", "Open the live board"], admin: ["/admin", "Open the admin page"] };

export async function mount(root) {
  root.innerHTML = header() + '<main class="wrap narrow stack" id="home"><p class="boot">Loading…</p></main>';
  const main = root.querySelector("#home");
  let you = null;
  if (getToken("device")) {
    try { you = (await api("/api/whoami")).data.you; } catch (e) { if (e.status === 401) clearToken("device"); }
  }
  const cred = getToken("cred");
  let html = '<section class="card raise"><h1 style="font-size:1.7rem;font-weight:850;letter-spacing:-.02em;line-height:1.1">Central Committee check-in</h1>' +
    '<p class="muted">PCOs check in by showing a QR code on their phone. Officers see who\'s here and whether there\'s a quorum, live.</p></section>';
  if (you) {
    const [href, label] = PAGE[you.role];
    html += '<section class="card"><h3>This device</h3><p><b>' + esc(you.label) + "</b> <span class=\"muted\">· " + esc(you.roleName) + "</span></p>" +
      '<a class="btn primary big" href="' + href + '">' + label + "</a>" +
      (you.role === "admin" ? '<a class="btn full" href="/board">Open the live board</a><a class="btn full" href="/door">Open the door scanner</a>' : "") +
      '<button class="link-btn small" id="out" type="button">Sign this device out</button></section>';
  }
  if (cred) html += '<section class="card"><h3>Your credential</h3><a class="btn primary big" href="/me">Show my check-in code</a></section>';
  if (!you && !cred) {
    html += '<section class="card"><h3>PCOs</h3><p>Open the link the Secretary sent you. It shows your code for the door.</p>' +
      '<h3>Officers</h3><p>Open the device link the Secretary gave you. It signs this phone or computer in as the door, the Sergeant-at-Arms, the Chair or a District Chair.</p>' +
      '<a class="btn" href="/admin">Secretary sign-in</a></section>';
  }
  main.innerHTML = html;
  const out = main.querySelector("#out");
  if (out) out.addEventListener("click", () => { clearToken("device"); location.reload(); });
}
