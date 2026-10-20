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
function storageGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function storageSet(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} }

// Live updates: one shared broadcast channel. Any change pings it; listeners refetch.
let hbChannel = null;
function liveConnect(onPing) {
  hbChannel = sb.channel("hero-board-live", { config: { broadcast: { self: false } } });
  let t = null;
  hbChannel.on("broadcast", { event: "refresh" }, () => { clearTimeout(t); t = setTimeout(onPing, 400); });
  hbChannel.subscribe();
  setInterval(onPing, 30000); // safety net
  document.addEventListener("visibilitychange", () => { if (!document.hidden) onPing(); });
}
function livePing(what) {
  if (hbChannel) hbChannel.send({ type: "broadcast", event: "refresh", payload: { what } });
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
