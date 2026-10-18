/* Picks the page from the address and loads it. */
const routes = { "/": "home", "/admin": "admin", "/me": "me", "/door": "door", "/board": "board", "/join": "join" };
const path = location.pathname.replace(/\/+$/, "") || "/";
const root = document.getElementById("app");
import("./pages/" + (routes[path] || "home") + ".js")
  .then(mod => mod.mount(root))
  .catch(e => {
    console.error(e);
    root.innerHTML = '<p class="boot">This page couldn\'t load. Check the connection and reload.</p>';
  });
