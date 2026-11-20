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

// Hero weeks created from Nov 2026 use a fixed daypart layout: Morning drink + food, Evening drink + sweet.
const DAYPARTS = [["morning", "Morning", "☀"], ["evening", "Evening", "☾"]];
const SLOTS = [["am_drink", "morning", "Hero drink"], ["am_food", "morning", "Hero food"], ["pm_drink", "evening", "Hero drink"], ["pm_sweet", "evening", "Hero sweet"]];
const slotInfo = s => SLOTS.find(x => x[0] === s);
const slotLabel = s => { const x = slotInfo(s); return x ? `${DAYPARTS.find(d => d[0] === x[1])[1]} · ${x[2]}` : ""; };
// ---------- confidential media (video / document pages in private Cloudflare R2) ----------
// Each page sets HB_MEDIA = { auth: {store_token} | {week_token, link_key} | {}, label: "watermark text" }
let HB_MEDIA = { auth: {}, label: "" };
const HB_PRODUCTS = new Map();
function mediaChips(p, key) {
  const m = p.media || [];
  if (!m.length) return "";
  key = String(key ?? p.id);
  HB_PRODUCTS.set(key, p);
  const v = m.some(x => x.kind === "video"), pages = m.filter(x => x.kind === "page").length;
  return `<div class="media-row">
    ${v ? `<button type="button" class="media-btn" data-media="${esc(key)}" data-kind="video">${ICON.play}Watch video</button>` : ""}
    ${pages ? `<button type="button" class="media-btn" data-media="${esc(key)}" data-kind="page">${ICON.doc}Document${pages > 1 ? ` · ${pages} pages` : ""}</button>` : ""}
    <span class="media-lock" title="Confidential: for staff only, do not share">${ICON.lock}Confidential</span></div>`;
}
async function mediaCall(body) {
  const { data, error } = await sb.functions.invoke("hb-media", { body });
  if (error) {
    let msg = error.message;
    try { const j = await error.context.json(); msg = j.error || msg; } catch {}
    throw new Error(msg === "R2_NOT_CONFIGURED" ? "Media storage isn't set up yet." : msg === "SESSION_EXPIRED" ? "SESSION_EXPIRED" : msg === "LINK_INVALID" ? "LINK_INVALID" : msg);
  }
  return data;
}
function closeMedia() { const v = document.getElementById("mediaView"); if (v) { v.querySelectorAll("video").forEach(x => { x.pause(); x.removeAttribute("src"); x.load(); }); v.remove(); } document.body.classList.remove("media-open"); }
async function openMedia(p, kind) {
  closeMedia();
  const items = (p.media || []).filter(x => x.kind === kind).sort((a, b) => (a.page || 0) - (b.page || 0));
  if (!items.length) return;
  const wm = esc(`${HB_MEDIA.label ? HB_MEDIA.label + " · " : ""}${new Date().toLocaleDateString("en-GB", { timeZone: TZ })} · Confidential`);
  const box = document.createElement("div");
  box.id = "mediaView"; box.className = "media-view"; box.setAttribute("role", "dialog"); box.setAttribute("aria-label", p.name || p.title || "Media");
  box.innerHTML = `<div class="mv-head"><div><b>${esc(p.name || p.title)}</b><div class="mv-sub">${kind === "video" ? "Video" : "Document"} · Confidential, do not share</div></div><button class="mv-x" aria-label="Close">×</button></div>
    <div class="mv-body"><p class="mv-msg">Loading…</p></div>`;
  box.addEventListener("contextmenu", e => e.preventDefault());
  box.querySelector(".mv-x").onclick = closeMedia;
  document.body.appendChild(box); document.body.classList.add("media-open");
  let urls = {};
  try { urls = (await mediaCall({ action: "view", keys: items.map(x => x.key), ...HB_MEDIA.auth })).urls || {}; }
  catch (e) { box.querySelector(".mv-body").innerHTML = `<p class="mv-msg">${esc(errMsg(e))}</p>`; return; }
  if (!document.body.contains(box)) return;
  const mark = `<div class="mv-wm" aria-hidden="true">${Array.from({ length: 14 }, () => `<span>${wm}</span>`).join("")}</div>`;
  const gone = `<p class="mv-msg">This file is no longer available. Media is removed 7 days after upload.</p>`;
  const body = box.querySelector(".mv-body");
  if (kind === "video") {
    const u = urls[items[0].key];
    body.innerHTML = u ? `<div class="mv-frame"><video controls playsinline autoplay preload="metadata" controlslist="nodownload noremoteplayback noplaybackrate" disablepictureinpicture disableremoteplayback src="${esc(u)}"></video>${mark}</div>` : gone;
    const v = body.querySelector("video"); if (v) v.onerror = () => (body.innerHTML = gone);
  } else {
    body.innerHTML = items.map(x => urls[x.key] ? `<div class="mv-frame mv-page"><img src="${esc(urls[x.key])}" alt="Page ${x.page || 1}" draggable="false">${mark}</div>` : "").join("") || gone;
    body.querySelectorAll("img").forEach(img => img.onerror = () => img.closest(".mv-page").outerHTML = gone);
  }
}
document.addEventListener("click", e => {
  const b = e.target.closest && e.target.closest("[data-media]");
  if (b) { e.preventDefault(); openMedia(HB_PRODUCTS.get(b.dataset.media) || {}, b.dataset.kind); }
});
document.addEventListener("keydown", e => { if (e.key === "Escape" && document.getElementById("mediaView")) closeMedia(); });

function productCard(p, tag) {
  return `
    <article class="pcard">
      <div class="pimg">${p.photo_url ? `<img src="${esc(p.photo_url)}" alt="${esc(p.name)}" loading="lazy">` : `<span>½M</span>`}</div>
      <div class="pbody">
        ${tag ? `<div class="ptag">${esc(tag)}</div>` : ""}
        <h3>${esc(p.name)}</h3>
        ${p.price != null ? `<div class="price">${fmtPrice(p.price)}</div>` : ""}
        ${p.description ? `<p>${esc(p.description)}</p>` : ""}
        ${mediaChips(p)}
      </div>
    </article>`;
}
function productCards(products) {
  if (!products.length) return `<p class="muted">No hero products added yet.</p>`;
  if (!products.some(p => p.slot)) return `<div class="cards">${products.map(p => productCard(p)).join("")}</div>`;
  return `<div class="dayparts">${DAYPARTS.map(([dp, label, icon]) => {
    const list = SLOTS.filter(s => s[1] === dp).flatMap(([slot, , tag]) => products.filter(p => p.slot === slot).map(p => productCard(p, tag)));
    return list.length ? `<section class="daypart"><h3 class="dp-head"><span class="dp-icon ${dp}" aria-hidden="true">${icon}</span>${label}</h3><div class="cards">${list.join("")}</div></section>` : "";
  }).join("")}</div>`;
}

// ---------- updates (store + staff pages) ----------
function updateCard(u, extra = "") {
  const d = Math.max(0, Math.ceil((new Date(u.closes_at) - Date.now()) / 864e5));
  return `<article class="upd-card">
    <div class="upd-top"><span class="upd-icon">${ICON.bell}</span><div style="flex:1;min-width:0"><h3>${esc(u.title)}</h3>
      <div class="muted small">${fmtDateTime(u.published_at)} · open ${d} more day${d === 1 ? "" : "s"}</div></div></div>
    ${u.message ? `<p class="upd-msg">${esc(u.message)}</p>` : ""}
    ${mediaChips(u, "u" + u.id)}
    ${extra}
  </article>`;
}
