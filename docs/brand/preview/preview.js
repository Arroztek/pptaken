/* PPTaken brand previews: tiny, dependency-free helpers. Not product code.
 * - Injects the logo markup (from logo-data.js) into [data-logo].
 * - Theme: system / light / dark (also ?theme=light|dark). Pages may set <html data-default-theme="dark">.
 * - States: <body data-states="a,b"> renders a state switcher; sets body[data-state]. Also ?state=.
 * - Language: swaps textContent with data-es / data-en (also ?lang=es).
 * - ARIA tabs with arrow keys, copy buttons with live feedback, dialogs.
 */
(() => {
  const qs = new URLSearchParams(location.search);
  const root = document.documentElement;
  const ICON = (name) => `<span class="ppt-icon" data-icon="${name}" aria-hidden="true"></span>`;

  // ---- logo
  for (const el of document.querySelectorAll("[data-logo]")) {
    const l = window.PPT_LOGO?.[el.dataset.logo];
    if (!l) continue;
    el.innerHTML = `<svg viewBox="${l.viewBox}" role="img" aria-label="PPTaken" focusable="false">${l.body}</svg>`;
  }

  // ---- theme
  const setTheme = (mode) => {
    if (mode === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", mode);
    for (const b of document.querySelectorAll("[data-theme-opt]"))
      b.setAttribute("aria-checked", String(b.dataset.themeOpt === mode));
  };
  const initialTheme = qs.get("theme") || root.dataset.defaultTheme || "system";

  // ---- language
  const setLang = (lang) => {
    root.lang = lang;
    for (const el of document.querySelectorAll("[data-es]")) {
      if (el.dataset.en === undefined) el.dataset.en = el.textContent;
      el.textContent = lang === "es" ? el.dataset.es : el.dataset.en;
    }
    for (const el of document.querySelectorAll("[data-es-label]")) {
      if (el.dataset.enLabel === undefined) el.dataset.enLabel = el.getAttribute("aria-label") || "";
      el.setAttribute("aria-label", lang === "es" ? el.dataset.esLabel : el.dataset.enLabel);
    }
    for (const b of document.querySelectorAll("[data-lang-opt]")) b.setAttribute("aria-checked", String(b.dataset.langOpt === lang));
  };

  // ---- states
  const states = (document.body.dataset.states || "").split(",").filter(Boolean);
  const setState = (s) => {
    document.body.dataset.state = s;
    for (const el of document.querySelectorAll("[data-show-state]")) el.hidden = !el.dataset.showState.split(" ").includes(s);
    for (const b of document.querySelectorAll("[data-state-opt]")) b.setAttribute("aria-checked", String(b.dataset.stateOpt === s));
  };

  // ---- preview toolbar (clearly not part of the product UI)
  if (!document.body.hasAttribute("data-no-toolbar")) {
    const bar = document.createElement("div");
    bar.className = "pv-toolbar";
    bar.setAttribute("role", "region");
    bar.setAttribute("aria-label", "Preview tools");
    const seg = (label, attr, opts) =>
      `<div class="ppt-segmented" role="radiogroup" aria-label="${label}">${opts
        .map(([v, inner, name]) => `<button type="button" class="ppt-segmented__opt" role="radio" aria-checked="false" ${attr}="${v}" aria-label="${name || v}" title="${name || v}">${inner}</button>`)
        .join("")}</div>`;
    bar.innerHTML =
      `<a class="pv-toolbar__home" href="index.html" aria-label="Back to gallery">${ICON("squares-four")}</a>` +
      seg("Theme", "data-theme-opt", [["system", ICON("desktop"), "System theme"], ["light", ICON("sun"), "Light"], ["dark", ICON("moon"), "Dark"]]) +
      seg("Language", "data-lang-opt", [["en", "EN", "English"], ["es", "ES", "Español"]]) +
      (states.length ? seg("State", "data-state-opt", states.map((s) => [s, s.replace(/-/g, " ")])) : "");
    document.body.appendChild(bar);
  }

  document.addEventListener("click", (e) => {
    const t = e.target.closest("[data-theme-opt],[data-lang-opt],[data-state-opt]");
    if (!t) return;
    if (t.dataset.themeOpt) setTheme(t.dataset.themeOpt);
    if (t.dataset.langOpt) setLang(t.dataset.langOpt);
    if (t.dataset.stateOpt) setState(t.dataset.stateOpt);
  });

  setTheme(initialTheme);
  setLang(qs.get("lang") || "en");
  if (states.length) setState(qs.get("state") || document.body.dataset.state || states[0]);

  // ---- tabs (WAI-ARIA, automatic activation)
  for (const list of document.querySelectorAll('[role="tablist"]')) {
    const tabs = [...list.querySelectorAll('[role="tab"]')];
    const select = (tab, focus) => {
      for (const t of tabs) {
        const on = t === tab;
        t.setAttribute("aria-selected", String(on));
        t.tabIndex = on ? 0 : -1;
        document.getElementById(t.getAttribute("aria-controls")).hidden = !on;
      }
      if (focus) tab.focus();
    };
    list.addEventListener("click", (e) => { const t = e.target.closest('[role="tab"]'); if (t) select(t); });
    list.addEventListener("keydown", (e) => {
      const i = tabs.indexOf(document.activeElement);
      if (i < 0) return;
      const n = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
      if (n === undefined) return;
      e.preventDefault();
      select(tabs[(n + tabs.length) % tabs.length], true);
    });
    const initial = qs.get("tab");
    if (initial && tabs[Number(initial)]) select(tabs[Number(initial)]);
  }

  // ---- copy buttons
  document.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-copy]");
    if (!b) return;
    const src = document.getElementById(b.dataset.copy);
    const text = src ? src.textContent.trim() : b.dataset.copyText || "";
    try { await navigator.clipboard.writeText(text); } catch { /* preview: clipboard may be blocked */ }
    const label = b.querySelector("[data-label]");
    const icon = b.querySelector(".ppt-icon");
    const es = root.lang === "es";
    if (!b.dataset.orig) b.dataset.orig = label ? label.textContent : "";
    if (label) label.textContent = es ? "Copiado" : "Copied";
    if (icon) icon.dataset.icon = "check";
    b.classList.add("is-copied");
    const live = document.getElementById("pv-live");
    if (live) live.textContent = es ? "Copiado al portapapeles." : "Copied to clipboard.";
    clearTimeout(b._t);
    b._t = setTimeout(() => {
      if (label) label.textContent = b.dataset.orig;
      if (icon) icon.dataset.icon = b.dataset.icon || "copy";
      b.classList.remove("is-copied");
    }, 2000);
  });

  // ---- dialogs
  document.addEventListener("click", (e) => {
    const open = e.target.closest("[data-open-dialog]");
    if (open) document.getElementById(open.dataset.openDialog)?.showModal();
    const close = e.target.closest("[data-close-dialog]");
    if (close) close.closest("dialog")?.close();
  });

  // ---- pressed toggles
  document.addEventListener("click", (e) => {
    const t = e.target.closest("[data-toggle-pressed]");
    if (t) t.setAttribute("aria-pressed", String(t.getAttribute("aria-pressed") !== "true"));
  });

  if (!document.getElementById("pv-live")) {
    const live = document.createElement("div");
    live.id = "pv-live"; live.className = "ppt-sr-only"; live.setAttribute("aria-live", "polite");
    document.body.appendChild(live);
  }
})();
