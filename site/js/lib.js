/* Shared by every page: storage, talking to the server, small UI helpers. */

export const keys = { device: "cc.device", cred: "cc.cred" };
export const local = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode: works for this visit only */ } },
  del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }
};
const memory = {};
export function getToken(kind) { return local.get(keys[kind]) || memory[kind] || null; }
export function setToken(kind, value) { memory[kind] = value; local.set(keys[kind], value); }
export function clearToken(kind) { delete memory[kind]; local.del(keys[kind]); }

export class ApiError extends Error {
  constructor(message, status, data) { super(message); this.status = status; this.data = data || {}; }
}
export async function api(path, { method = "GET", body, token } = {}) {
  const headers = {};
  const t = token === undefined ? getToken("device") : token;
  if (t) headers.authorization = "Bearer " + t;
  if (body) headers["content-type"] = "application/json";
  let res;
  try {
    res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined, cache: "no-store" });
  } catch (e) {
    throw new ApiError("Can't reach the server. Check the connection.", 0, { offline: true });
  }
  if (res.status === 204) return { status: 204, data: null };
  let data = null;
  try { data = await res.json(); } catch (e) { data = null; }
  if (!res.ok) throw new ApiError((data && data.error) || "Something went wrong (" + res.status + ").", res.status, data);
  return { status: res.status, data };
}
export const act = body => api("/api/act", { method: "POST", body });

export const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
export const time = t => (t ? new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "");
export const plural = (n, one, many) => n + " " + (n === 1 ? one : many || one + "s");
export function h(html) { const t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstElementChild; }

let toastTimer = null;
export function toast(message, kind) {
  let el = document.getElementById("toast");
  if (!el) { el = h('<div id="toast" class="toast" role="status" aria-live="polite"></div>'); document.body.appendChild(el); }
  el.textContent = message;
  el.className = "toast show" + (kind ? " " + kind : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = "toast"; }, kind === "bad" ? 5000 : 2600);
}

/* Calls fn every `ms` while the page is visible, slowing down after errors. */
export function poller(fn, ms) {
  let timer = null, stopped = true, delay = ms;
  async function run() {
    timer = null;
    if (stopped) return;
    if (document.visibilityState !== "visible") return;
    try { await fn(); delay = ms; } catch (e) { delay = Math.min(delay * 2, 30000); }
    if (!stopped && !timer) timer = setTimeout(run, delay);
  }
  function onVis() { if (!stopped && document.visibilityState === "visible" && !timer) run(); }
  return {
    start() { if (!stopped) return; stopped = false; document.addEventListener("visibilitychange", onVis); run(); },
    stop() { stopped = true; clearTimeout(timer); timer = null; document.removeEventListener("visibilitychange", onVis); },
    now() { clearTimeout(timer); timer = null; return run(); }
  };
}

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast("Copied."); return true; }
  catch (e) { toast("Couldn't copy. Press and hold the link to copy it.", "bad"); return false; }
}
export function linkFor(path, token) { return location.origin + path + "#" + token; }

export function header(right) {
  return '<header class="top"><div class="wrap top-in"><a class="brand" href="/"><span class="mark" aria-hidden="true"></span>Check-In<span class="beta">Beta</span></a>' + (right || "") + "</div></header>";
}

// Two taps for anything that can't be undone.
export function confirmButton(btn, label, onConfirm) {
  let armed = false, timer = null;
  const original = btn.textContent;
  btn.addEventListener("click", async () => {
    if (!armed) {
      armed = true; btn.textContent = label; btn.classList.add("armed");
      timer = setTimeout(() => { armed = false; btn.textContent = original; btn.classList.remove("armed"); }, 4000);
      return;
    }
    clearTimeout(timer); armed = false; btn.textContent = original; btn.classList.remove("armed");
    await onConfirm();
  });
}

export function busy(btn, fn) {
  return async (...args) => {
    if (btn.disabled) return;
    btn.disabled = true;
    btn.setAttribute("aria-busy", "true");
    try { return await fn(...args); }
    catch (e) { toast(e.message, "bad"); }
    finally { btn.disabled = false; btn.removeAttribute("aria-busy"); }
  };
}
