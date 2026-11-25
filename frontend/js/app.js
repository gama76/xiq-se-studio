/* Main Controller & Connection Profiles Manager for XIQ-SE API Studio */

window.XIQApp = (() => {
  const esc = XIQApi.escapeHtml;

  const VIEW_TITLES = {
    dashboard: "Tableau de bord",
    locator: "Localisateur Express (MAC / IP / Utilisateur)",
    network: "Réseau & Inventaire",
    nac: "Contrôle d'accès (ExtremeControl NAC)",
    mac_audit: "Audit MAC — Jamais vues & Doublons multi-groupes",
    suggestions: "Suggestions de Nettoyage NAC (Doublons, Conflits & Inactives > 1 an)",
    workflows: "Workflows & Automatisation",
    policy: "Policy & Rôles",
    alarms: "Alarmes & Événements",
    studio: "Studio GraphQL — Explorateur 100% API NBI",
    admin: "Administration & Guide XIQ-SE",
  };

  const state = {
    currentView: "dashboard",
    profilesState: { active_profile_id: null, profiles: [] },
  };

  function getActiveProfile() {
    const { active_profile_id, profiles } = state.profilesState;
    return profiles.find((p) => p.id === active_profile_id) || profiles[0] || null;
  }

  function updateConnectionUI() {
    const active = getActiveProfile();
    const sel = document.getElementById("topbar-profile-select");
    sel.innerHTML = state.profilesState.profiles
      .map(
        (p) =>
          `<option value="${esc(p.id)}" ${p.id === active?.id ? "selected" : ""}>${
            p.mode === "demo" ? "[DÉMO] " : "[LIVE] "
          }${esc(p.name)}</option>`
      )
      .join("");

    const badge = document.getElementById("mode-badge");
    const dot = document.getElementById("sidebar-conn-dot");
    const nameEl = document.getElementById("sidebar-profile-name");
    const hostEl = document.getElementById("sidebar-profile-host");

    if (active) {
      const isDemo = active.mode === "demo";
      badge.textContent = isDemo ? "MODE DÉMO" : "SERVEUR LIVE";
      badge.className = `mode-badge ${isDemo ? "demo" : "live"}`;
      dot.className = `conn-dot ${isDemo ? "" : "live"}`;
      nameEl.textContent = active.name;
      hostEl.textContent = isDemo
        ? "Simulateur intégré"
        : `${active.protocol}://${active.host}:${active.port}${active.graphql_path}`;
    }
  }

  async function navigate(viewName, param = null) {
    state.currentView = viewName;
    document.getElementById("page-title").textContent = VIEW_TITLES[viewName] || "XIQ-SE Studio";
    document.querySelectorAll(".nav-item").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.view === viewName);
    });

    const viewport = document.getElementById("viewport");
    if (viewName === "studio") {
      await StudioView.render(viewport);
    } else if (viewName === "locator") {
      await NetOpsTools.renderLocator(viewport, param);
    } else if (viewName === "suggestions") {
      await OpsViews.suggestions(viewport);
    } else if (OpsViews[viewName]) {
      await OpsViews[viewName](viewport);
    }
  }

  function openConnectionsModal(editProfileId = null) {
    const profiles = state.profilesState.profiles || [];
    const editing = editProfileId
      ? profiles.find((p) => p.id === editProfileId)
      : {
          id: "",
          name: "XIQ-SE Production",
          mode: "live",
          protocol: "https",
          host: "",
          port: 8443,
          graphql_path: "/nbi/graphql",
          auth_type: "oauth2",
          oauth_path: "/oauth/token",
          client_id: "",
          client_secret: "",
          username: "",
          password: "",
          bearer_token: "",
          verify_ssl: false,
          timeout: 30,
        };

    const drawModal = (prof) => {
      const isLive = prof.mode !== "demo";
      XIQApi.showModal({
        title: "Connexions aux serveurs XIQ-SE",
        bodyHtml: `
          <div style="margin-bottom:14px;">
            <div style="font-size:11.5px;font-weight:700;color:var(--text-muted);text-transform:uppercase;margin-bottom:6px;">Profils enregistrés</div>
            <div style="display:flex;gap:6px;flex-wrap:wrap;">
              ${profiles
                .map(
                  (p) => `
                <div style="display:flex;align-items:center;gap:4px;background:var(--bg-elevated);border:1px solid ${
                  p.id === prof.id ? "var(--accent)" : "var(--border)"
                };border-radius:6px;padding:4px 8px;">
                  <button class="btn btn-xs btn-ghost" style="border:none;padding:2px 4px;" data-edit-prof="${esc(p.id)}">${
                    p.mode === "demo" ? "◈" : "●"
                  } ${esc(p.name)}</button>
                  ${
                    p.id !== "demo-simulator"
                      ? `<button class="btn btn-xs btn-danger" style="padding:1px 5px;" data-del-prof="${esc(p.id)}" title="Supprimer">✕</button>`
                      : ""
                  }
                </div>`
                )
                .join("")}
              <button class="btn btn-xs btn-primary" id="btn-new-prof">+ Nouveau serveur</button>
            </div>
          </div>

          <div class="form-grid" id="prof-form">
            <div class="form-field">
              <label>Nom du profil *</label>
              <input id="pf-name" value="${esc(prof.name)}" />
            </div>
            <div class="form-field">
              <label>Mode</label>
              <select id="pf-mode" ${prof.id === "demo-simulator" ? "disabled" : ""}>
                <option value="live" ${isLive ? "selected" : ""}>Serveur XIQ-SE réel (Live)</option>
                <option value="demo" ${!isLive ? "selected" : ""}>Mode Démo (Simulateur local)</option>
              </select>
            </div>

            <div class="form-field">
              <label>Protocole</label>
              <select id="pf-proto">
                <option value="https" ${prof.protocol === "https" ? "selected" : ""}>HTTPS</option>
                <option value="http" ${prof.protocol === "http" ? "selected" : ""}>HTTP</option>
              </select>
            </div>
            <div class="form-field">
              <label>Adresse IP ou FQDN du serveur XIQ-SE *</label>
              <input id="pf-host" value="${esc(prof.host)}" placeholder="192.168.10.50 ou xiqse.entreprise.local" />
            </div>

            <div class="form-field">
              <label>Port (8443 par défaut)</label>
              <input id="pf-port" type="number" value="${esc(prof.port || 8443)}" />
            </div>
            <div class="form-field">
              <label>Chemin GraphQL NBI</label>
              <input id="pf-gql" value="${esc(prof.graphql_path || "/nbi/graphql")}" />
            </div>

            <div class="form-field">
              <label>Type d'authentification</label>
              <select id="pf-auth">
                <option value="oauth2" ${prof.auth_type === "oauth2" ? "selected" : ""}>OAuth 2.0 (Client ID &amp; Secret — Recommandé)</option>
                <option value="basic" ${prof.auth_type === "basic" ? "selected" : ""}>HTTP Basic Auth (Login &amp; Mot de passe)</option>
                <option value="bearer" ${prof.auth_type === "bearer" ? "selected" : ""}>Jeton Bearer manuel</option>
              </select>
            </div>
            <div class="form-field">
              <label>Endpoint OAuth 2.0 Token</label>
              <input id="pf-oauth-path" value="${esc(prof.oauth_path || "/oauth/token")}" />
            </div>

            <div class="form-field auth-oauth2">
              <label>Client ID</label>
              <input id="pf-cid" value="${esc(prof.client_id || "")}" placeholder="Client ID (Administration > Client API Access)" />
            </div>
            <div class="form-field auth-oauth2">
              <label>Client Secret</label>
              <input id="pf-csec" type="password" value="${esc(prof.client_secret || "")}" placeholder="Client Secret" />
            </div>

            <div class="form-field auth-basic">
              <label>Nom d'utilisateur</label>
              <input id="pf-user" value="${esc(prof.username || "")}" />
            </div>
            <div class="form-field auth-basic">
              <label>Mot de passe</label>
              <input id="pf-pass" type="password" value="${esc(prof.password || "")}" />
            </div>

            <div class="form-field full auth-bearer">
              <label>Jeton Bearer (Access Token)</label>
              <input id="pf-bearer" value="${esc(prof.bearer_token || "")}" placeholder="eyJhbGciOi..." />
            </div>

            <div class="form-field">
              <label>Timeout (secondes)</label>
              <input id="pf-timeout" type="number" value="${esc(prof.timeout || 30)}" />
            </div>
            <div class="form-field" style="justify-content:flex-end;">
              <label class="checkbox-row">
                <input type="checkbox" id="pf-ssl" ${prof.verify_ssl ? "checked" : ""} />
                <span>Vérifier le certificat SSL/TLS (décocher si auto-signé)</span>
              </label>
            </div>
          </div>
          <div id="pf-test-out" style="margin-top:12px;"></div>
        `,
        footerHtml: `
          <button class="btn btn-secondary" id="btn-pf-test">Tester la connexion</button>
          <button class="btn btn-ghost" onclick="XIQApi.closeModal()">Fermer</button>
          <button class="btn btn-primary" id="btn-pf-save">Enregistrer &amp; Activer</button>
        `,
        onMount: () => {
          const toggleAuthFields = () => {
            const at = document.getElementById("pf-auth").value;
            document.querySelectorAll(".auth-oauth2").forEach((el) => (el.style.display = at === "oauth2" ? "flex" : "none"));
            document.querySelectorAll(".auth-basic").forEach((el) => (el.style.display = at === "basic" ? "flex" : "none"));
            document.querySelectorAll(".auth-bearer").forEach((el) => (el.style.display = at === "bearer" ? "flex" : "none"));
          };
          toggleAuthFields();
          document.getElementById("pf-auth").addEventListener("change", toggleAuthFields);

          const collectForm = () => ({
            id: prof.id || undefined,
            name: document.getElementById("pf-name").value.trim(),
            mode: document.getElementById("pf-mode").value,
            protocol: document.getElementById("pf-proto").value,
            host: document.getElementById("pf-host").value.trim(),
            port: parseInt(document.getElementById("pf-port").value, 10) || 8443,
            graphql_path: document.getElementById("pf-gql").value.trim() || "/nbi/graphql",
            auth_type: document.getElementById("pf-auth").value,
            oauth_path: document.getElementById("pf-oauth-path").value.trim() || "/oauth/token",
            client_id: document.getElementById("pf-cid").value.trim(),
            client_secret: document.getElementById("pf-csec").value,
            username: document.getElementById("pf-user").value.trim(),
            password: document.getElementById("pf-pass").value,
            bearer_token: document.getElementById("pf-bearer").value.trim(),
            timeout: parseInt(document.getElementById("pf-timeout").value, 10) || 30,
            verify_ssl: document.getElementById("pf-ssl").checked,
            set_active: true,
          });

          document.querySelectorAll("[data-edit-prof]").forEach((btn) => {
            btn.addEventListener("click", () => openConnectionsModal(btn.dataset.editProf));
          });
          document.querySelectorAll("[data-del-prof]").forEach((btn) => {
            btn.addEventListener("click", async () => {
              const res = await XIQApi.deleteProfile(btn.dataset.delProf);
              state.profilesState = res.state;
              updateConnectionUI();
              openConnectionsModal();
            });
          });
          document.getElementById("btn-new-prof").addEventListener("click", () => openConnectionsModal(null));

          document.getElementById("btn-pf-test").addEventListener("click", async () => {
            const out = document.getElementById("pf-test-out");
            out.innerHTML = `<div class="alert-banner">Test de connexion en cours...</div>`;
            try {
              const res = await XIQApi.testConnection(collectForm());
              out.innerHTML = `<div class="alert-banner ${res.ok ? "" : "error"}">
                <div><strong>${res.ok ? "✓ Succès" : "✕ Échec"} (${res.duration_ms} ms) :</strong> ${esc(res.message)}</div>
              </div>`;
            } catch (err) {
              out.innerHTML = `<div class="alert-banner error">${esc(err.message)}</div>`;
            }
          });

          document.getElementById("btn-pf-save").addEventListener("click", async () => {
            const payload = collectForm();
            if (payload.mode === "live" && !payload.host) {
              return XIQApi.toast("Indiquez l'adresse IP ou FQDN du serveur XIQ-SE.", "warn");
            }
            const res = await XIQApi.saveProfile(payload);
            state.profilesState = res.state;
            StudioView.resetSchemaCache();
            updateConnectionUI();
            XIQApi.closeModal();
            XIQApi.toast(`Profil « ${res.profile.name} » activé.`, "success");
            navigate(state.currentView);
          });
        },
      });
    };

    drawModal(editing);
  }

  async function init() {
    // Load saved theme
    const savedTheme = localStorage.getItem("xiqse-theme") || "dark";
    document.documentElement.setAttribute("data-theme", savedTheme);

    // Sidebar navigation
    document.querySelectorAll(".nav-item").forEach((btn) => {
      btn.addEventListener("click", () => navigate(btn.dataset.view));
    });

    // Modal close handlers
    document.getElementById("modal-close").addEventListener("click", XIQApi.closeModal);
    document.getElementById("modal-backdrop").addEventListener("click", (e) => {
      if (e.target.id === "modal-backdrop") XIQApi.closeModal();
    });

    // Global click & right-click handlers for copy icons, Switch IPs, and MAC addresses
    document.addEventListener("click", (e) => {
      const copyBtn = e.target.closest("[data-copy-val]");
      if (copyBtn) {
        e.preventDefault();
        e.stopPropagation();
        const val = copyBtn.dataset.copyVal;
        if (val) XIQApi.copyText(val);
        return;
      }
      const ipLink = e.target.closest("[data-open-ip]");
      if (ipLink) {
        e.preventDefault();
        e.stopPropagation();
        const ip = ipLink.dataset.openIp;
        if (ip) XIQApi.openExternalUrl(`https://${ip}`);
        return;
      }
      const macEl = e.target.closest("[data-open-mac]");
      if (macEl) {
        e.preventDefault();
        e.stopPropagation();
        const mac = macEl.dataset.openMac;
        if (mac) navigate("locator", mac);
      }
    });

    document.addEventListener("contextmenu", (e) => {
      const target = e.target.closest("[data-right-copy]");
      if (!target) return;
      e.preventDefault();
      e.stopPropagation();
      const val = target.dataset.rightCopy;
      if (val) XIQApi.copyText(val);
    });

    // Global Express Locator search bar (Ctrl+K)
    const globalSearch = document.getElementById("topbar-global-search");
    if (globalSearch) {
      globalSearch.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && globalSearch.value.trim()) {
          const term = globalSearch.value.trim();
          globalSearch.blur();
          navigate("locator", term);
        }
      });
      document.addEventListener("keydown", (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
          e.preventDefault();
          globalSearch.focus();
          globalSearch.select();
        }
      });
    }

    // Topbar & Sidebar connection actions
    document.getElementById("btn-open-connections").addEventListener("click", () => {
      const act = getActiveProfile();
      openConnectionsModal(act?.id || null);
    });
    document.getElementById("sidebar-conn-card").addEventListener("click", () => {
      const act = getActiveProfile();
      openConnectionsModal(act?.id || null);
    });

    document.getElementById("topbar-profile-select").addEventListener("change", async (e) => {
      const res = await XIQApi.activateProfile(e.target.value);
      state.profilesState = res.state;
      StudioView.resetSchemaCache();
      updateConnectionUI();
      XIQApi.toast(`Connecté au profil : ${res.profile.name}`, "info");
      navigate(state.currentView);
    });

    document.getElementById("btn-test-conn").addEventListener("click", async () => {
      const res = await XIQApi.testConnection();
      XIQApi.toast(`${res.ok ? "✓" : "✕"} ${res.message} (${res.duration_ms} ms)`, res.ok ? "success" : "error");
    });

    document.getElementById("btn-refresh-view").addEventListener("click", () => navigate(state.currentView));

    document.getElementById("btn-theme-toggle").addEventListener("click", () => {
      const cur = document.documentElement.getAttribute("data-theme") || "dark";
      const next = cur === "dark" ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", next);
      localStorage.setItem("xiqse-theme", next);
    });

    // Initial data load
    try {
      state.profilesState = await XIQApi.getProfiles();
      updateConnectionUI();
      await navigate("dashboard");
    } catch (err) {
      document.getElementById("viewport").innerHTML = `<div class="alert-banner error">Erreur d'initialisation : ${esc(err.message)}</div>`;
    }
  }

  document.addEventListener("DOMContentLoaded", init);

  return {
    navigate,
    openConnectionsModal,
    getActiveProfile,
  };
})();
