/* A device link (/join#DV1...): signs this phone or computer in as one officer role. */
import { api, setToken, esc, header } from "../lib.js";

const DEST = { door: "/door", saa: "/board", chair: "/board", ld: "/board", admin: "/admin" };

export async function mount(root) {
  const token = decodeURIComponent(location.hash.slice(1)).trim();
  if (/^CC1\./.test(token)) { location.replace("/me#" + encodeURIComponent(token)); return; }
  history.replaceState(null, "", "/join");
  root.innerHTML = header() + '<main class="wrap narrow"><section class="card raise" id="box"><p>Signing in this device…</p></section></main>';
  const box = root.querySelector("#box");
  if (!/^DV1\./.test(token)) {
    box.innerHTML = '<h2>That link is incomplete</h2><p class="muted">Open the whole device link from the admin page. On a phone, scan its QR code with the camera.</p>';
    return;
  }
  try {
    const you = (await api("/api/whoami", { token })).data.you;
    setToken("device", token);
    const dest = DEST[you.role] || "/";
    box.innerHTML = '<h2>Signed in as ' + esc(you.label) + "</h2><p class=\"muted\">" + esc(you.roleName) + ". This device will remember it.</p>" +
      '<a class="btn primary big" href="' + dest + '">Continue</a>';
    setTimeout(() => location.replace(dest), 1200);
  } catch (e) {
    box.innerHTML = "<h2>This link doesn't work</h2><p class=\"muted\">" + esc(e.message) + "</p>";
  }
}
