// Hero Board admin — Updates (announcements with optional confidential video / document)
// Separate from hero weeks. Uses globals from admin.html / common.js (S, sb, $, esc, toast, …).

const UPD_TARGETS = [["all", "All stores"], ["region", "Regions"], ["city", "Cities"], ["area_manager", "Area managers"], ["rom", "ROMs"], ["stores", "Specific stores"]];
const UPD_OPEN_DAYS = 7;
const U = { list: [], sel: null, acks: {}, counts: {}, loaded: false, q: "", f: "all", am: "" };

async function loadUpdates() {
  const { data, error } = await sb.from("hb_updates").select("*").order("created_at", { ascending: false });
  if (error) { toast(errMsg(error), "bad"); return; }
  U.list = data || [];
  U.loaded = true;
  if (U.sel && !U.list.some(u => u.id === U.sel)) U.sel = null;
  if (!U.sel) U.sel = U.list[0]?.id || null;
  await loadUpdateAcks(U.list.filter(u => u.published).map(u => u.id));
}
async function loadUpdateAcks(ids) {
  if (!ids.length) return;
  const [a, c] = await Promise.all([
    sb.from("hb_update_store_acks").select("update_id,store_id,acked_at").in("update_id", ids),
    sb.rpc("hb_admin_update_counts", { p_update_ids: ids }),
  ]);
  ids.forEach(id => { U.acks[id] = {}; U.counts[id] = {}; });
  (a.data || []).forEach(x => (U.acks[x.update_id][x.store_id] = x.acked_at));
  (c.data || []).forEach(x => (U.counts[x.update_id][x.store_id] = x.n));
}

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
function renderUpdates() {
  if (!U.loaded) { $("#updList").innerHTML = `<p class="muted small">Loading…</p>`; loadUpdates().then(renderUpdates); return; }
  $("#updList").innerHTML = U.list.length ? U.list.map(u => {
    const rows = u.published ? updRows(u) : [], acked = rows.filter(r => r.ack).length;
    return `<button class="week-item ${u.id === U.sel ? "on" : ""}" data-u="${u.id}">
      <div class="row" style="justify-content:space-between;flex-wrap:nowrap;gap:8px"><span class="wt">${esc(u.title)}</span>${updChip(u)}</div>
      <div class="muted small">${u.published ? `${fmtDate((u.published_at || "").slice(0, 10))} · ${acked}/${rows.length} stores acknowledged` : "Not published yet"}</div>
    </button>`;
  }).join("") : `<p class="muted small">No updates yet.</p>`;
  $("#updList").querySelectorAll("[data-u]").forEach(b => b.onclick = () => { U.sel = +b.dataset.u; renderUpdates(); });
  const u = U.list.find(x => x.id === U.sel);
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
    ${u.published ? updProgressHTML(u) : ""}`;
  updTargetsUI(u, st !== "draft");
  updMediaUI(u);
  if (u.published) bindUpdProgress(u);

  $("#uSave").onclick = () => saveUpdate(u);
  if ($("#uPub")) $("#uPub").onclick = async () => {
    if (!(await saveUpdate(u, true))) return;
    const fresh = U.list.find(x => x.id === u.id), n = S.stores.filter(s => updTargetsStore(fresh, s)).length;
    if (!n) return toast("No stores match who receives it", "bad");
    if (!confirm(`Publish "${fresh.title}" to ${n} store${n === 1 ? "" : "s"}? It stays open for ${UPD_OPEN_DAYS} days.`)) return;
    const now = new Date();
    const { error } = await sb.from("hb_updates").update({ published: true, published_at: now.toISOString(), closes_at: new Date(+now + UPD_OPEN_DAYS * 864e5).toISOString() }).eq("id", u.id);
    if (error) return toast(errMsg(error), "bad");
    toast("Published. Stores can see it now."); livePing(["hb-all"], "update"); await loadUpdates(); renderUpdates();
  };
  if ($("#uClose")) $("#uClose").onclick = async () => {
    if (!confirm("Close this update now? Stores will stop seeing it. Acknowledgements are kept.")) return;
    const { error } = await sb.from("hb_updates").update({ closes_at: new Date().toISOString() }).eq("id", u.id);
    if (error) return toast(errMsg(error), "bad");
    toast("Closed"); livePing(["hb-all"], "update"); await loadUpdates(); renderUpdates();
  };
  if ($("#uReopen")) $("#uReopen").onclick = async () => {
    const { error } = await sb.from("hb_updates").update({ closes_at: new Date(Date.now() + UPD_OPEN_DAYS * 864e5).toISOString() }).eq("id", u.id);
    if (error) return toast(errMsg(error), "bad");
    toast(`Open again for ${UPD_OPEN_DAYS} days. Video and document files may already have been removed.`); livePing(["hb-all"], "update"); await loadUpdates(); renderUpdates();
  };
  $("#uDel").onclick = async () => {
    if (!confirm(`Delete "${u.title}" with its acknowledgements? This can't be undone.`)) return;
    const keys = (u.media || []).map(m => m.key);
    const { error } = await sb.from("hb_updates").delete().eq("id", u.id);
    if (error) return toast(errMsg(error), "bad");
    if (keys.length) mediaCall({ action: "delete", keys }).catch(() => {});
    U.sel = null; toast("Update deleted"); livePing(["hb-all"], "update"); await loadUpdates(); renderUpdates();
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
  const title = $("#uTitle").value.trim(); if (!title) { toast("Enter a title", "bad"); return false; }
  const btn = $("#uSave"), box = $("#uMedia"), say = t => (btn.textContent = t);
  btn.disabled = true;
  try {
    let media = [...box._media]; const removed = [...box._removed];
    if (box._video) {
      removed.push(...media.filter(x => x.kind === "video").map(x => x.key)); media = media.filter(x => x.kind !== "video");
      const v = box._video, ext = (v.name.split(".").pop() || "mp4").toLowerCase();
      media.push({ kind: "video", key: await uploadMedia(v, { update_id: u.id }, ["mp4", "mov", "webm", "m4v"].includes(ext) ? ext : "mp4", null, p => say(`Uploading video… ${p}%`)), type: v.type || "video/mp4", size: v.size, name: v.name });
    }
    if (box._pdf) {
      say("Reading document…");
      const pages = await pdfToImages(box._pdf);
      removed.push(...media.filter(x => x.kind === "page").map(x => x.key)); media = media.filter(x => x.kind !== "page");
      for (let i = 0; i < pages.length; i++) {
        say(`Uploading page ${i + 1} of ${pages.length}…`);
        media.push({ kind: "page", key: await uploadMedia(pages[i].blob, { update_id: u.id }, "jpg", i + 1), page: i + 1, pages: pages.length, w: pages[i].w, h: pages[i].h, name: box._pdf.name });
      }
    }
    say("Saving…");
    const row = { title, message: $("#uMsg").value.trim(), media };
    if (!u.published) {
      row.target_kind = $("#uKind").value; row.require_staff = $("#uStaff").checked;
      row.target_values = row.target_kind === "all" ? [] : [...$("#uTList").querySelectorAll("input:checked")].map(i => i.value);
      if (row.target_kind !== "all" && !row.target_values.length) throw new Error("Choose at least one under “Who receives it”");
    }
    const { error } = await sb.from("hb_updates").update(row).eq("id", u.id);
    if (error) throw error;
    if (removed.length) mediaCall({ action: "delete", keys: removed }).catch(() => {});
    if (!quiet) toast("Saved");
    if (u.published) livePing(["hb-all"], "update");
    await loadUpdates(); renderUpdates();
    return true;
  } catch (e) { toast(errMsg(e), "bad"); return false; }
  finally { if (document.body.contains(btn)) { btn.disabled = false; btn.textContent = "Save changes"; } }
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
    const { data, error } = await sb.from("hb_updates").insert({ title }).select().single();
    if (error) return toast(errMsg(error), "bad");
    closeAll(); U.sel = data.id; await loadUpdates(); renderUpdates();
  };
};

// ---------- progress (published updates) ----------
function updProgressHTML(u) {
  const rows = updRows(u), N = rows.length, acked = rows.filter(r => r.ack).length, onTime = rows.filter(r => r.status === "On time").length;
  const wt = rows.filter(r => r.total > 0), aware = wt.reduce((a, r) => a + Math.min(r.staffN, r.total), 0), total = wt.reduce((a, r) => a + r.total, 0);
  const ams = [...new Set(rows.map(r => r.area_manager).filter(Boolean))].sort();
  return `
    <div class="kpis" style="grid-template-columns:repeat(${u.require_staff ? 3 : 2},minmax(0,1fr))">
      <div class="kpi"><div class="k-label"><span class="dot" style="background:var(--teal)"></span>Managers acknowledged</div><div class="k-value">${acked}<small> / ${N}</small></div>
        <div class="meter"><i style="width:${pct(acked, N)}%"></i></div><div class="k-foot">${pct(acked, N)}% · ${onTime} within 24 h</div></div>
      ${u.require_staff ? `<div class="kpi"><div class="k-label"><span class="dot" style="background:var(--tan)"></span>Staff aware</div><div class="k-value">${aware}<small> / ${total || "—"}</small></div>
        <div class="meter tan"><i style="width:${pct(aware, total)}%"></i></div><div class="k-foot">${total ? pct(aware, total) + "% of staff" : "Stores haven't set staff count"}</div></div>` : ""}
      <div class="kpi"><div class="k-label"><span class="dot" style="background:var(--red)"></span>Not acknowledged</div><div class="k-value" style="color:${N - acked ? "var(--red)" : "var(--green)"}">${N - acked}</div><div class="k-foot">${N - acked ? "Stores still pending" : "Every store has acknowledged"}</div></div>
    </div>
    <div class="panel">
      <div class="panel-head"><h2>Stores</h2>
        <div class="filters" style="flex:1;justify-content:flex-end">
          <input id="upSearch" type="search" placeholder="Search store…" value="${esc(U.q)}">
          <select id="upFilter"><option value="all">All stores</option><option value="Pending" ${U.f === "Pending" ? "selected" : ""}>Not acknowledged</option><option value="ack" ${U.f === "ack" ? "selected" : ""}>Acknowledged</option>${u.require_staff ? `<option value="staff" ${U.f === "staff" ? "selected" : ""}>Staff not complete</option>` : ""}</select>
          <select id="upAm"><option value="">All area managers</option>${ams.map(a => `<option value="${esc(a)}" ${U.am === a ? "selected" : ""}>${esc(titleCase(a))}</option>`).join("")}</select>
        </div></div>
      <div class="row" style="margin:-4px 0 12px;gap:8px"><button class="btn ghost sm" id="upCopy">${ICON.copy}Copy follow-up for WhatsApp</button><button class="btn ghost sm" id="upExport">${ICON.down}Export Excel</button></div>
      <div class="tbl-wrap"><table><thead><tr><th>Store ID</th><th>Store</th><th>Manager</th><th class="hm">Acknowledged</th>${u.require_staff ? "<th>Staff aware</th>" : ""}</tr></thead><tbody id="upRows"></tbody></table></div>
    </div>`;
}
function bindUpdProgress(u) {
  const draw = () => {
    const q = U.q.toLowerCase(), order = { Pending: 0, Late: 1, "On time": 2 };
    const list = updRows(u).filter(r => (!q || r.name.toLowerCase().includes(q) || r.code.toLowerCase().includes(q)) && (!U.am || r.area_manager === U.am) &&
      (U.f === "all" || (U.f === "Pending" ? !r.ack : U.f === "ack" ? !!r.ack : (r.ack && (r.total === 0 || r.staffN < r.total)))))
      .sort((a, b) => order[a.status] - order[b.status] || a.code.localeCompare(b.code));
    $("#upRows").innerHTML = list.length ? list.map(r => `<tr>
      <td class="mono">${esc(r.code)}</td><td><b>${esc(r.name)}</b>${r.area_manager || r.city ? `<div class="muted small">${[r.area_manager, r.city].filter(Boolean).map(v => esc(titleCase(v))).join(" · ")}</div>` : ""}</td>
      <td>${chip(r.status)}</td><td class="hm nowrap">${r.ack ? fmtDateTime(r.ack) : `<span class="muted">—</span>`}</td>
      ${u.require_staff ? `<td>${r.total ? `<div class="mini-meter"><div class="meter tan"><i style="width:${r.staffPct}%"></i></div><b>${r.staffN}/${r.total}</b></div>` : r.staffN ? `<b>${r.staffN}</b>` : `<span class="muted">—</span>`}</td>` : ""}</tr>`).join("")
      : `<tr><td colspan="5" class="empty">No stores match.</td></tr>`;
  };
  $("#upSearch").oninput = e => { U.q = e.target.value; draw(); };
  $("#upFilter").onchange = e => { U.f = e.target.value; draw(); };
  $("#upAm").onchange = e => { U.am = e.target.value; draw(); };
  draw();
  $("#upCopy").onclick = () => {
    const rows = updRows(u).filter(r => !U.am || r.area_manager === U.am);
    const pend = rows.filter(r => !r.ack), low = u.require_staff ? rows.filter(r => r.ack && r.total > 0 && r.staffN < r.total) : [];
    const lines = [`*Hero Board update – ${u.title}*`];
    if (pend.length) lines.push("", "Not acknowledged yet:", ...pend.map(r => `• ${r.name} (${r.code})`));
    if (low.length) lines.push("", "Staff not complete:", ...low.map(r => `• ${r.name} – ${r.staffN}/${r.total} staff`));
    if (lines.length === 1) lines.push("", "All stores done ✅");
    navigator.clipboard.writeText(lines.join("\n")).then(() => toast("Copied. Paste it in WhatsApp."));
  };
  $("#upExport").onclick = async () => {
    const b = $("#upExport"), label = b.innerHTML; b.disabled = true; b.innerHTML = ICON.down + "Preparing…";
    try {
      const { data: staff, error } = await sb.from("hb_update_staff_acks").select("store_id,employee_id,staff_name,acked_at").eq("update_id", u.id).order("acked_at").limit(10000);
      if (error) throw error;
      const rows = updRows(u).filter(r => !U.am || r.area_manager === U.am);
      await buildWeekReport({
        week: { title: u.title, start_date: u.published_at.slice(0, 10), end_date: u.closes_at.slice(0, 10), published_at: u.published_at },
        rows, staff: staff || [], products: [], trend: [], update: u, managersOnly: !u.require_staff,
        scope: `${U.am ? "Area manager: " + titleCase(U.am) + " · " : ""}${updAudienceText(u)} (${rows.length} stores)`, scopeShort: U.am ? titleCase(U.am) : "",
      });
      toast("Report downloaded");
    } catch (e) { toast(errMsg(e), "bad"); }
    finally { b.disabled = false; b.innerHTML = label; }
  };
}
