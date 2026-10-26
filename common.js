// Hero Board — shared helpers
const sb = supabase.createClient(HB_CONFIG.SUPABASE_URL, HB_CONFIG.SUPABASE_KEY, { auth: { storageKey: "hero-board-auth" } });
const TZ = "Asia/Riyadh";

function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function $(sel, root = document) { return root.querySelector(sel); }
function fmtDateTime(v) {
  if (!v) return "—";
  return new Date(v).toLocaleString("en-GB", { timeZone: TZ, day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: true });
}
function fmtDate(v) {
  if (!v) return "—";
  return new Date(v + "T12:00:00").toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}
function fmtPrice(p) { return p == null || p === "" ? "" : `${Number(p).toFixed(2)} SAR`; }
function pct(a, b) { return b > 0 ? Math.round((a / b) * 100) : 0; }
function errMsg(e) {
  const m = (e && (e.message || e.error_description)) || String(e);
  if (m.includes("SESSION_EXPIRED")) return "Your session has ended. Please log in again.";
  if (m.includes("LINK_INVALID")) return "This link is not valid. Please ask your store manager for the latest link.";
  if (m.includes("LINK_OLD")) return "This link is for an old week. Please ask your store manager for this week's link.";
  if (m.includes("Failed to fetch")) return "No internet connection. Please try again.";
  return m;
}
function toast(msg, kind = "ok") {
  let t = $("#toast");
  if (!t) { t = document.createElement("div"); t.id = "toast"; document.body.appendChild(t); }
  t.textContent = msg; t.className = "show " + kind;
  clearTimeout(t._h); t._h = setTimeout(() => (t.className = ""), 3200);
}
function clearAdminLogin() {
  try { Object.keys(localStorage).filter(k => k.startsWith("hero-board-auth")).forEach(k => localStorage.removeItem(k)); } catch {} // Hero Board only, never Trackit
}
function storageGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function storageSet(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} }

// Live updates over small broadcast channels:
//   hb-all          → every store (new week published / products changed)
//   hb-admin        → admin dashboard (a store or staff acknowledged)
//   hb-store-<CODE> → one store (its own staff acknowledged)
const hbChannels = {};
function hbChannel(name) { return hbChannels[name] || (hbChannels[name] = sb.channel(name)); }
function liveConnect(names, onPing, delay = 1500) {
  let t = null;
  const fire = () => { clearTimeout(t); t = setTimeout(onPing, delay); };
  names.forEach(n => hbChannel(n).on("broadcast", { event: "refresh" }, fire).subscribe());
  setInterval(() => { if (!document.hidden) onPing(); }, 300000); // safety net every 5 min, only while the page is open on screen
  document.addEventListener("visibilitychange", () => { if (!document.hidden) fire(); });
}
function livePing(names, what) {
  names.forEach(n => hbChannel(n).send({ type: "broadcast", event: "refresh", payload: { what } }).catch(() => {}));
}

function logoHTML() { return `<div class="logo" aria-label="Half Million">½M</div>`; }

function productCards(products) {
  if (!products.length) return `<p class="muted">No hero products added yet.</p>`;
  return `<div class="cards">${products.map(p => `
    <article class="pcard">
      <div class="pimg">${p.photo_url ? `<img src="${esc(p.photo_url)}" alt="${esc(p.name)}" loading="lazy">` : `<span>½M</span>`}</div>
      <div class="pbody">
        <h3>${esc(p.name)}</h3>
        ${p.price != null ? `<div class="price">${fmtPrice(p.price)}</div>` : ""}
        ${p.description ? `<p>${esc(p.description)}</p>` : ""}
      </div>
    </article>`).join("")}</div>`;
}
