// Hero Board admin — Updates (announcements with optional confidential video / document)
// Separate from hero weeks. Uses globals from admin.html / common.js (S, sb, $, esc, toast, …).

const UPD_TARGETS = [["all", "All stores"], ["region", "Regions"], ["city", "Cities"], ["area_manager", "Area managers"], ["rom", "ROMs"], ["stores", "Specific stores"]];
const UPD_OPEN_DAYS = 7;
const U = { list: [], sel: null, acks: {}, counts: {}, loaded: false, loading: null, failed: false, saving: false, editorFor: null };

// Loads the update list once; concurrent callers share the same request. Returns true on success.
function loadUpdates() {
  if (U.loading) return U.loading;
  U.loading = (async () => {
    try {
      const { data: s } = await sb.auth.getSession();
      if (!s.session) { adminSignedOut(); throw new Error("You've been signed out. Please sign in again."); }
      const { data, error } = await sb.from("hb_updates").select("*").order("created_at", { ascending: false });
      if (error) throw error;
      U.list = data || [];
      if (U.sel && !U.list.some(u => u.id === U.sel)) U.sel = null;
      if (!U.sel) U.sel = U.list[0]?.id || null;
      await loadUpdateAcks(ackIdsToLoad());
      U.loaded = true; U.failed = false;
      return true;
    } catch (e) { U.failed = errMsg(e); return false; }
    finally { U.loading = null; }
  })();
  return U.loading;
}
// Acknowledgements for the 10 most recent published updates plus whatever is selected (dashboard / editor).
function ackIdsToLoad() {
  const pub = U.list.filter(u => u.published).sort((a, b) => new Date(b.published_at) - new Date(a.published_at));
  return [...new Set([...pub.slice(0, 10).map(u => u.id), ...[U.sel, S.dashUpd].filter(id => pub.some(u => u.id === id))])];
}
async function loadUpdateAcks(ids) {
  if (!ids.length) return;
  // paged: Supabase returns at most 1000 rows per request
  const [a, c] = await Promise.all([
    fetchAll(() => sb.from("hb_update_store_acks").select("update_id,store_id,acked_at").in("update_id", ids).order("update_id").order("store_id")),
    fetchAll(() => sb.rpc("hb_admin_update_counts", { p_update_ids: ids })),
  ]);   // fetchAll throws on error, so a failed refresh keeps the previous numbers instead of showing 0
  ids.forEach(id => { U.acks[id] = {}; U.counts[id] = {}; });
  a.forEach(x => (U.acks[x.update_id][x.store_id] = x.acked_at));
  c.forEach(x => (U.counts[x.update_id][x.store_id] = x.n));
}
const updAcksKnown = u => !u.published || !!U.acks[u.id];

const updState = u => !u.published ? "draft" : new Date(u.closes_at) > new Date() ? "live" : "closed";
function updChip(u) {
  const st = updState(u);
  if (st === "draft") return `<span class="chip draft">Draft</span>`;
  if (st === "closed") return `<span class="chip draft">Closed</span>`;
  const d = Math.max(0, Math.ceil((new Date(u.closes_at) - Date.now()) / 864e5));
  return `<span class="chip live">Live · ${d} day${d === 1 ? "" : "s"} left</span>`;
}
function updTargetsStore(u, s) {
  if (u.target_kind === "all") return true;
  const v = u.target_values || [];
  return u.target_kind === "stores" ? v.includes(s.code) : v.includes(s[u.target_kind] || "");
}
function updAudienceText(u) {
  if (u.target_kind === "all") return "All stores";
  const v = u.target_values || [], label = UPD_TARGETS.find(t => t[0] === u.target_kind)?.[1] || "";
  if (u.target_kind === "stores") return `${v.length} store${v.length === 1 ? "" : "s"}`;
  return `${label}: ${v.map(titleCase).join(", ") || "none chosen"}`;
}
function updRows(u) {
  const pub = u.published_at ? new Date(u.published_at) : null, acks = U.acks[u.id] || {}, counts = U.counts[u.id] || {};
  return S.stores.filter(s => updTargetsStore(u, s)).map(s => {
    const ack = acks[s.id] || null, hours = ack && pub ? (new Date(ack) - pub) / 36e5 : null;
    const status = !ack ? "Pending" : hours <= 24 ? "On time" : "Late";
    const staffN = counts[s.id] || 0, total = u.require_staff ? (s.total_staff || 0) : 0;
    return { ...s, ack, hours, status, staffN, total, staffPct: total ? Math.min(100, pct(staffN, total)) : (staffN ? -1 : -2) };
  });
}

// ---------- list + editor ----------
function renderUpdateList() {
  $("#updList").innerHTML = U.list.length ? U.list.map(u => {
    const rows = u.published ? updRows(u) : [], acked = rows.filter(r => r.ack).length;
    return `<button class="week-item ${u.id === U.sel ? "on" : ""}" data-u="${u.id}">
      <div class="row" style="justify-content:space-between;flex-wrap:nowrap;gap:8px"><span class="wt">${esc(u.title)}</span>${updChip(u)}</div>
      <div class="muted small">${u.published ? `${fmtDate(dayInRiyadh(u.published_at))}${updAcksKnown(u) ? ` · ${acked}/${rows.length} stores acknowledged` : ""}` : "Not published yet"}</div>
    </button>`;
  }).join("") : `<p class="muted small">No updates yet.</p>`;
  $("#updList").querySelectorAll("[data-u]").forEach(b => b.onclick = async () => {
    if (U.saving) return toast("Please wait until the current save finishes", "bad");
    const id = +b.dataset.u; if (id === U.sel) return;
    U.sel = id;
    if (!U.acks[id] && U.list.find(u => u.id === id)?.published) { try { await loadUpdateAcks([id]); } catch {} }
    renderUpdates(true);
    if (window.innerWidth < 900) $("#updEditor").scrollIntoView({ behavior: "smooth", block: "start" });
  });
}
// Live refresh: only the list and the progress panel, never the edit form (keeps typed text and chosen files)
function refreshUpdateProgress() {
  if (!$("#updList")) return;
  renderUpdateList();
  const u = U.list.find(x => x.id === U.sel), box = $("#updProgress");
  if (u && u.published && box) { box.innerHTML = updProgressHTML(u); bindUpdProgress(u); }
}
// force = rebuild the edit form even if it already shows this update (otherwise typed text and chosen files are kept)
function renderUpdates(force) {
  if (!U.loaded) {
    if (U.failed) {
      $("#updList").innerHTML = "";
      $("#updEditor").innerHTML = `<div class="panel empty"><h2 style="margin-bottom:6px">Couldn't load updates</h2>${esc(U.failed)}<div style="margin-top:14px"><button class="btn" id="updRetry">Try again</button></div></div>`;
      $("#updRetry").onclick = () => { U.failed = false; renderUpdates(true); };
      return;
    }
    $("#updList").innerHTML = `<p class="muted small">Loading…</p>`;
    loadUpdates().then(() => renderUpdates(true));
    return;
  }
  renderUpdateList();
  const u = U.list.find(x => x.id === U.sel);
  if (!force && u && U.editorFor === u.id && $("#uTitle")) { refreshUpdateProgress(); return; }
  U.editorFor = u ? u.id : null;
  if (!u) { $("#updEditor").innerHTML = `<div class="panel empty"><h2 style="margin-bottom:6px">No updates yet</h2>Use <b>New update</b> to share a recipe change, training video or announcement with stores. It's separate from hero weeks.</div>`; return; }
  const st = updState(u);
  $("#updEditor").innerHTML = `
    <div class="panel">
      <div class="panel-head">
        <div class="row"><h2>${esc(u.title)}</h2>${updChip(u)}</div>
        <div class="row">
          ${st === "draft" ? `<button class="btn teal" id="uPub">Publish</button>` : st === "live" ? `<button class="btn ghost" id="uClose">Close now</button>` : `<button class="btn ghost" id="uReopen">Reopen for 7 days</button>`}
          <button class="btn danger" id="uDel">Delete</button>
        </div>
      </div>
      <p class="muted small" style="margin:-6px 0 14px">${st === "draft" ? `Stores can't see this until you publish it. It stays open for ${UPD_OPEN_DAYS} days.` : `Published ${fmtDateTime(u.published_at)} · ${st === "live" ? "closes" : "closed"} ${fmtDateTime(u.closes_at)} · ${esc(updAudienceText(u))}`}</p>
      <div class="field"><label for="uTitle">Title</label><input id="uTitle" maxlength="120" value="${esc(u.title)}"></div>
      <div class="field"><label for="uMsg">Message</label><textarea id="uMsg" rows="4" maxlength="2000" placeholder="What's changing, from when, and what stores must do">${esc(u.message)}</textarea></div>
      <div class="grid2">
        <div class="field"><label for="uKind">Who receives it</label><select id="uKind" ${st !== "draft" ? "disabled" : ""}>${UPD_TARGETS.map(([k, l]) => `<option value="${k}" ${u.target_kind === k ? "selected" : ""}>${l}</option>`).join("")}</select></div>
        <div class="field"><label>Who must confirm</label>
          <label class="check"><input type="checkbox" id="uStaff" ${u.require_staff ? "checked" : ""} ${st !== "draft" ? "disabled" : ""}> Store managers <b>and all staff</b></label>
          <div class="muted small">Untick for store managers only.</div></div>
      </div>
      <div id="uTargets"></div>
      <div class="field"><label>Confidential video and document <span class="muted small">(optional · private · removed automatically after 7 days)</span></label>
        <div class="media-edit" id="uMedia"></div>
        <div class="grid2" style="margin-top:8px">
          <div><label class="small muted" for="uVideo">Video (MP4, up to 200 MB)</label><input type="file" id="uVideo" accept="video/mp4,video/quicktime,video/webm,.mp4,.mov,.m4v,.webm"></div>
          <div><label class="small muted" for="uPdf">Document (PDF; save PowerPoint as PDF first)</label><input type="file" id="uPdf" accept="application/pdf,.pdf"></div>
        </div></div>
      <button class="btn" id="uSave">Save changes</button>
      ${st !== "draft" ? `<span class="muted small" style="margin-left:10px">Changes show to stores straight away.</span>` : ""}
    </div>
    <div id="updProgress">${u.published ? updProgressHTML(u) : ""}</div>`;
  updTargetsUI(u, st !== "draft");
  updMediaUI(u);
  if (u.published) bindUpdProgress(u);

  $("#uSave").onclick = () => saveUpdate(u);
  if ($("#uPub")) $("#uPub").onclick = async () => {
    if (U.saving) return;
    $("#uPub").disabled = true;
    if (!(await saveUpdate(u, true))) { if ($("#uPub")) $("#uPub").disabled = false; return; }
    const fresh = U.list.find(x => x.id === u.id), n = S.stores.filter(s => updTargetsStore(fresh, s)).length;
    if (!n) return toast("No stores match who receives it", "bad");
    if (!confirm(`Publish "${fresh.title}" to ${n} store${n === 1 ? "" : "s"}? It stays open for ${UPD_OPEN_DAYS} days.`)) return;
    const now = new Date();
    try { await mustChange(sb.from("hb_updates").update({ published: true, published_at: now.toISOString(), closes_at: new Date(+now + UPD_OPEN_DAYS * 864e5).toISOString() }).eq("id", u.id), "publish"); }
    catch (e) { return toast(errMsg(e), "bad"); }
    toast("Published. Stores can see it now."); livePing(["hb-all"], "update"); await loadUpdates(); renderUpdates(true);
  };
  if ($("#uClose")) $("#uClose").onclick = async () => {
    if (!confirm("Close this update now? Stores will stop seeing it. Acknowledgements are kept.")) return;
    try { await mustChange(sb.from("hb_updates").update({ closes_at: new Date().toISOString() }).eq("id", u.id), "close it"); }
    catch (e) { return toast(errMsg(e), "bad"); }
    toast("Closed"); livePing(["hb-all"], "update"); await loadUpdates(); renderUpdates(true);
  };
  if ($("#uReopen")) $("#uReopen").onclick = async () => {
    try { await mustChange(sb.from("hb_updates").update({ closes_at: new Date(Date.now() + UPD_OPEN_DAYS * 864e5).toISOString() }).eq("id", u.id), "reopen it"); }
    catch (e) { return toast(errMsg(e), "bad"); }
    toast(`Open again for ${UPD_OPEN_DAYS} days. Video and document files may already have been removed.`); livePing(["hb-all"], "update"); await loadUpdates(); renderUpdates(true);
  };
  $("#uDel").onclick = async () => {
    if (!confirm(`Delete "${u.title}" with its acknowledgements? This can't be undone.`)) return;
    const keys = (u.media || []).map(m => m.key);
    try { await mustChange(sb.from("hb_updates").delete().eq("id", u.id), "delete it"); }
    catch (e) { return toast(errMsg(e), "bad"); }
    if (keys.length) mediaCall({ action: "delete", keys }).catch(() => {});
    U.sel = null; toast("Update deleted"); livePing(["hb-all"], "update"); await loadUpdates(); renderUpdates(true);
  };
}

function updTargetsUI(u, locked) {
  const draw = () => {
    const kind = $("#uKind").value;
    if (kind === "all") { $("#uTargets").innerHTML = `<p class="muted small" style="margin:-4px 0 14px">Goes to all ${S.stores.length} stores.</p>`; return; }
    const chosen = new Set(kind === u.target_kind ? (u.target_values || []) : []);
    const opts = kind === "stores" ? S.stores.map(s => [s.code, `${s.code} · ${s.name}`])
      : [...new Set(S.stores.map(s => s[kind]).filter(Boolean))].sort().map(v => [v, titleCase(v)]);
    $("#uTargets").innerHTML = `
      <div class="field"><label>Choose ${esc(UPD_TARGETS.find(t => t[0] === kind)[1].toLowerCase())} <span class="muted small" id="uTCount"></span></label>
        ${kind === "stores" ? `<input id="uTSearch" type="search" placeholder="Search stores…" style="margin-bottom:8px">` : ""}
        <div class="target-list" id="uTList">${opts.map(([v, l]) => `<label class="check"><input type="checkbox" value="${esc(v)}" ${chosen.has(v) ? "checked" : ""} ${locked ? "disabled" : ""}> ${esc(l)}</label>`).join("")}</div></div>`;
    const count = () => {
      const vals = [...$("#uTList").querySelectorAll("input:checked")].map(i => i.value);
      const n = S.stores.filter(s => updTargetsStore({ target_kind: kind, target_values: vals }, s)).length;
      $("#uTCount").textContent = `· ${n} store${n === 1 ? "" : "s"}`;
    };
    $("#uTList").onchange = count; count();
    if ($("#uTSearch")) $("#uTSearch").oninput = e => { const q = e.target.value.toLowerCase(); $("#uTList").querySelectorAll("label").forEach(l => l.style.display = l.textContent.toLowerCase().includes(q) ? "" : "none"); };
  };
  $("#uKind").onchange = draw; draw();
}

// media editing state lives on the DOM element between renders of the same update
function updMediaUI(u) {
  const box = $("#uMedia");
  box._media = [...(u.media || [])]; box._removed = []; box._video = null; box._pdf = null;
  const draw = () => {
    const m = box._media, rows = [
      ...m.filter(x => x.kind === "video").map(x => `<div class="mi">${ICON.play}<span>${esc(x.name || "Video")} · ${((x.size || 0) / 1048576).toFixed(1)} MB</span><button class="icon-btn" data-rm="video" title="Remove video" aria-label="Remove video">${ICON.trash}</button></div>`),
      ...(m.some(x => x.kind === "page") ? [`<div class="mi">${ICON.doc}<span>${esc(m.find(x => x.kind === "page").name || "Document")} · ${m.filter(x => x.kind === "page").length} page(s)</span><button class="icon-btn" data-rm="page" title="Remove document" aria-label="Remove document">${ICON.trash}</button></div>`] : []),
      ...(box._video ? [`<div class="mi">${ICON.play}<span>New: ${esc(box._video.name)} · ${(box._video.size / 1048576).toFixed(1)} MB</span></div>`] : []),
      ...(box._pdf ? [`<div class="mi">${ICON.doc}<span>New: ${esc(box._pdf.name)}</span></div>`] : []),
    ];
    box.innerHTML = rows.join("") || `<span class="muted small">No video or document.</span>`;
    box.querySelectorAll("[data-rm]").forEach(b => b.onclick = () => { box._media = box._media.filter(x => { if (x.kind === b.dataset.rm) { box._removed.push(x.key); return false; } return true; }); draw(); });
  };
  draw();
  $("#uVideo").onchange = e => { const f = e.target.files[0] || null; if (f && f.size > 200 * 1048576) { toast("Video is larger than 200 MB", "bad"); e.target.value = ""; return; } box._video = f; draw(); };
  $("#uPdf").onchange = e => { box._pdf = e.target.files[0] || null; draw(); };
}

async function saveUpdate(u, quiet) {
  if (U.saving) { toast("Already saving, please wait", "bad"); return false; }
  // Read everything from the form NOW: uploads can take minutes and the screen may change meanwhile.
  const title = $("#uTitle").value.trim(); if (!title) { toast("Enter a title", "bad"); return false; }
  const message = $("#uMsg").value.trim(), kind = $("#uKind").value, requireStaff = $("#uStaff").checked;
  const values = kind === "all" ? [] : [...($("#uTList")?.querySelectorAll("input:checked") || [])].map(i => i.value);
  if (!u.published && kind !== "all" && !values.length) { toast("Choose at least one under “Who receives it”", "bad"); return false; }
  const btn = $("#uSave"), box = $("#uMedia"), video = box._video, pdf = box._pdf;
  const say = t => { if (document.body.contains(btn)) btn.textContent = t; };
  U.saving = true; btn.disabled = true;
  try {
    let media = [...box._media]; const removed = [...box._removed];
    if (video) {
      removed.push(...media.filter(x => x.kind === "video").map(x => x.key)); media = media.filter(x => x.kind !== "video");
      const v = video, ext = (v.name.split(".").pop() || "mp4").toLowerCase();
      media.push({ kind: "video", key: await uploadMedia(v, { update_id: u.id }, ["mp4", "mov", "webm", "m4v"].includes(ext) ? ext : "mp4", null, p => say(`Uploading video… ${p}%`)), type: v.type || "video/mp4", size: v.size, name: v.name });
    }
    if (pdf) {
      say("Reading document…");
      const pages = await pdfToImages(pdf);
      removed.push(...media.filter(x => x.kind === "page").map(x => x.key)); media = media.filter(x => x.kind !== "page");
      for (let i = 0; i < pages.length; i++) {
        say(`Uploading page ${i + 1} of ${pages.length}…`);
        media.push({ kind: "page", key: await uploadMedia(pages[i].blob, { update_id: u.id }, "jpg", i + 1), page: i + 1, pages: pages.length, w: pages[i].w, h: pages[i].h, name: pdf.name });
      }
    }
    say("Saving…");
    const row = { title, message, media };
    if (!u.published) { row.target_kind = kind; row.require_staff = requireStaff; row.target_values = values; }
    await mustChange(sb.from("hb_updates").update(row).eq("id", u.id), "save");
    if (removed.length) mediaCall({ action: "delete", keys: removed }).catch(() => {});
    if (!quiet) toast("Saved");
    if (u.published) livePing(["hb-all"], "update");
    U.saving = false;
    await loadUpdates(); if (U.sel === u.id) renderUpdates(true); else renderUpdateList();
    return true;
  } catch (e) { toast(errMsg(e), "bad"); return false; }
  finally { U.saving = false; if (document.body.contains(btn)) { btn.disabled = false; btn.textContent = "Save changes"; } }
}

$("#newUpdBtn").onclick = () => {
  $("#modal").innerHTML = `
    <div class="panel-head"><h2>New update</h2><button class="x" onclick="closeAll()">×</button></div>
    <div class="field"><label for="nuTitle">Title</label><input id="nuTitle" maxlength="120" placeholder="e.g. Matcha Mix – new long-life milk from 22 Nov"></div>
    <p class="muted small">Next you'll add the message, video or document, and choose who receives it.</p>
    <button class="btn block" id="nuSave">Create update</button>`;
  $("#overlay").classList.add("show"); $("#modal").classList.add("show"); $("#nuTitle").focus();
  $("#nuSave").onclick = async () => {
    const title = $("#nuTitle").value.trim(); if (!title) return toast("Enter a title", "bad");
    const b = $("#nuSave"); if (b.disabled) return; b.disabled = true; b.textContent = "Creating…";
    const { data, error } = await sb.from("hb_updates").insert({ title }).select().single();
    if (error) { b.disabled = false; b.textContent = "Create update"; if (error.code === "42501" || /row-level security|JWT/i.test(error.message || "")) adminSignedOut(); return toast(error.code === "42501" ? "You've been signed out. Please sign in again." : errMsg(error), "bad"); }
    closeAll(); U.sel = data.id; await loadUpdates(); renderUpdates(true);
  };
};

// ---------- progress summary (full tracking lives in Dashboard → Updates) ----------
function updProgressHTML(u) {
  const rows = updRows(u), N = rows.length, acked = rows.filter(r => r.ack).length;
  const wt = rows.filter(r => r.total > 0), aware = wt.reduce((a, r) => a + Math.min(r.staffN, r.total), 0), total = wt.reduce((a, r) => a + r.total, 0);
  return `<div class="panel row" style="justify-content:space-between;gap:16px">
    <div class="row" style="gap:28px">
      <div><div class="muted small">Managers acknowledged</div><div style="font-size:24px;font-weight:700">${acked}<span class="muted" style="font-size:14px"> / ${N}</span></div></div>
      ${u.require_staff ? `<div><div class="muted small">Staff aware</div><div style="font-size:24px;font-weight:700">${aware}<span class="muted" style="font-size:14px"> / ${total || "—"}</span></div></div>` : `<div class="muted small">Managers only</div>`}
      <div><div class="muted small">Not acknowledged</div><div style="font-size:24px;font-weight:700;color:${N - acked ? "var(--red)" : "var(--green)"}">${N - acked}</div></div>
    </div>
    <button class="btn" data-open-dash="${u.id}">${ICON.dash}Open in Dashboard</button></div>`;
}
function bindUpdProgress(u) {
  const b = document.querySelector(`[data-open-dash="${u.id}"]`);
  if (b) b.onclick = () => openUpdateInDashboard(u.id);
}
// Excel report for an update: same format as hero weeks, follows the Dashboard's area filters
async function exportUpdateReport(u) {
  const staff = await fetchAll(() => sb.from("hb_update_staff_acks").select("store_id,employee_id,staff_name,acked_at").eq("update_id", u.id).order("acked_at").order("id"));
  const rows = updRows(u).filter(inArea);
  const parts = AREA.filter(([k]) => S.area[k]).map(([k, , l]) => `${l}: ${S.area[k] === NONE ? "not set" : titleCase(S.area[k])}`);
  await buildWeekReport({
    week: { title: u.title, start_date: dayInRiyadh(u.published_at), end_date: dayInRiyadh(u.closes_at), published_at: u.published_at },
    rows, staff: staff || [], products: [], trend: [], update: u, managersOnly: !u.require_staff,
    scope: `${parts.length ? parts.join(" · ") + " · " : ""}${updAudienceText(u)} (${rows.length} stores)`,
    scopeShort: AREA.filter(([k]) => S.area[k] && S.area[k] !== NONE).map(([k]) => titleCase(S.area[k])).join(", "),
  });
  toast("Report downloaded");
}

// "2026-11-20" for a timestamp, in Riyadh time (not UTC)
function dayInRiyadh(ts) { return ts ? new Date(ts).toLocaleDateString("en-CA", { timeZone: TZ }) : ""; }
