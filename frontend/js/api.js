/* API Bridge & Shared Utilities for XIQ-SE API Studio */

window.XIQApi = (() => {
  async function request(url, options = {}) {
    const opts = {
      headers: { "Content-Type": "application/json", ...(options.headers || {}) },
      ...options,
    };
    const resp = await fetch(url, opts);
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      throw new Error(data.error || `Erreur HTTP ${resp.status}`);
    }
    return data;
  }

  function escapeHtml(val) {
    if (val === null || val === undefined) return "";
    return String(val)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function highlightJson(obj) {
    const text = typeof obj === "string" ? obj : JSON.stringify(obj, null, 2);
    const escaped = escapeHtml(text);
    return escaped.replace(
      /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g,
      (match) => {
        let cls = "j-num";
        if (/^"/.test(match)) {
          cls = /:$/.test(match) ? "j-key" : "j-str";
        } else if (/true|false/.test(match)) {
          cls = "j-bool";
        } else if (/null/.test(match)) {
          cls = "j-null";
        }
        return `<span class="${cls}">${match}</span>`;
      }
    );
  }

  function toast(message, type = "info") {
    const container = document.getElementById("toast-container");
    if (!container) return;
    const el = document.createElement("div");
    el.className = `toast ${type}`;
    el.textContent = message;
    container.appendChild(el);
    setTimeout(() => {
      el.style.opacity = "0";
      el.style.transition = "opacity 0.25s";
      setTimeout(() => el.remove(), 260);
    }, 3600);
  }

  async function copyText(text) {
    const label = text && text.length <= 42 && !text.includes("\n") ? `Copié : ${text}` : "Copié dans le presse-papiers.";
    try {
      await navigator.clipboard.writeText(text);
      toast(label, "success");
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
      toast(label, "success");
    }
  }

  function rowsToCsv(rows) {
    if (!Array.isArray(rows) || !rows.length) return "";
    const keys = Array.from(
      rows.reduce((set, r) => {
        if (r && typeof r === "object") Object.keys(r).forEach((k) => set.add(k));
        return set;
      }, new Set())
    );
    const esc = (v) => {
      if (v === null || v === undefined) return "";
      const s = typeof v === "object" ? JSON.stringify(v) : String(v);
      return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = keys.map(esc).join(";");
    const lines = rows.map((r) => keys.map((k) => esc(r ? r[k] : "")).join(";"));
    return [header, ...lines].join("\r\n");
  }

  async function exportFile(filename, content) {
    try {
      const res = await request("/api/export/save", {
        method: "POST",
        body: JSON.stringify({ filename, content }),
      });
      toast(`Fichier exporté : ${res.path}`, "success");
    } catch (err) {
      toast(`Erreur d'export : ${err.message}`, "error");
    }
  }

  function showModal({ title, bodyHtml, footerHtml, onMount }) {
    const backdrop = document.getElementById("modal-backdrop");
    document.getElementById("modal-title").textContent = title;
    document.getElementById("modal-body").innerHTML = bodyHtml;
    document.getElementById("modal-footer").innerHTML = footerHtml || "";
    backdrop.classList.remove("hidden");
    if (onMount) onMount(backdrop);
  }

  function closeModal() {
    document.getElementById("modal-backdrop").classList.add("hidden");
  }

  async function openExternalUrl(url) {
    try {
      await request("/api/open-url", {
        method: "POST",
        body: JSON.stringify({ url }),
      });
    } catch (err) {
      toast(`Impossible d'ouvrir ${url} : ${err.message}`, "error");
    }
  }

  function isIpv4(val) {
    return /^\d{1,3}(\.\d{1,3}){3}$/.test(String(val || "").trim());
  }

  function copyBtnHtml(val) {
    const clean = String(val || "").trim();
    if (!clean || clean === "—") return "";
    return `<button type="button" class="copy-mini-btn" data-copy-val="${escapeHtml(clean)}" title="Copier ${escapeHtml(clean)}">⧉</button>`;
  }

  function switchIpLink(ip, label = null) {
    const clean = String(ip || "").trim();
    if (!clean || clean === "—") return escapeHtml(label || "—");
    if (!isIpv4(clean)) return escapeHtml(label || clean);
    const display = label || clean;
    return `<span class="inline-val-wrap"><a href="https://${escapeHtml(clean)}" class="switch-ip-link mono" data-open-ip="${escapeHtml(clean)}" data-right-copy="${escapeHtml(clean)}" title="Clic : ouvrir https://${escapeHtml(clean)} · Clic droit : copier">${escapeHtml(display)} ↗</a>${copyBtnHtml(clean)}</span>`;
  }

  function macLink(mac) {
    const clean = String(mac || "").trim();
    if (!clean || clean === "—") return "—";
    return `<span class="inline-val-wrap"><a href="#" class="switch-ip-link mono" data-open-mac="${escapeHtml(clean)}" data-right-copy="${escapeHtml(clean)}" title="Clic : ouvrir la fiche du terminal · Clic droit : copier">${escapeHtml(clean)}</a>${copyBtnHtml(clean)}</span>`;
  }

  return {
    escapeHtml,
    highlightJson,
    toast,
    copyText,
    copyBtnHtml,
    rowsToCsv,
    exportFile,
    openExternalUrl,
    switchIpLink,
    macLink,
    showModal,
    closeModal,

    // REST Bridge calls
    health: () => request("/api/health"),
    getProfiles: () => request("/api/profiles"),
    saveProfile: (profile) =>
      request("/api/profiles", { method: "POST", body: JSON.stringify(profile) }),
    activateProfile: (id) =>
      request("/api/profiles/activate", { method: "POST", body: JSON.stringify({ id }) }),
    deleteProfile: (id) =>
      request(`/api/profiles/${encodeURIComponent(id)}`, { method: "DELETE" }),
    testConnection: (profile = null) =>
      request("/api/connection/test", {
        method: "POST",
        body: JSON.stringify(profile ? { profile } : {}),
      }),
    graphql: (query, variables = {}, opts = {}) =>
      request("/api/graphql", {
        method: "POST",
        body: JSON.stringify({
          query,
          variables,
          recordHistory: opts.recordHistory !== false,
          source: opts.source || "studio",
        }),
      }),
    introspectSchema: () => request("/api/schema/introspect", { method: "POST", body: "{}" }),
    getImportedSchema: () => request("/api/schema/imported"),
    importSchema: (schema) =>
      request("/api/schema/import", { method: "POST", body: JSON.stringify({ schema }) }),
    getTemplates: () => request("/api/templates"),
    getHistory: () => request("/api/history?limit=100"),
    clearHistory: () => request("/api/history", { method: "DELETE" }),
    getFavorites: () => request("/api/favorites"),
    saveFavorite: (fav) =>
      request("/api/favorites", { method: "POST", body: JSON.stringify(fav) }),
    deleteFavorite: (id) =>
      request(`/api/favorites/${encodeURIComponent(id)}`, { method: "DELETE" }),
    codegen: (query, variables = {}) =>
      request("/api/codegen", { method: "POST", body: JSON.stringify({ query, variables }) }),
    getAuditSummary: () => request("/api/audit/summary"),
    saveAuditSummary: (summary) =>
      request("/api/audit/summary", { method: "POST", body: JSON.stringify(summary) }),
    resetDemo: () => request("/api/demo/reset", { method: "POST", body: "{}" }),
  };
})();
