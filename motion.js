// Hero Board motion layer — same feel as Trackit: transform/opacity only, < 300ms, calm on repeat actions.
(function () {
  const mq = q => window.matchMedia && matchMedia(q).matches;
  const calm = mq("(prefers-reduced-motion: reduce)");
  const finePointer = mq("(hover: hover) and (pointer: fine)");

  // ambient background
  const amb = document.createElement("div"); amb.className = "ambient"; amb.setAttribute("aria-hidden", "true");
  amb.innerHTML = "<i></i><i></i><i></i>"; document.body.prepend(amb);

  // splash
  window.hideSplash = function () {
    const s = document.getElementById("splash"); if (!s || s.dataset.out) return;
    s.dataset.out = "1"; s.classList.add("out"); setTimeout(() => s.remove(), 400);
  };
  setTimeout(window.hideSplash, 12000);

  // sliding nav indicator (FLIP, transform only)
  const last = {};
  window.slideIndicator = function (container, key) {
    if (!container) return;
    const active = container.querySelector("button.on");
    let ind = container.querySelector(":scope > .ind");
    if (!active || !active.offsetWidth) { if (ind) ind.style.opacity = 0; return; }
    if (!ind) { ind = document.createElement("span"); ind.className = "ind"; container.prepend(ind); }
    const box = { x: active.offsetLeft, y: active.offsetTop, w: active.offsetWidth, h: active.offsetHeight };
    const prev = last[key];
    ind.classList.remove("go");
    Object.assign(ind.style, { opacity: 1, width: box.w + "px", height: box.h + "px" });
    if (prev && !calm && (prev.x !== box.x || prev.y !== box.y)) {
      ind.style.transform = `translate(${prev.x}px,${prev.y}px) scale(${prev.w / box.w},${prev.h / box.h})`;
      ind.offsetWidth; ind.classList.add("go");
    }
    ind.style.transform = `translate(${box.x}px,${box.y}px)`;
    last[key] = box;
  };
  window.addEventListener("resize", () => { for (const k in last) delete last[k]; window.slideIndicator(document.getElementById("nav"), "nav"); });

  // staggered entrance for a freshly shown view
  window.animateEnter = function (el) {
    if (!el) return;
    el.classList.remove("enter"); void el.offsetWidth; el.classList.add("enter");
    [...el.children].forEach((c, i) => c.style.setProperty("--i", Math.min(i, 5)));
    setTimeout(() => el.classList.remove("enter"), 700);
  };

  // KPI count-up, once per visit
  let counted = false;
  window.countUpOnce = function (root) {
    if (counted || calm || !root) return; counted = true;
    root.querySelectorAll(".k-value").forEach(el => {
      const node = el.firstChild; if (!node || node.nodeType !== 3) return;
      const target = parseInt(node.textContent.replace(/[^\d]/g, ""), 10); if (!target) return;
      const t0 = performance.now(), dur = 700;
      const step = now => { const p = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - p, 4); node.textContent = Math.round(target * e); if (p < 1) requestAnimationFrame(step); };
      node.textContent = "0"; requestAnimationFrame(step);
    });
  };

  // water-drop ripple from the tap point
  document.addEventListener("pointerdown", e => {
    if (calm) return;
    const el = e.target.closest(".btn, #nav button, .bottom-nav button, .kpi, .week-item");
    if (!el || el.disabled) return;
    const r = el.getBoundingClientRect(), size = Math.min(Math.max(r.width, r.height) * 1.6, 260);
    const dark = el.matches(".btn:not(.ghost):not(.tan):not(.teal):not(.danger), #nav button, .bottom-nav button");
    const color = dark ? "rgba(245,237,227,.55)" : "rgba(169,135,95,.32)";
    if (getComputedStyle(el).position === "static") el.style.position = "relative";
    ["", "ring"].forEach(kind => {
      const s = document.createElement("span"); s.className = "ripple" + (kind ? " " + kind : "");
      Object.assign(s.style, { width: size + "px", height: size + "px", left: (e.clientX - r.left - size / 2) + "px", top: (e.clientY - r.top - size / 2) + "px" });
      s.style.setProperty("--rc", color);
      el.appendChild(s); s.offsetWidth; s.classList.add("go"); setTimeout(() => s.remove(), 750);
    });
  });

  // spotlight following the mouse on KPI cards
  if (finePointer && !calm) document.addEventListener("pointermove", e => {
    const k = e.target.closest && e.target.closest(".kpi"); if (!k) return;
    const r = k.getBoundingClientRect();
    k.style.setProperty("--mx", (e.clientX - r.left) + "px"); k.style.setProperty("--my", (e.clientY - r.top) + "px");
  }, { passive: true });

  // drag-and-drop highlight on upload boxes
  ["dragenter", "dragover"].forEach(ev => document.addEventListener(ev, e => { const d = e.target.closest && e.target.closest(".dropzone"); if (d) { e.preventDefault(); d.classList.add("over"); } }));
  ["dragleave", "drop"].forEach(ev => document.addEventListener(ev, e => { const d = e.target.closest && e.target.closest(".dropzone"); if (d) d.classList.remove("over"); }));
  document.addEventListener("drop", e => {
    const d = e.target.closest && e.target.closest(".dropzone"); if (!d) return;
    e.preventDefault();
    const input = document.getElementById(d.getAttribute("for"));
    if (input && e.dataTransfer.files.length) { input.files = e.dataTransfer.files; input.dispatchEvent(new Event("change")); }
  });
})();

// Icons (same stroke style as Trackit)
const ICON = {
  dash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></svg>',
  star: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.8l-5.2 2.8 1-5.8-4.3-4.1 5.9-.8z"/></svg>',
  store: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9l1.5-5h13L20 9"/><path d="M4 9a2.7 2.7 0 0 0 5.3 0 2.7 2.7 0 0 0 5.4 0A2.7 2.7 0 0 0 20 9"/><path d="M5 11.5V20h14v-8.5"/><path d="M10 20v-5h4v5"/></svg>',
  users: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.6 3.4-5.5 6.5-5.5s5.7 1.9 6.5 5.5"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14.8c1.9.7 3.1 2.5 3.5 5.2"/></svg>',
  up: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 15V4M7 9l5-5 5 5"/><path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/></svg>',
  down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 4v11M7 10l5 5 5-5"/><path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  wa: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3.5 20.5l1.3-4.2A8.5 8.5 0 1 1 8 19.6z"/><path d="M9 9.5c.3 2 2.2 4.1 4.5 4.8l1.2-1.2 1.8.9c-.3 1.2-1.3 1.9-2.4 1.8C10.8 15.4 8.5 13 8.2 10c-.1-1 .6-2 1.8-2.3l.9 1.8z"/></svg>',
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>',
  key: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="8" cy="15" r="4"/><path d="M10.8 12.2 20 3M16 7l3 3M14 9l2 2"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>',
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg>',
  eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
  out: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l5-5-5-5M15 12H4"/></svg>',
};
