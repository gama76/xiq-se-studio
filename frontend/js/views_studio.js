/* Studio GraphQL View — 100% XIQ-SE API Exploration, Introspection, Templates & Codegen */

window.StudioView = (() => {
  const state = {
    leftTab: "schema", // schema | templates | favorites | history
    rightTab: "json",  // json | table | code
    codeLang: "python",
    schemaFilter: "",
    schemaKind: "all", // all | query | mutation
    indexedSchema: null,
    schemaSourceLabel: "Non chargé",
    templates: [],
    favorites: [],
    history: [],
    query: `query GetAllDevices {
  network {
    devices {
      ip
      sysName
      baseMac
      status
      deviceDisplayFamily
      firmware
      sitePath
    }
  }
}`,
    variablesText: "{}",
    lastResult: null,
    lastCode: null,
  };

  function setQuery(query, variables = {}) {
    state.query = query || "";
    state.variablesText = JSON.stringify(variables || {}, null, 2);
  }

  async function ensureInitialData() {
    if (!state.templates.length) {
      const tpl = await XIQApi.getTemplates().catch(() => ({ templates: [] }));
      state.templates = tpl.templates || [];
    }
    const [favs, hist] = await Promise.all([
      XIQApi.getFavorites().catch(() => ({ favorites: [] })),
      XIQApi.getHistory().catch(() => ({ history: [] })),
    ]);
    state.favorites = favs.favorites || [];
    state.history = hist.history || [];

    if (!state.indexedSchema) {
      await loadSchema(false);
    }
  }

  async function loadSchema(forceNotify = false) {
    try {
      const pid = window.XIQApp?.getActiveProfile?.()?.id || "default";
      const res = await SchemaTools.ensureLiveSchema(pid, forceNotify);
      if (res.ok && res.indexed) {
        state.indexedSchema = res.indexed;
        state.schemaSourceLabel = res.sourceLabel;
        if (forceNotify) {
          XIQApi.toast(
            `Schéma chargé : ${state.indexedSchema.counts.queries} queries, ${state.indexedSchema.counts.mutations} mutations, ${state.indexedSchema.counts.types} types.`,
            "success"
          );
        }
      } else if (forceNotify) {
        XIQApi.toast(res.error || "Impossible d'introspecter le serveur.", "error");
      }
    } catch (err) {
      if (forceNotify) XIQApi.toast(err.message, "error");
    }
  }

  function renderLeftContent() {
    const esc = XIQApi.escapeHtml;
    if (state.leftTab === "schema") {
      if (!state.indexedSchema) {
        return `<div class="empty-state">
          <p style="margin-bottom:10px;">Aucun schéma chargé.</p>
          <button class="btn btn-primary btn-sm" id="btn-empty-introspect">Introspecter XIQ-SE</button>
        </div>`;
      }
      const q = state.schemaFilter.trim().toLowerCase();
      const showQ = state.schemaKind === "all" || state.schemaKind === "query";
      const showM = state.schemaKind === "all" || state.schemaKind === "mutation";
      const groups = [
        ...(showQ ? state.indexedSchema.queryGroups : []),
        ...(showM ? state.indexedSchema.mutationGroups : []),
      ];

      let html = `
        <div style="display:flex;gap:6px;margin-bottom:8px;">
          <input type="text" id="schema-search" placeholder="Filtrer queries, mutations..." value="${esc(state.schemaFilter)}" style="flex:1;padding:5px 8px;font-size:12px;" />
        </div>
        <div style="display:flex;gap:4px;margin-bottom:8px;">
          <button class="btn btn-xs ${state.schemaKind === "all" ? "btn-primary" : "btn-ghost"}" data-skind="all">Tout (${state.indexedSchema.counts.queries + state.indexedSchema.counts.mutations})</button>
          <button class="btn btn-xs ${state.schemaKind === "query" ? "btn-primary" : "btn-ghost"}" data-skind="query">Queries (${state.indexedSchema.counts.queries})</button>
          <button class="btn btn-xs ${state.schemaKind === "mutation" ? "btn-primary" : "btn-ghost"}" data-skind="mutation">Mutations (${state.indexedSchema.counts.mutations})</button>
        </div>
        <div style="font-size:11px;color:var(--text-muted);margin-bottom:8px;">
          Source : <strong>${esc(state.schemaSourceLabel)}</strong> — cliquez sur un champ pour générer la requête.
        </div>`;

      let renderedCount = 0;
      groups.forEach((grp, gIdx) => {
        const matched = grp.fields.filter((f) => {
          if (!q) return true;
          return (
            f.name.toLowerCase().includes(q) ||
            grp.domain.toLowerCase().includes(q) ||
            (f.description || "").toLowerCase().includes(q)
          );
        });
        if (!matched.length) return;
        renderedCount += matched.length;
        const badgeCls = grp.opType === "mutation" ? "badge-amber" : "badge-cyan";
        const badgeLabel = grp.opType === "mutation" ? "MUT" : "QRY";
        html += `<div style="margin:10px 0 4px;display:flex;align-items:center;justify-content:space-between;">
          <strong style="font-size:12px;">${esc(grp.domain)}</strong>
          <span class="badge ${badgeCls}">${badgeLabel}</span>
        </div>`;
        matched.forEach((f, fIdx) => {
          const argsTxt = (f.args || []).map((a) => `${a.name}: ${SchemaTools.formatTypeRef(a.type)}`).join(", ");
          html += `<div class="schema-item" data-gidx="${gIdx}" data-op="${grp.opType}" data-domain="${esc(grp.domain)}" data-fname="${esc(f.name)}">
            <div style="display:flex;justify-content:space-between;gap:6px;align-items:baseline;">
              <span class="schema-field-name">${esc(f.name)}${argsTxt ? `(${esc(argsTxt.slice(0, 26))}${argsTxt.length > 26 ? "…" : ""})` : ""}</span>
              <span class="schema-field-type">${esc(SchemaTools.formatTypeRef(f.type))}</span>
            </div>
            ${f.description ? `<div class="schema-field-desc">${esc(f.description)}</div>` : ""}
          </div>`;
        });
      });

      if (!renderedCount) {
        html += `<div class="empty-state">Aucun champ ne correspond à « ${esc(state.schemaFilter)} ».</div>`;
      }
      return html;
    }

    if (state.leftTab === "templates") {
      const grouped = {};
      state.templates.forEach((t) => {
        if (!grouped[t.domain]) grouped[t.domain] = [];
        grouped[t.domain].push(t);
      });
      let html = `<div style="font-size:11.5px;color:var(--text-muted);margin-bottom:8px;">${state.templates.length} modèles XIQ-SE prêts à l'emploi :</div>`;
      for (const [domain, items] of Object.entries(grouped)) {
        html += `<div style="margin:10px 0 4px;font-size:11px;font-weight:700;text-transform:uppercase;color:var(--text-muted);">${esc(domain)}</div>`;
        items.forEach((t) => {
          const b = t.type === "mutation" ? "badge-amber" : "badge-cyan";
          html += `<div class="schema-item" data-tpl-id="${esc(t.id)}">
            <div style="display:flex;justify-content:space-between;gap:6px;align-items:center;">
              <strong style="font-size:12px;">${esc(t.name)}</strong>
              <span class="badge ${b}">${t.type === "mutation" ? "MUT" : "QRY"}</span>
            </div>
            <div class="schema-field-desc">${esc(t.description)}</div>
          </div>`;
        });
      }
      return html;
    }

    if (state.leftTab === "favorites") {
      if (!state.favorites.length) {
        return `<div class="empty-state">Aucun favori enregistré.<br/>Cliquez sur « ★ Favori » pour sauvegarder vos requêtes fréquentes.</div>`;
      }
      return state.favorites
        .map(
          (f) => `<div class="schema-item" data-fav-id="${esc(f.id)}">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:6px;">
            <strong style="font-size:12px;">★ ${esc(f.name)}</strong>
            <button class="btn btn-xs btn-danger" data-del-fav="${esc(f.id)}" title="Supprimer">✕</button>
          </div>
          <div class="schema-field-desc">${esc(f.category)} ${f.description ? "— " + esc(f.description) : ""}</div>
        </div>`
        )
        .join("");
    }

    if (state.leftTab === "history") {
      if (!state.history.length) {
        return `<div class="empty-state">Historique vide. Exécutez une requête GraphQL pour la voir apparaître ici.</div>`;
      }
      return `
        <div style="display:flex;justify-content:flex-end;margin-bottom:8px;">
          <button class="btn btn-xs btn-danger" id="btn-clear-history">Vider l'historique</button>
        </div>
        ${state.history
          .map(
            (h) => `<div class="schema-item" data-hist-id="${esc(h.id)}">
            <div style="display:flex;justify-content:space-between;align-items:center;gap:6px;">
              <span class="badge ${h.success ? "badge-green" : "badge-red"}">${h.operation_type.toUpperCase()} · ${h.duration_ms}ms</span>
              <span style="font-size:10.5px;color:var(--text-muted);">${esc((h.timestamp || "").slice(11, 19))}</span>
            </div>
            <div class="mono" style="font-size:11px;margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(h.query.replace(/\s+/g, " ").slice(0, 75))}</div>
          </div>`
          )
          .join("")}`;
    }
    return "";
  }

  function renderRightContent() {
    const esc = XIQApi.escapeHtml;
    if (state.rightTab === "code") {
      if (!state.lastCode) {
        return `<div class="empty-state">Cliquez sur « Générer Code » ou basculez sur cet onglet pour générer le script Python / cURL / PowerShell.</div>`;
      }
      const code = state.lastCode[state.codeLang] || "";
      return `
        <div style="padding:8px 12px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;gap:8px;">
          <div style="display:flex;gap:5px;">
            <button class="btn btn-xs ${state.codeLang === "python" ? "btn-primary" : "btn-ghost"}" data-clang="python">Python</button>
            <button class="btn btn-xs ${state.codeLang === "curl" ? "btn-primary" : "btn-ghost"}" data-clang="curl">cURL</button>
            <button class="btn btn-xs ${state.codeLang === "powershell" ? "btn-primary" : "btn-ghost"}" data-clang="powershell">PowerShell</button>
          </div>
          <button class="btn btn-xs btn-secondary" id="btn-copy-code">Copier le script</button>
        </div>
        <pre class="code-output">${esc(code)}</pre>`;
    }

    if (!state.lastResult) {
      return `<div class="empty-state">Exécutez une requête GraphQL (<kbd>Ctrl+Entrée</kbd>) pour afficher la réponse JSON ou le tableau de données.</div>`;
    }

    if (state.rightTab === "table") {
      const rows = SchemaTools.extractTableRows(state.lastResult.data);
      if (!rows.length) {
        return `<div class="empty-state">Aucune donnée tabulaire dans cette réponse.</div>`;
      }
      const cols = Array.from(rows.reduce((s, r) => { Object.keys(r).forEach((k) => s.add(k)); return s; }, new Set()));
      return `
        <div style="padding:8px 12px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;">
          <span style="font-size:12px;color:var(--text-secondary);">${rows.length} ligne(s) · ${cols.length} colonne(s)</span>
          <button class="btn btn-xs btn-secondary" id="btn-export-studio-csv">Exporter CSV</button>
        </div>
        <div class="table-wrap" style="flex:1;overflow:auto;">
          <table>
            <thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead>
            <tbody>
              ${rows
                .slice(0, 500)
                .map(
                  (r) => `<tr>${cols.map((c) => `<td class="mono">${esc(r[c])}</td>`).join("")}</tr>`
                )
                .join("")}
            </tbody>
          </table>
        </div>`;
    }

    const payload = state.lastResult.errors?.length
      ? { data: state.lastResult.data, errors: state.lastResult.errors }
      : { data: state.lastResult.data };
    return `<pre class="code-output">${XIQApi.highlightJson(payload)}</pre>`;
  }

  async function render(viewport) {
    viewport.classList.add("studio-mode");
    await ensureInitialData();
    draw(viewport);
  }

  function draw(viewport) {
    const esc = XIQApi.escapeHtml;
    const statusHtml = state.lastResult
      ? `<span class="badge ${state.lastResult.ok ? "badge-green" : "badge-red"}">${state.lastResult.ok ? "OK" : "ERREUR"} · HTTP ${state.lastResult.status_code} · ${state.lastResult.duration_ms} ms</span>`
      : `<span class="badge badge-muted">Prêt</span>`;

    viewport.innerHTML = `
      <div class="studio-layout">
        <!-- LEFT PANE: SCHEMA / TEMPLATES / FAVORITES / HISTORY -->
        <section class="studio-pane">
          <div class="pane-head" style="padding:6px 8px;">
            <div style="display:flex;gap:3px;flex-wrap:wrap;">
              <button class="btn btn-xs ${state.leftTab === "schema" ? "btn-primary" : "btn-ghost"}" data-ltab="schema">Schéma</button>
              <button class="btn btn-xs ${state.leftTab === "templates" ? "btn-primary" : "btn-ghost"}" data-ltab="templates">Modèles</button>
              <button class="btn btn-xs ${state.leftTab === "favorites" ? "btn-primary" : "btn-ghost"}" data-ltab="favorites">Favoris</button>
              <button class="btn btn-xs ${state.leftTab === "history" ? "btn-primary" : "btn-ghost"}" data-ltab="history">Hist.</button>
            </div>
          </div>
          <div class="pane-head" style="padding:5px 8px;background:transparent;">
            <button class="btn btn-xs btn-secondary" id="btn-introspect-live" title="Interroger __schema sur le serveur XIQ-SE actif">↻ Introspecter</button>
            <button class="btn btn-xs btn-ghost" id="btn-import-schema" title="Importer NBI Schema (JSON) depuis XIQ-SE">↑ Import JSON</button>
            <input type="file" id="schema-file-input" accept=".json" style="display:none;" />
          </div>
          <div class="pane-scroll" id="studio-left-scroll">
            ${renderLeftContent()}
          </div>
        </section>

        <!-- CENTER PANE: QUERY & VARIABLES -->
        <section class="studio-pane">
          <div class="pane-head">
            <strong style="font-size:12.5px;">Requête / Mutation GraphQL</strong>
            <div style="display:flex;gap:6px;">
              <button class="btn btn-xs btn-ghost" id="btn-save-fav">★ Favori</button>
              <button class="btn btn-xs btn-secondary" id="btn-gen-code">&lt;/&gt; Code</button>
              <button class="btn btn-xs btn-primary" id="btn-run-gql">▶ Exécuter (Ctrl+↵)</button>
            </div>
          </div>
          <textarea class="code-editor" id="studio-query-editor" spellcheck="false" placeholder="Écrivez votre query ou mutation GraphQL XIQ-SE...">${esc(state.query)}</textarea>
          <div class="vars-box">
            <div class="pane-head" style="padding:5px 10px;">
              <span style="font-size:11.5px;font-weight:700;color:var(--text-secondary);">Variables JSON</span>
              <button class="btn btn-xs btn-ghost" id="btn-format-vars">Formater JSON</button>
            </div>
            <textarea class="code-editor" id="studio-vars-editor" spellcheck="false" style="padding:8px 12px;">${esc(state.variablesText)}</textarea>
          </div>
        </section>

        <!-- RIGHT PANE: RESULTS / TABLE / CODEGEN -->
        <section class="studio-pane">
          <div class="pane-head">
            <div style="display:flex;gap:4px;align-items:center;">
              <button class="btn btn-xs ${state.rightTab === "json" ? "btn-primary" : "btn-ghost"}" data-rtab="json">JSON</button>
              <button class="btn btn-xs ${state.rightTab === "table" ? "btn-primary" : "btn-ghost"}" data-rtab="table">Tableau</button>
              <button class="btn btn-xs ${state.rightTab === "code" ? "btn-primary" : "btn-ghost"}" data-rtab="code">Code</button>
            </div>
            <div style="display:flex;gap:6px;align-items:center;">
              ${statusHtml}
              <button class="btn btn-xs btn-ghost" id="btn-copy-result" title="Copier le résultat JSON">Copier</button>
              <button class="btn btn-xs btn-ghost" id="btn-export-result-json" title="Exporter JSON dans Téléchargements">↓ JSON</button>
            </div>
          </div>
          <div style="display:flex;flex-direction:column;flex:1;min-height:0;" id="studio-right-body">
            ${renderRightContent()}
          </div>
        </section>
      </div>
    `;

    bindEvents(viewport);
  }

  function bindEvents(viewport) {
    const qEditor = viewport.querySelector("#studio-query-editor");
    const vEditor = viewport.querySelector("#studio-vars-editor");

    qEditor.addEventListener("input", () => { state.query = qEditor.value; });
    vEditor.addEventListener("input", () => { state.variablesText = vEditor.value; });

    qEditor.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        runQuery(viewport);
      }
    });

    viewport.querySelectorAll("[data-ltab]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.leftTab = btn.dataset.ltab;
        draw(viewport);
      });
    });

    viewport.querySelectorAll("[data-rtab]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        state.rightTab = btn.dataset.rtab;
        if (state.rightTab === "code") {
          await generateCode();
        }
        draw(viewport);
      });
    });

    viewport.querySelectorAll("[data-skind]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.schemaKind = btn.dataset.skind;
        draw(viewport);
      });
    });

    const sSearch = viewport.querySelector("#schema-search");
    if (sSearch) {
      sSearch.addEventListener("input", (e) => {
        state.schemaFilter = e.target.value;
        const leftScroll = viewport.querySelector("#studio-left-scroll");
        const cursorPos = e.target.selectionStart;
        leftScroll.innerHTML = renderLeftContent();
        bindLeftScrollEvents(viewport);
        const newInput = viewport.querySelector("#schema-search");
        if (newInput) {
          newInput.focus();
          newInput.setSelectionRange(cursorPos, cursorPos);
        }
      });
    }

    bindLeftScrollEvents(viewport);

    viewport.querySelector("#btn-run-gql").addEventListener("click", () => runQuery(viewport));
    viewport.querySelector("#btn-gen-code").addEventListener("click", async () => {
      await generateCode();
      state.rightTab = "code";
      draw(viewport);
    });

    viewport.querySelector("#btn-format-vars").addEventListener("click", () => {
      try {
        const parsed = state.variablesText.trim() ? JSON.parse(state.variablesText) : {};
        state.variablesText = JSON.stringify(parsed, null, 2);
        vEditor.value = state.variablesText;
      } catch (err) {
        XIQApi.toast(`Variables JSON invalides : ${err.message}`, "error");
      }
    });

    viewport.querySelector("#btn-introspect-live").addEventListener("click", async () => {
      await loadSchema(true);
      state.leftTab = "schema";
      draw(viewport);
    });

    const emptyIntro = viewport.querySelector("#btn-empty-introspect");
    if (emptyIntro) {
      emptyIntro.addEventListener("click", async () => {
        await loadSchema(true);
        draw(viewport);
      });
    }

    const fileInput = viewport.querySelector("#schema-file-input");
    viewport.querySelector("#btn-import-schema").addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const res = await XIQApi.importSchema(text);
        if (res.ok && res.schema) {
          const pid = window.XIQApp?.getActiveProfile?.()?.id || "default";
          state.indexedSchema = SchemaTools.setCachedSchema(res.schema, pid, `Importé : ${file.name}`);
          state.schemaSourceLabel = `Importé : ${file.name}`;
          state.leftTab = "schema";
          XIQApi.toast(`Schéma NBI importé (${res.types_count} types).`, "success");
          draw(viewport);
        }
      } catch (err) {
        XIQApi.toast(err.message, "error");
      }
    });

    viewport.querySelector("#btn-save-fav").addEventListener("click", () => {
      XIQApi.showModal({
        title: "Enregistrer dans les Favoris",
        bodyHtml: `
          <div class="form-grid">
            <div class="form-field full"><label>Nom du favori</label><input id="fav-name" placeholder="Ex: Liste switches Paris" /></div>
            <div class="form-field"><label>Catégorie</label><input id="fav-cat" value="Personnalisé" /></div>
            <div class="form-field"><label>Description</label><input id="fav-desc" placeholder="Optionnel" /></div>
          </div>`,
        footerHtml: `
          <button class="btn btn-ghost" onclick="XIQApi.closeModal()">Annuler</button>
          <button class="btn btn-primary" id="btn-confirm-fav">Enregistrer</button>`,
        onMount: () => {
          document.getElementById("btn-confirm-fav").addEventListener("click", async () => {
            const name = document.getElementById("fav-name").value.trim() || "Requête favori";
            const category = document.getElementById("fav-cat").value.trim() || "Personnalisé";
            const description = document.getElementById("fav-desc").value.trim();
            let varsObj = {};
            try { varsObj = state.variablesText.trim() ? JSON.parse(state.variablesText) : {}; } catch {}
            const res = await XIQApi.saveFavorite({ name, category, description, query: state.query, variables: varsObj });
            state.favorites = res.favorites || [];
            XIQApi.closeModal();
            XIQApi.toast("Requête sauvegardée en favori.", "success");
            draw(viewport);
          });
        },
      });
    });

    viewport.querySelector("#btn-copy-result").addEventListener("click", () => {
      if (!state.lastResult) return XIQApi.toast("Aucun résultat à copier.", "warn");
      XIQApi.copyText(JSON.stringify(state.lastResult.data ?? state.lastResult.errors, null, 2));
    });

    viewport.querySelector("#btn-export-result-json").addEventListener("click", () => {
      if (!state.lastResult) return XIQApi.toast("Aucun résultat à exporter.", "warn");
      XIQApi.exportFile(
        `xiqse-graphql-${Date.now()}.json`,
        JSON.stringify(state.lastResult, null, 2)
      );
    });

    viewport.querySelectorAll("[data-clang]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.codeLang = btn.dataset.clang;
        draw(viewport);
      });
    });

    const copyCodeBtn = viewport.querySelector("#btn-copy-code");
    if (copyCodeBtn) {
      copyCodeBtn.addEventListener("click", () => {
        XIQApi.copyText(state.lastCode?.[state.codeLang] || "");
      });
    }

    const csvBtn = viewport.querySelector("#btn-export-studio-csv");
    if (csvBtn) {
      csvBtn.addEventListener("click", () => {
        const rows = SchemaTools.extractTableRows(state.lastResult?.data);
        XIQApi.exportFile(`xiqse-result-${Date.now()}.csv`, XIQApi.rowsToCsv(rows));
      });
    }
  }

  function bindLeftScrollEvents(viewport) {
    // Schema field click -> auto-generate query/mutation
    viewport.querySelectorAll(".schema-item[data-fname]").forEach((el) => {
      el.addEventListener("click", () => {
        const op = el.dataset.op;
        const domain = el.dataset.domain;
        const fname = el.dataset.fname;
        const groups = op === "mutation" ? state.indexedSchema.mutationGroups : state.indexedSchema.queryGroups;
        const grp = groups.find((g) => g.domain === domain);
        const fieldObj = grp?.fields.find((f) => f.name === fname);
        if (!fieldObj) return;
        const generated = SchemaTools.buildOperationSnippet(state.indexedSchema, fieldObj);
        setQuery(generated.query, generated.variables);
        XIQApi.toast(`Opération générée pour ${domain}.${fname}`, "info");
        draw(viewport);
      });
    });

    // Template click
    viewport.querySelectorAll(".schema-item[data-tpl-id]").forEach((el) => {
      el.addEventListener("click", () => {
        const tpl = state.templates.find((t) => t.id === el.dataset.tplId);
        if (!tpl) return;
        setQuery(tpl.query, tpl.variables || {});
        XIQApi.toast(`Modèle chargé : ${tpl.name}`, "info");
        draw(viewport);
      });
    });

    // Favorite click / delete
    viewport.querySelectorAll("[data-del-fav]").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const res = await XIQApi.deleteFavorite(btn.dataset.delFav);
        state.favorites = res.favorites || [];
        draw(viewport);
      });
    });
    viewport.querySelectorAll(".schema-item[data-fav-id]").forEach((el) => {
      el.addEventListener("click", () => {
        const fav = state.favorites.find((f) => f.id === el.dataset.favId);
        if (!fav) return;
        setQuery(fav.query, fav.variables || {});
        draw(viewport);
      });
    });

    // History click / clear
    const clearHist = viewport.querySelector("#btn-clear-history");
    if (clearHist) {
      clearHist.addEventListener("click", async () => {
        await XIQApi.clearHistory();
        state.history = [];
        draw(viewport);
      });
    }
    viewport.querySelectorAll(".schema-item[data-hist-id]").forEach((el) => {
      el.addEventListener("click", () => {
        const h = state.history.find((x) => x.id === el.dataset.histId);
        if (!h) return;
        setQuery(h.query, h.variables || {});
        draw(viewport);
      });
    });
  }

  async function runQuery(viewport) {
    let varsObj = {};
    try {
      varsObj = state.variablesText.trim() ? JSON.parse(state.variablesText) : {};
    } catch (err) {
      XIQApi.toast(`Variables JSON invalides : ${err.message}`, "error");
      return;
    }
    const btn = viewport.querySelector("#btn-run-gql");
    if (btn) { btn.disabled = true; btn.textContent = "Exécution..."; }
    try {
      const res = await XIQApi.graphql(state.query, varsObj, { source: "studio" });
      state.lastResult = res;
      if (state.rightTab === "code") state.rightTab = "json";
      const hist = await XIQApi.getHistory().catch(() => ({ history: state.history }));
      state.history = hist.history || [];
      if (!res.ok && res.errors?.length) {
        XIQApi.toast(res.errors[0].message || "Erreur GraphQL", "error");
      }
    } catch (err) {
      XIQApi.toast(err.message, "error");
    } finally {
      draw(viewport);
    }
  }

  async function generateCode() {
    let varsObj = {};
    try {
      varsObj = state.variablesText.trim() ? JSON.parse(state.variablesText) : {};
    } catch {}
    state.lastCode = await XIQApi.codegen(state.query, varsObj);
  }

  function resetSchemaCache() {
    SchemaTools.clearSchemaCache();
    state.indexedSchema = null;
    state.schemaSourceLabel = "Non chargé";
  }

  return {
    render,
    setQuery,
    resetSchemaCache,
  };
})();
