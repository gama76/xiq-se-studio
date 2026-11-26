/* Schema-Adaptive Operational XIQ-SE Views (compatible with ALL live XIQ-SE versions + Demo Mode) */

window.OpsViews = (() => {
  const esc = XIQApi.escapeHtml;

  async function runOp(query, variables = {}, source = "ops") {
    return XIQApi.graphql(query, variables, {
      recordHistory: source !== "dashboard" && source !== "mac_audit",
      source,
    });
  }

  function openInStudio(query, variables = {}) {
    StudioView.setQuery(query, variables);
    window.XIQApp.navigate("studio");
  }

  function getActiveProfileId() {
    return window.XIQApp?.getActiveProfile?.()?.id || "default";
  }

  async function getSchema() {
    const info = await SchemaTools.ensureLiveSchema(getActiveProfileId(), false);
    return info.indexed;
  }

  async function runAdaptive(indexed, domainCandidates, fieldCandidates, opts = {}, source = "ops") {
    if (!indexed) return { available: false, ok: false, data: null, query: "", errors: [] };
    const built = SchemaTools.buildAdaptiveDomainQuery(indexed, domainCandidates, fieldCandidates, opts);
    if (!built) return { available: false, ok: false, data: null, query: "", errors: [] };
    const res = await runOp(built.query, {}, source);
    const extracted = SchemaTools.extractAdaptiveData(res, built);
    return {
      available: true,
      ok: res.ok,
      data: extracted,
      raw: res.data,
      query: built.query,
      meta: built,
      errors: res.errors || [],
    };
  }

  /**
   * Schema-adaptive paginated fetch supporting ALL XIQ-SE pagination styles:
   *  - Offset-based: (firstResult/offset/startIndex/skip + maxResults/limit/pageSize/count)
   *  - Page-based:   (pageNumber/pageNo/page/pageIndex + pageSize/maxResults/limit/count)
   *  - Input-object: optional INPUT_OBJECT arg containing page/offset + size fields
   *  - Size-only:    (maxResults/pageSize/limit/count without offset/page)
   * limitMode: "250" | "1000" | "2500" | "5000" | "all"
   */
  async function runAdaptivePaginated(
    indexed,
    domainCandidates,
    fieldCandidates,
    opts = {},
    source = "ops",
    limitMode = "250",
    onProgress = null
  ) {
    if (!indexed) return { available: false, ok: false, data: [], query: "", errors: [], truncatedByLimit: false, paginationMode: "none" };
    const targetMax = limitMode === "all" ? 50000 : Math.max(50, parseInt(limitMode, 10) || 250);

    // Inspect target field arguments to detect pagination support
    const dom = SchemaTools.getDomainType(indexed, domainCandidates, "query");
    const field = dom ? SchemaTools.findFieldByCandidates(indexed, dom.domainType, fieldCandidates) : null;
    if (!dom || !field) {
      return { available: false, ok: false, data: [], query: "", errors: [], truncatedByLimit: false, paginationMode: "none" };
    }

    const fieldArgs = field.args || [];
    const argNames = fieldArgs.map((a) => a.name);
    const maxArg = argNames.find((n) => /^(maxresults|limit|pagesize|count|maxcount|numresults|size)$/i.test(n));
    const offsetArg = argNames.find((n) => /^(firstresult|offset|startindex|start|skip|beginindex)$/i.test(n));
    const pageArg = !offsetArg
      ? argNames.find((n) => /^(pagenumber|pageno|page|pageindex|pagenum)$/i.test(n))
      : null;

    // Also check if pagination lives inside an optional INPUT_OBJECT argument
    let inputObjPagination = null;
    if (!maxArg && !offsetArg && !pageArg) {
      for (const a of fieldArgs) {
        const base = SchemaTools.unwrapType(a.type);
        const tDef = base ? SchemaTools.getType(indexed, base.name) : null;
        if (tDef && tDef.kind === "INPUT_OBJECT" && Array.isArray(tDef.inputFields)) {
          const inNames = tDef.inputFields.map((f) => f.name);
          const inMax = inNames.find((n) => /^(maxresults|limit|pagesize|count|maxcount|size)$/i.test(n));
          const inOff = inNames.find((n) => /^(firstresult|offset|startindex|start|skip)$/i.test(n));
          const inPage = !inOff ? inNames.find((n) => /^(pagenumber|pageno|page|pageindex|pagenum)$/i.test(n)) : null;
          if (inMax || inOff || inPage) {
            inputObjPagination = { argName: a.name, maxKey: inMax, offsetKey: inOff, pageKey: inPage };
            break;
          }
        }
      }
    }

    const extractItemKey = (item) => {
      if (item && typeof item === "object") {
        return String(item.macAddress || item.ip || item.ipAddress || item.deviceId || item.id || JSON.stringify(item)).toLowerCase();
      }
      return String(item).toLowerCase();
    };

    const buildPageArgsObj = (reqSize, cursorVal, mode) => {
      const baseArgs = { ...(opts.args || {}) };
      if (inputObjPagination) {
        const prevObj = (baseArgs[inputObjPagination.argName] && typeof baseArgs[inputObjPagination.argName] === "object")
          ? { ...baseArgs[inputObjPagination.argName] }
          : {};
        if (inputObjPagination.maxKey) prevObj[inputObjPagination.maxKey] = reqSize;
        if (mode === "offset" && inputObjPagination.offsetKey) prevObj[inputObjPagination.offsetKey] = cursorVal;
        if (mode === "page" && inputObjPagination.pageKey) prevObj[inputObjPagination.pageKey] = cursorVal;
        baseArgs[inputObjPagination.argName] = prevObj;
        return baseArgs;
      }
      if (maxArg) baseArgs[maxArg] = reqSize;
      if (mode === "offset" && offsetArg) baseArgs[offsetArg] = cursorVal;
      if (mode === "page" && pageArg) baseArgs[pageArg] = cursorVal;
      return baseArgs;
    };

    const hasOffsetMode = Boolean(offsetArg || inputObjPagination?.offsetKey);
    const hasPageMode = Boolean(pageArg || inputObjPagination?.pageKey);
    const hasMaxOnly = Boolean((maxArg || inputObjPagination?.maxKey) && !hasOffsetMode && !hasPageMode);
    const activePageName = pageArg || inputObjPagination?.pageKey || "";
    const paginationMode = hasOffsetMode
      ? `offset (${offsetArg || inputObjPagination.offsetKey} / ${maxArg || inputObjPagination.maxKey || "auto"})`
      : hasPageMode
        ? `page (${activePageName} / ${maxArg || inputObjPagination.maxKey || "auto"})`
        : hasMaxOnly
          ? `limit (${maxArg || inputObjPagination.maxKey})`
          : `none (args: ${argNames.join(", ") || "aucun"})`;

    // Case 1: No pagination arguments at all on this GraphQL field
    if (!hasOffsetMode && !hasPageMode && !hasMaxOnly) {
      const res = await runAdaptive(indexed, domainCandidates, [field.name], opts, source);
      const baseList = Array.isArray(res.data) ? res.data : [];

      // XIQ-SE specific workaround: on many versions, `network.devices` takes NO pagination arguments
      // and can be capped server-side (e.g. 250). When scope > 250, expand via `network.sites` +
      // batched `devicesBySiteLocation(location: ...)` and missing `devList` IPs via `device(ip: ...)`!
      const isNetworkDevices =
        dom.domainFieldName === "network" &&
        /^(devices|alldevices)$/i.test(field.name);
      const bySiteField = isNetworkDevices
        ? SchemaTools.findFieldByCandidates(indexed, dom.domainType, ["devicesBySiteLocation", "devicesBySite"])
        : null;
      const singleDevField = isNetworkDevices
        ? SchemaTools.findFieldByCandidates(indexed, dom.domainType, ["device", "deviceByIp"])
        : null;

      if (isNetworkDevices && targetMax > 250 && (bySiteField || singleDevField)) {
        const allItems = [];
        const seenKeys = new Set();
        baseList.forEach((item) => {
          const k = extractItemKey(item);
          if (!seenKeys.has(k)) {
            seenKeys.add(k);
            allItems.push(item);
          }
        });
        if (typeof onProgress === "function") onProgress(allItems.length, limitMode === "all" ? null : targetMax);

        const sitesRes = await runAdaptive(
          indexed,
          ["network"],
          ["sites", "allSites"],
          { preferredScalars: ["location", "sitePath", "name", "siteName", "devList"], includeAllScalars: false },
          source
        );
        const sites = Array.isArray(sitesRes.data) ? sitesRes.data : [];
        const siteLocations = Array.from(
          new Set(sites.map((s) => s?.location || s?.sitePath).filter(Boolean))
        );
        const siteDevIps = new Set();
        sites.forEach((s) => {
          if (Array.isArray(s?.devList)) {
            s.devList.forEach((ip) => {
              if (ip) siteDevIps.add(String(ip).trim());
            });
          }
        });

        // Build safe selection for Device type
        const devBase = SchemaTools.unwrapType(field.type);
        const devSel = devBase
          ? SchemaTools.buildSafeSelection(
              indexed,
              devBase.name,
              opts.preferredScalars || ["ip", "sysName", "deviceName", "status", "down", "sitePath"],
              opts.nestedSpecs || [],
              opts.includeAllScalars !== false
            )
          : "ip sysName deviceName status sitePath";

        let extraViaSites = 0;
        let extraViaIp = 0;

        // 1) Batched aliased `devicesBySiteLocation(location: ...)`
        if (bySiteField && siteLocations.length && devSel && allItems.length < targetMax) {
          const locArgName = (bySiteField.args || [])[0]?.name || "location";
          const batchSize = 8;
          for (let i = 0; i < siteLocations.length && allItems.length < targetMax; i += batchSize) {
            const chunk = siteLocations.slice(i, i + batchSize);
            const aliased = chunk
              .map((loc, idx) => `s${idx}: ${bySiteField.name}(${locArgName}: ${JSON.stringify(loc)}) { ${devSel} }`)
              .join("\n    ");
            const batchQ = `query BatchDevicesBySite {\n  ${dom.domainFieldName} {\n    ${aliased}\n  }\n}`;
            const bRes = await runOp(batchQ, {}, source, false);
            if (bRes.ok && bRes.data?.[dom.domainFieldName]) {
              const netObj = bRes.data[dom.domainFieldName];
              Object.values(netObj).forEach((arr) => {
                if (!Array.isArray(arr)) return;
                arr.forEach((item) => {
                  if (allItems.length >= targetMax) return;
                  const k = extractItemKey(item);
                  if (!seenKeys.has(k)) {
                    seenKeys.add(k);
                    allItems.push(item);
                    extraViaSites++;
                  }
                });
              });
              if (typeof onProgress === "function") onProgress(allItems.length, limitMode === "all" ? null : targetMax);
            }
          }
        }

        // 2) If sites.devList lists IPs still missing (e.g. a single huge site > 250), fetch by IP via `device(ip: ...)`
        if (singleDevField && siteDevIps.size && devSel && allItems.length < targetMax) {
          const missingIps = Array.from(siteDevIps).filter((ip) => !seenKeys.has(ip.toLowerCase()));
          const ipArgName = (singleDevField.args || []).find((a) => /ip/i.test(a.name))?.name || (singleDevField.args || [])[0]?.name || "ip";
          const ipBatchSize = 15;
          for (let i = 0; i < missingIps.length && allItems.length < targetMax; i += ipBatchSize) {
            const chunk = missingIps.slice(i, i + ipBatchSize);
            const aliased = chunk
              .map((ip, idx) => `d${idx}: ${singleDevField.name}(${ipArgName}: ${JSON.stringify(ip)}) { ${devSel} }`)
              .join("\n    ");
            const batchQ = `query BatchDevicesByIp {\n  ${dom.domainFieldName} {\n    ${aliased}\n  }\n}`;
            const bRes = await runOp(batchQ, {}, source, false);
            if (bRes.ok && bRes.data?.[dom.domainFieldName]) {
              const netObj = bRes.data[dom.domainFieldName];
              Object.values(netObj).forEach((item) => {
                if (!item || typeof item !== "object" || allItems.length >= targetMax) return;
                const k = extractItemKey(item);
                if (!seenKeys.has(k)) {
                  seenKeys.add(k);
                  allItems.push(item);
                  extraViaIp++;
                }
              });
              if (typeof onProgress === "function") onProgress(allItems.length, limitMode === "all" ? null : targetMax);
            }
          }
        }

        const totalExtra = extraViaSites + extraViaIp;
        const expandedMode = totalExtra > 0
          ? `multi-sites (+${totalExtra} via ${extraViaSites ? bySiteField.name : singleDevField.name})`
          : `complet (${allItems.length} équip. — ${siteLocations.length} site(s) vérifié(s))`;
        return {
          ...res,
          data: allItems,
          truncatedByLimit: Boolean(limitMode !== "all" && allItems.length >= targetMax),
          paginationMode: expandedMode,
        };
      }

      const maybeServerCapped = Boolean(
        isNetworkDevices &&
        (bySiteField || singleDevField) &&
        limitMode === "250" &&
        baseList.length >= 250
      );
      return {
        ...res,
        data: baseList,
        truncatedByLimit: maybeServerCapped,
        paginationMode: maybeServerCapped
          ? "plafond 250 possible — passez en portée supérieure (multi-sites)"
          : paginationMode,
      };
    }

    // Case 2: Fast 250 mode (single request)
    if (targetMax <= 250) {
      const startCursor = hasPageMode ? (/^(pagenumber|pageno|pagenum)$/i.test(activePageName) ? 1 : 0) : 0;
      const mode = hasOffsetMode ? "offset" : hasPageMode ? "page" : "max";
      let res = await runAdaptive(
        indexed,
        domainCandidates,
        [field.name],
        { ...opts, args: buildPageArgsObj(targetMax, startCursor, mode) },
        source
      );
      // Fallback if page=0 returned empty/error -> try page=1
      if (hasPageMode && startCursor === 0 && (!res.ok || !Array.isArray(res.data) || res.data.length === 0)) {
        const retry = await runAdaptive(
          indexed,
          domainCandidates,
          [field.name],
          { ...opts, args: buildPageArgsObj(targetMax, 1, "page") },
          source
        );
        if (retry.ok && Array.isArray(retry.data) && retry.data.length > 0) res = retry;
      }
      const list = Array.isArray(res.data) ? res.data : [];
      const truncatedByLimit = Boolean(limitMode !== "all" && list.length >= targetMax);
      return { ...res, data: list, truncatedByLimit, paginationMode };
    }

    // Case 3: Size-only argument (no offset/page argument) -> try targetMax with graceful fallback
    if (hasMaxOnly) {
      const trySizes = Array.from(new Set([Math.min(targetMax, 10000), 2500, 1000, 500, 250].filter((n) => n <= Math.max(targetMax, 250))));
      let lastRes = null;
      for (const sz of trySizes) {
        const res = await runAdaptive(
          indexed,
          domainCandidates,
          [field.name],
          { ...opts, args: buildPageArgsObj(sz, 0, "max") },
          source
        );
        lastRes = res;
        if (res.ok && Array.isArray(res.data)) {
          const truncatedByLimit = Boolean(limitMode !== "all" && res.data.length >= targetMax);
          return { ...res, data: res.data, truncatedByLimit, paginationMode };
        }
      }
      return { ...(lastRes || { available: true, ok: false, query: "", errors: [] }), data: [], truncatedByLimit: false, paginationMode };
    }

    // Case 4: Multi-page fetch (safe 250/page works on ALL XIQ-SE versions without hitting server pageSize caps!)
    const pageSize = 250;
    const allItems = [];
    const seenKeys = new Set();
    let lastQuery = "";
    let allErrors = [];
    let anyOk = false;
    let reachedEnd = false;
    const maxPagesGuard = 220;

    if (hasPageMode) {
      let pageNum = /^(pagenumber|pageno|pagenum)$/i.test(activePageName) ? 1 : 0;
      let triedZeroToOneFallback = false;
      for (let p = 0; p < maxPagesGuard && allItems.length < targetMax; p++) {
        const reqSize = Math.min(pageSize, targetMax - allItems.length);
        const res = await runAdaptive(
          indexed,
          domainCandidates,
          [field.name],
          { ...opts, args: buildPageArgsObj(reqSize, pageNum, "page") },
          source
        );
        lastQuery = res.query || lastQuery;
        if (res.errors && res.errors.length) allErrors = allErrors.concat(res.errors);
        if (!res.ok) {
          if (allItems.length === 0 && pageNum === 0 && !triedZeroToOneFallback) {
            triedZeroToOneFallback = true;
            pageNum = 1;
            continue;
          }
          if (allItems.length === 0) return { ...res, data: [], truncatedByLimit: false, paginationMode };
          break;
        }
        anyOk = true;
        const batch = Array.isArray(res.data) ? res.data : [];
        if (batch.length === 0) {
          if (allItems.length === 0 && pageNum === 0 && !triedZeroToOneFallback) {
            triedZeroToOneFallback = true;
            pageNum = 1;
            continue;
          }
          reachedEnd = true;
          break;
        }
        let added = 0;
        for (const item of batch) {
          const k = extractItemKey(item);
          if (!seenKeys.has(k)) {
            seenKeys.add(k);
            allItems.push(item);
            added++;
            if (allItems.length >= targetMax) break;
          }
        }
        if (typeof onProgress === "function") onProgress(allItems.length, limitMode === "all" ? null : targetMax);
        // Handle servers where page=0 and page=1 both return page 1 -> advance once to page 2!
        if (added === 0) {
          if (pageNum === 1 && !triedZeroToOneFallback) {
            triedZeroToOneFallback = true;
            pageNum = 2;
            continue;
          }
          reachedEnd = true;
          break;
        }
        if (batch.length < Math.min(reqSize, 50)) {
          reachedEnd = true;
          break;
        }
        pageNum += 1;
      }
    } else {
      // Offset mode: advance by batch.length so server-side caps (< reqSize) never skip items!
      let offset = 0;
      for (let p = 0; p < maxPagesGuard && allItems.length < targetMax; p++) {
        const reqSize = Math.min(pageSize, targetMax - allItems.length);
        const res = await runAdaptive(
          indexed,
          domainCandidates,
          [field.name],
          { ...opts, args: buildPageArgsObj(reqSize, offset, "offset") },
          source
        );
        lastQuery = res.query || lastQuery;
        if (res.errors && res.errors.length) allErrors = allErrors.concat(res.errors);
        if (!res.ok) {
          if (allItems.length === 0) return { ...res, data: [], truncatedByLimit: false, paginationMode };
          break;
        }
        anyOk = true;
        const batch = Array.isArray(res.data) ? res.data : [];
        if (batch.length === 0) {
          reachedEnd = true;
          break;
        }
        let added = 0;
        for (const item of batch) {
          const k = extractItemKey(item);
          if (!seenKeys.has(k)) {
            seenKeys.add(k);
            allItems.push(item);
            added++;
            if (allItems.length >= targetMax) break;
          }
        }
        if (typeof onProgress === "function") onProgress(allItems.length, limitMode === "all" ? null : targetMax);
        if (added === 0 || batch.length < Math.min(reqSize, 50)) {
          reachedEnd = true;
          break;
        }
        offset += batch.length;
      }
    }

    const truncatedByLimit = !reachedEnd && limitMode !== "all" && allItems.length >= targetMax;
    return {
      available: true,
      ok: anyOk,
      data: allItems,
      query: lastQuery,
      errors: allErrors,
      truncatedByLimit,
      paginationMode,
    };
  }

  function renderLimitSelect(id, currentLimit, paginationMode = "") {
    const cur = String(currentLimit || "250");
    const tip = paginationMode
      ? `Nombre maximum d'éléments chargés depuis XIQ-SE · Pagination API détectée : ${paginationMode}`
      : "Nombre maximum d'éléments chargés depuis XIQ-SE";
    return `
      <label style="display:inline-flex;align-items:center;gap:5px;font-size:12px;color:var(--text-secondary);" title="${esc(tip)}">
        <span>Portée :</span>
        <select id="${id}" style="padding:4px 8px;font-size:12px;">
          <option value="250" ${cur === "250" ? "selected" : ""}>250 (Rapide)</option>
          <option value="1000" ${cur === "1000" ? "selected" : ""}>1 000</option>
          <option value="2500" ${cur === "2500" ? "selected" : ""}>2 500</option>
          <option value="5000" ${cur === "5000" ? "selected" : ""}>5 000</option>
          <option value="all" ${cur === "all" ? "selected" : ""}>Toute la base</option>
        </select>
      </label>`;
  }

  function renderErrorBanner(errors, query) {
    if (!errors || !errors.length) return "";
    const msg = errors.map((e) => e.message || String(e)).join(" | ");
    return `<div class="alert-banner error">
      <div><strong>Erreur API XIQ-SE :</strong> ${esc(msg)}</div>
      ${query ? `<button class="btn btn-xs btn-secondary" data-open-studio="1">Adapter dans Studio GraphQL</button>` : ""}
    </div>`;
  }

  function bindOpenStudio(container, query, variables = {}) {
    container.querySelectorAll("[data-open-studio]").forEach((btn) => {
      btn.addEventListener("click", () => openInStudio(query, variables));
    });
  }

  function renderDynamicTable(rows, emptyMsg = "Aucune donnée retournée.", maxRows = 500) {
    if (!Array.isArray(rows) || !rows.length) {
      return `<div class="empty-state">${esc(emptyMsg)}</div>`;
    }
    const flatRows = rows.map((r) => (r && typeof r === "object" ? SchemaTools.extractTableRows([r])[0] : { valeur: r }));
    const cols = Array.from(
      flatRows.reduce((s, r) => {
        Object.keys(r || {}).forEach((k) => s.add(k));
        return s;
      }, new Set())
    ).slice(0, 14);
    const shown = flatRows.slice(0, maxRows);
    return `<div class="table-wrap"><table>
      <thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead>
      <tbody>
        ${shown
          .map((r) => `<tr>${cols.map((c) => {
            const val = r?.[c];
            if (/^(ip|switchip|sourceip|deviceip|ipaddress|ip_switch)$/i.test(c) && /^\d{1,3}(\.\d{1,3}){3}$/.test(String(val || "").trim())) {
              return `<td class="mono">${XIQApi.switchIpLink(val)}</td>`;
            }
            return `<td class="mono">${esc(val)}</td>`;
          }).join("")}</tr>`)
          .join("")}
      </tbody>
    </table></div>${flatRows.length > maxRows ? `<div style="padding:8px 12px;font-size:11.5px;color:var(--text-muted);border-top:1px solid var(--border);">Affichage des ${maxRows} premières lignes sur ${flatRows.length}.</div>` : ""}`;
  }

  function renderKeyValueTable(obj) {
    if (!obj || typeof obj !== "object") return `<div class="empty-state">Aucune donnée disponible.</div>`;
    const entries = Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && v !== "");
    if (!entries.length) return `<div class="empty-state">Aucune propriété renseignée.</div>`;
    return `<div class="table-wrap"><table><tbody>
      ${entries
        .map(
          ([k, v]) => `<tr>
            <td style="width:36%;color:var(--text-secondary);font-weight:600;">${esc(k)}</td>
            <td class="mono">${esc(typeof v === "object" ? JSON.stringify(v) : v)}</td>
          </tr>`
        )
        .join("")}
    </tbody></table></div>`;
  }

  function renderDomainCatalogPanel(indexed, domainCandidates, title) {
    if (!indexed) return "";
    const queries = SchemaTools.listCallableDomainQueries(indexed, domainCandidates);
    const mutations = SchemaTools.listDomainMutations(indexed, domainCandidates);
    if (!queries.length && !mutations.length) return "";
    return `<div class="panel" style="margin-top:16px;">
      <div class="panel-header">
        <div class="panel-title">${esc(title)} (détectées dans votre schéma XIQ-SE)</div>
        <span class="badge badge-cyan">${queries.length} queries · ${mutations.length} mutations</span>
      </div>
      <div class="panel-body">
        <div style="display:flex;gap:6px;flex-wrap:wrap;">
          ${queries
            .slice(0, 35)
            .map(
              (q) => `<button class="btn btn-xs btn-secondary" data-gen-op="query" data-gen-dom="${esc(q.domainName)}" data-gen-fn="${esc(q.field.name)}" title="${esc(q.field.description || "")}">Q: ${esc(q.field.name)}</button>`
            )
            .join("")}
          ${mutations
            .slice(0, 35)
            .map(
              (m) => `<button class="btn btn-xs btn-ghost" style="border-color:rgba(245,158,11,0.45);color:var(--amber);" data-gen-op="mutation" data-gen-dom="${esc(m.domainName)}" data-gen-fn="${esc(m.field.name)}" title="${esc(m.field.description || "")}">M: ${esc(m.field.name)}</button>`
            )
            .join("")}
        </div>
      </div>
    </div>`;
  }

  function bindDomainCatalogButtons(viewport, indexed) {
    if (!indexed) return;
    viewport.querySelectorAll("[data-gen-fn]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const op = btn.dataset.genOp;
        const dom = btn.dataset.genDom;
        const fn = btn.dataset.genFn;
        const groups = op === "mutation" ? indexed.mutationGroups : indexed.queryGroups;
        const grp = groups.find((g) => g.domain === dom);
        const fieldObj = grp?.fields.find((f) => f.name === fn);
        if (!fieldObj) return;
        const snippet = SchemaTools.buildOperationSnippet(indexed, fieldObj);
        openInStudio(snippet.query, snippet.variables);
      });
    });
  }

  function isDeviceUp(dev) {
    if (!dev || typeof dev !== "object") return false;
    if (typeof dev.down === "boolean") return !dev.down;
    const s = dev.status ?? dev.lastStatus;
    if (typeof s === "boolean") return s;
    if (typeof s === "number") return s === 1;
    const str = String(s || "").toLowerCase();
    return str === "1" || str === "up" || str === "true" || str === "online" || str === "reachable";
  }

  function siteDisplayName(s) {
    if (!s) return "Site";
    if (s.name) return s.name;
    if (s.siteName) return s.siteName;
    if (s.location) {
      const parts = String(s.location).split("/").filter(Boolean);
      return parts[parts.length - 1] || s.location;
    }
    return s.siteId || "Site";
  }

  const ALARM_NESTED_SPECS = [
    { candidates: ["device", "sourceDevice", "switch"], preferred: ["ip", "ipAddress", "sysName", "deviceName", "name", "sitePath"] },
    { candidates: ["source", "origin", "target"], preferred: ["ip", "ipAddress", "name", "sysName", "macAddress"] },
    { candidates: ["endSystem", "client"], preferred: ["macAddress", "ipAddress", "hostName", "username"] },
    { candidates: ["port", "interface"], preferred: ["name", "ifName", "alias"] },
  ];

  function scoreAlarmOp(op) {
    const n = String(op?.field?.name || "").toLowerCase();
    const d = String(op?.domainName || "").toLowerCase();
    let score = 0;
    if (/^(activealarms|alarms|allalarms|currentalarms|openalarms)$/.test(n)) score += 100;
    else if (/^(alarmevents|alarmhistory|devicealarms|networkalarms|alerts|faults|incidents)$/.test(n)) score += 75;
    else if (/alarm|alert|fault/.test(n)) score += 40;
    if (/alarm|fault|alert|monitor/.test(d)) score += 20;
    if (d === "(racine)") score += 10;
    // Penalize configuration / definition / metadata queries so real alarms always win
    if (/def|config|rule|action|template|setting|policy|filter|criteria|count|summary|stat|type|categor|severity|enable|disable|email|notif/.test(n)) {
      score -= 120;
    }
    return score;
  }

  function scoreEventOp(op) {
    const n = String(op?.field?.name || "").toLowerCase();
    const d = String(op?.domainName || "").toLowerCase();
    let score = 0;
    if (/^(events|recentevents|allevents|eventlogs|eventhistory|systemevents|networkevents)$/.test(n)) score += 100;
    else if (/^(auditevents|auditlogs|syslogevents|trapevents|nacevents|logs)$/.test(n)) score += 75;
    else if (/event|log|trap|syslog|audit/.test(n)) score += 35;
    if (/alarm|event|log|audit|monitor|admin/.test(d)) score += 15;
    if (d === "(Racine)" || d === "(racine)") score += 10;
    // Penalize server config / definitions / receivers
    if (/server|receiver|config|def|rule|setting|template|filter|policy|count|summary|stat|type|categor|login|logout|password|catalog/.test(n)) {
      score -= 120;
    }
    return score;
  }

  function formatFlexTimestamp(raw) {
    if (raw === null || raw === undefined || raw === "") return "";
    if (typeof raw === "number" || /^\d{10,13}$/.test(String(raw).trim())) {
      const n = Number(raw);
      const ms = n < 1e12 ? n * 1000 : n;
      const dt = new Date(ms);
      if (!isNaN(dt.getTime())) return dt.toISOString().slice(0, 19).replace("T", " ");
    }
    return String(raw).slice(0, 19).replace("T", " ");
  }

  function normalizeAlarmRecord(a) {
    if (!a || typeof a !== "object") {
      return { raw: a, id: "", severity: "Info", sourceName: "—", sourceIp: "", message: String(a || ""), timestamp: "", acknowledged: false };
    }
    const dev = a.device || a.sourceDevice || a.switch || a.source || {};
    const id = a.id ?? a.alarmId ?? a.eventId ?? "";
    const severity = String(a.severity ?? a.alarmSeverity ?? a.level ?? a.priority ?? "Info");
    const sourceIp =
      a.sourceIp ?? a.deviceIp ?? a.ipAddress ?? a.ip ??
      (typeof dev === "object" ? (dev.ip ?? dev.ipAddress ?? "") : "");
    const sourceName =
      a.sourceName ?? a.deviceName ?? a.sysName ??
      (typeof dev === "object" ? (dev.sysName ?? dev.deviceName ?? dev.name ?? "") : (typeof a.source === "string" ? a.source : "")) ??
      sourceIp ?? "—";
    const msgParts = [
      a.alarmName || a.name || a.title || "",
      a.message || a.description || a.info || a.reason || a.summary || "",
    ].filter(Boolean);
    const message = msgParts.length > 1 && !msgParts[1].includes(msgParts[0])
      ? `${msgParts[0]} — ${msgParts[1]}`
      : (msgParts[0] || "");
    const rawTs = a.lastOccurrenceTime ?? a.occurredTime ?? a.occuredTime ?? a.timestamp ?? a.createTime ?? a.time ?? a.date ?? "";
    const acknowledged = Boolean(a.acknowledged ?? a.isAcknowledged ?? a.ack);
    return {
      raw: a,
      id: String(id),
      severity,
      sourceName: String(sourceName || sourceIp || "—"),
      sourceIp: String(sourceIp || ""),
      message: String(message),
      timestamp: formatFlexTimestamp(rawTs),
      acknowledged,
    };
  }

  function matchesSeverityFilter(sevRaw, filter) {
    if (filter === "ALL") return true;
    const s = String(sevRaw || "").toLowerCase();
    if (filter === "Critical") return /crit|fatal|emerg/.test(s);
    if (filter === "Error") return /err|major|severe|high/.test(s);
    if (filter === "Warning") return /warn|minor|med/.test(s);
    if (filter === "Info") return /info|notice|low|clear|normal/.test(s);
    return s === filter.toLowerCase();
  }

  async function probeDiscoveredOps(indexed, ops, scoreFn, wrapperCands, timeWindowDays, source, preferredKey = "") {
    const sorted = [...ops].sort((a, b) => scoreFn(b) - scoreFn(a));
    const callable = sorted.filter((o) => o.callable);
    const probes = [];
    const workingSources = [];
    const candidatesToTry = callable.slice(0, 8);

    // Ensure explicitly selected source is always probed even if ranked beyond 8
    if (preferredKey) {
      const explicit = callable.find((o) => `${o.domainName}.${o.field.name}` === preferredKey);
      if (explicit && !candidatesToTry.includes(explicit)) candidatesToTry.unshift(explicit);
    }

    for (const op of candidatesToTry) {
      const key = `${op.domainName}.${op.field.name}`;
      const score = scoreFn(op);
      const res = await runAdaptive(
        indexed,
        [op.domainName],
        [op.field.name],
        {
          timeWindowDays,
          wrapperCandidates: wrapperCands,
          nestedSpecs: ALARM_NESTED_SPECS,
          includeAllScalars: true,
        },
        source
      );
      const isArr = res.ok && Array.isArray(res.data);
      const items = isArr ? res.data : (res.ok && res.data && typeof res.data === "object" ? [res.data] : []);
      const errMsg = (res.errors || []).map((e) => e.message || String(e)).join(" | ");
      const probe = {
        key,
        domainName: op.domainName,
        fieldName: op.field.name,
        score,
        ok: res.ok && isArr,
        rawOk: res.ok,
        count: items.length,
        items,
        query: res.query || "",
        errors: res.errors || [],
        errorMsg: errMsg,
      };
      probes.push(probe);
      if (probe.ok) workingSources.push(probe);
    }

    let chosen = null;
    if (preferredKey) {
      chosen = workingSources.find((p) => p.key === preferredKey) || null;
    }
    if (!chosen) {
      // Prefer first non-config source that actually returned >= 1 item
      chosen = workingSources.find((p) => p.score >= 0 && p.count > 0)
        || workingSources.find((p) => p.count > 0)
        || workingSources.find((p) => p.score >= 0)
        || workingSources[0]
        || null;
    }

    return { chosen, probes, workingSources };
  }

  const ALARM_QUERY_TOKENS = ["alarm", "alarms", "alert", "alerts", "fault", "faults", "incident", "incidents"];
  const EVENT_QUERY_TOKENS = ["event", "events", "trap", "traps", "syslog", "syslogs", "audit", "audits", "eventlog", "eventlogs", "auditlog", "auditlogs"];

  // Helper: discover and fetch alarms from ANY matching root/domain field in live __schema or Device.alarms
  async function fetchDiscoveredAlarms(indexed, timeWindowDays = 7, source = "alarms", preferredKey = "") {
    if (!indexed) return { available: false, items: [], query: "", sourceLabel: "", matchedOps: [], errors: [], probes: [], workingSources: [] };
    const matchedOps = SchemaTools.findFieldsByTokens(indexed, ALARM_QUERY_TOKENS, "query");

    const { chosen, probes, workingSources } = await probeDiscoveredOps(
      indexed,
      matchedOps,
      scoreAlarmOp,
      ["alarms", "activeAlarms", "alarmEvents", "alarmHistory", "alerts", "faults", "items", "results", "list", "data"],
      timeWindowDays,
      source,
      preferredKey
    );

    if (chosen && (chosen.count > 0 || preferredKey)) {
      return {
        available: true,
        items: chosen.items,
        query: chosen.query,
        sourceLabel: chosen.key,
        matchedOps,
        errors: chosen.errors,
        probes,
        workingSources,
      };
    }

    // Also check if Device type itself exposes an `alarms` sub-field (network.devices { ip sysName alarms { ... } })
    const netDom = SchemaTools.getDomainType(indexed, ["network"], "query");
    const devField = netDom ? SchemaTools.findFieldByCandidates(indexed, netDom.domainType, ["devices", "allDevices"]) : null;
    const devBase = devField ? SchemaTools.unwrapType(devField.type) : null;
    const devType = devBase ? SchemaTools.getType(indexed, devBase.name) : null;
    const devAlarmField = devType ? SchemaTools.findFieldByCandidates(indexed, devType, ["alarms", "activeAlarms", "alarmList", "alarmEvents"]) : null;
    if (devAlarmField && !(devAlarmField.args || []).some((a) => SchemaTools.isNonNull(a.type))) {
      const res = await runAdaptivePaginated(
        indexed,
        ["network"],
        [devField.name],
        {
          preferredScalars: ["ip", "sysName", "deviceName"],
          nestedSpecs: [{ candidates: [devAlarmField.name], includeAllScalars: true }],
          includeAllScalars: false,
        },
        source,
        "all"
      );
      if (res.ok && Array.isArray(res.data)) {
        const flat = [];
        res.data.forEach((d) => {
          const arr = d?.[devAlarmField.name];
          if (Array.isArray(arr)) {
            arr.forEach((a) => flat.push({ sourceName: d.sysName || d.deviceName || d.ip, sourceIp: d.ip, ...(typeof a === "object" ? a : { message: a }) }));
          }
        });
        const devProbe = {
          key: `network.${devField.name}.${devAlarmField.name}`,
          domainName: "network",
          fieldName: `${devField.name}.${devAlarmField.name}`,
          score: 50,
          ok: true,
          rawOk: true,
          count: flat.length,
          items: flat,
          query: res.query || "",
          errors: res.errors || [],
          errorMsg: "",
        };
        probes.push(devProbe);
        workingSources.push(devProbe);
        if (flat.length > 0 || !chosen) {
          return {
            available: true,
            items: flat,
            query: res.query,
            sourceLabel: devProbe.key,
            matchedOps,
            errors: res.errors || [],
            probes,
            workingSources,
          };
        }
      }
    }

    if (chosen) {
      return {
        available: true,
        items: chosen.items,
        query: chosen.query,
        sourceLabel: chosen.key,
        matchedOps,
        errors: chosen.errors,
        probes,
        workingSources,
      };
    }

    const probeErrors = probes.flatMap((p) => p.errors || []);
    return { available: false, items: [], query: probes[0]?.query || "", sourceLabel: "", matchedOps, errors: probeErrors, probes, workingSources };
  }

  // =========================================================================
  // 1. DASHBOARD (Schema-Adaptive + Isolated Domain Probes)
  // =========================================================================
  async function renderDashboard(viewport) {
    viewport.classList.remove("studio-mode");
    viewport.innerHTML = `<div class="loading-state">Introspection du schéma XIQ-SE &amp; chargement de la télémétrie...</div>`;

    const indexed = await getSchema();
    if (!indexed) {
      viewport.innerHTML = `<div class="alert-banner error">
        <div>Impossible d'introspecter le schéma GraphQL de ce serveur XIQ-SE. Vérifiez la connexion ou importez le fichier <strong>NBI Schema (JSON)</strong> dans Studio GraphQL.</div>
        <button class="btn btn-xs btn-primary" onclick="XIQApp.navigate('studio')">Ouvrir Studio GraphQL</button>
      </div>`;
      return;
    }

    // Run independent adaptive queries per domain so no single missing field or permission blocks the dashboard!
    const [devRes, siteRes, nacAllMacsRes, nacEsRes, nacAppRes, nacGrpRes, srvRes, almRes] = await Promise.all([
      runAdaptivePaginated(
        indexed,
        ["network"],
        ["devices", "allDevices"],
        {
          preferredScalars: ["ip", "sysName", "deviceName", "name", "status", "down", "lastStatus", "up", "deviceDisplayFamily", "family", "sitePath", "firmware", "sysUpTime"],
          includeAllScalars: false,
        },
        "dashboard",
        "2500"
      ),
      runAdaptive(
        indexed,
        ["network"],
        ["sites", "allSites"],
        {
          preferredScalars: ["siteId", "name", "siteName", "location", "devList"],
          includeAllScalars: false,
        },
        "dashboard"
      ),
      runAdaptive(
        indexed,
        ["accessControl"],
        ["allEndSystemMacs"],
        {},
        "dashboard"
      ),
      runAdaptive(
        indexed,
        ["accessControl"],
        ["endSystems", "allEndSystemsAsProperties", "allEndSystems"],
        {
          args: { maxResults: 500, firstResult: 0 },
          wrapperCandidates: ["endSystem", "endSystems", "results", "items"],
          preferredScalars: [
            "macAddress", "ipAddress", "state", "authorizationState", "status",
            "authType", "authorizationType", "profile", "nacProfile", "profileName",
            "policy", "policyName", "ruleName", "vlan", "vlanName",
            "operatingSystemName", "operatingSystem", "category",
            "lastSeenTime", "lastAuthEventTime", "updateTime", "firstSeenTime",
          ],
          includeAllScalars: true,
        },
        "dashboard"
      ),
      runAdaptive(
        indexed,
        ["accessControl"],
        ["appliances", "engines", "nacAppliances", "allAppliances"],
        {
          preferredScalars: ["displayName", "name", "hostName", "ipAddress", "ip", "status", "state", "version", "engineGroup", "activeEndSystems", "endSystemCount"],
          includeAllScalars: true,
        },
        "dashboard"
      ),
      runAdaptive(
        indexed,
        ["accessControl"],
        ["endSystemGroups", "groups", "allGroups", "groupNames"],
        {
          preferredScalars: ["name", "groupName", "type"],
          includeAllScalars: false,
        },
        "dashboard"
      ),
      runAdaptive(
        indexed,
        ["administration"],
        ["serverInfo"],
        {
          preferredScalars: ["version", "hostName", "serverName", "ipAddress", "upTime", "cpuPercent", "memoryPercent", "diskPercent", "managedDevicesCount", "licensedDevicesMax"],
          includeAllScalars: true,
        },
        "dashboard"
      ),
      fetchDiscoveredAlarms(indexed, 7, "dashboard"),
    ]);

    const devices = Array.isArray(devRes.data) ? devRes.data : [];
    const sites = Array.isArray(siteRes.data) ? siteRes.data : [];
    const allNacMacs = Array.isArray(nacAllMacsRes.data) ? nacAllMacsRes.data : [];
    const endSystems = Array.isArray(nacEsRes.data) ? nacEsRes.data : [];
    const appliances = Array.isArray(nacAppRes.data) ? nacAppRes.data : [];
    const nacGroups = Array.isArray(nacGrpRes.data) ? nacGrpRes.data : [];
    const alarms = Array.isArray(almRes.items) ? almRes.items : [];
    const srv = srvRes.data && typeof srvRes.data === "object" && !Array.isArray(srvRes.data) ? srvRes.data : {};

    const upCount = devices.filter(isDeviceUp).length;
    const downCount = devices.length - upCount;
    const upPct = devices.length ? Math.round((upCount / devices.length) * 100) : 100;
    const critAlarms = alarms
      .map(normalizeAlarmRecord)
      .filter((a) => (matchesSeverityFilter(a.severity, "Critical") || matchesSeverityFilter(a.severity, "Error")) && !a.acknowledged)
      .length;
    const applianceSessions = appliances.reduce((s, a) => s + (Number(a.activeEndSystems ?? a.endSystemCount) || 0), 0);
    const totalSessions = Math.max(applianceSessions, allNacMacs.length, endSystems.length);

    // Compute NAC statistics from endSystems sample
    let nacAccept = 0;
    let nacBlocked = 0;
    let nacOther = 0;
    const authCounts = {};
    const profileCounts = {};
    const vlanCounts = {};
    const nowMsDash = Date.now();
    let seenLast24h = 0;

    endSystems.forEach((es) => {
      const st = String(es?.state || es?.authorizationState || es?.status || "").trim();
      if (/accept|auth|allow|ok|pass|up/i.test(st)) nacAccept++;
      else if (/quarant|reject|block|deny|fail|black/i.test(st)) nacBlocked++;
      else nacOther++;

      const auth = String(es?.authType || es?.authorizationType || "Non renseigné").trim() || "Non renseigné";
      authCounts[auth] = (authCounts[auth] || 0) + 1;

      const prof = String(
        es?.profile || es?.nacProfile || es?.profileName || es?.policy || es?.policyName || es?.ruleName || "Sans profil"
      ).trim() || "Sans profil";
      profileCounts[prof] = (profileCounts[prof] || 0) + 1;

      const vlanVal = es?.vlanName || (es?.vlan !== undefined && es?.vlan !== null && String(es.vlan).trim() !== "" ? `VLAN ${es.vlan}` : "");
      if (vlanVal) {
        vlanCounts[vlanVal] = (vlanCounts[vlanVal] || 0) + 1;
      }

      const ts = parseTimestampMs(es?.lastSeenTime ?? es?.lastAuthEventTime ?? es?.updateTime ?? es?.firstSeenTime);
      if (ts !== null && nowMsDash - ts <= 86400000) seenLast24h++;
    });

    const nacSampleTotal = endSystems.length;
    const nacAcceptPct = nacSampleTotal ? Math.round((nacAccept / nacSampleTotal) * 100) : 0;
    const nacBlockedPct = nacSampleTotal ? Math.round((nacBlocked / nacSampleTotal) * 100) : 0;
    const nacOtherPct = Math.max(0, 100 - nacAcceptPct - nacBlockedPct);

    const topProfiles = Object.entries(profileCounts).sort((a, b) => b[1] - a[1]).slice(0, 6);
    const maxProfCount = Math.max(1, ...topProfiles.map((x) => x[1]));
    const topAuths = Object.entries(authCounts).sort((a, b) => b[1] - a[1]).slice(0, 5);
    const maxAuthCount = Math.max(1, ...topAuths.map((x) => x[1]));
    const topVlans = Object.entries(vlanCounts).sort((a, b) => b[1] - a[1]).slice(0, 6);

    // Build site counts (either from site.devList or grouped by device.sitePath!)
    let siteBars = [];
    if (sites.length) {
      siteBars = sites.map((s) => {
        const loc = s.location || "";
        const cnt = Array.isArray(s.devList)
          ? s.devList.length
          : devices.filter((d) => d.sitePath && loc && d.sitePath === loc).length;
        return { name: siteDisplayName(s), count: cnt };
      });
    } else if (devices.length) {
      const map = {};
      devices.forEach((d) => {
        const k = d.sitePath || "(Sans site)";
        map[k] = (map[k] || 0) + 1;
      });
      siteBars = Object.entries(map).map(([name, count]) => ({ name, count }));
    }
    siteBars.sort((a, b) => b.count - a.count);
    const maxSiteCount = Math.max(1, ...siteBars.map((x) => x.count));

    // Load persisted/in-memory MAC audit summary for the active profile if available
    let auditSummary =
      auditState.profileId === getActiveProfileId() && auditState.stats
        ? { ...auditState.stats, lastRunAt: auditState.lastRunAt }
        : null;
    if (!auditSummary) {
      const savedAudit = await XIQApi.getAuditSummary().catch(() => ({ summary: null }));
      if (savedAudit?.summary && savedAudit.summary.neverSeenCount !== undefined) {
        auditSummary = savedAudit.summary;
      }
    }

    const errors = [devRes, siteRes, srvRes]
      .flatMap((r) => r.errors || [])
      .filter(Boolean);

    const schemaInfo = SchemaTools.getCachedSchemaInfo();
    const rootDomains = (indexed.queryGroups || []).map((g) => g.domain);

    viewport.innerHTML = `
      ${renderErrorBanner(errors, devRes.query)}
      <div class="alert-banner">
        <div>
          <strong>Schéma API détecté automatiquement :</strong> ${esc(schemaInfo.sourceLabel)} —
          <strong>${indexed.counts.queries}</strong> queries · <strong>${indexed.counts.mutations}</strong> mutations ·
          Domaines : ${rootDomains.map((d) => `<span class="badge badge-purple" style="margin-left:3px;">${esc(d)}</span>`).join("")}
        </div>
        <button class="btn btn-xs btn-primary" onclick="XIQApp.navigate('studio')">Explorer 100% du schéma</button>
      </div>

      <div class="kpi-grid">
        <div class="kpi-card">
          <div class="kpi-label">Équipements Réseau</div>
          <div class="kpi-value">${devices.length}</div>
          <div class="kpi-sub"><span class="badge badge-green">${upCount} Up</span> <span class="badge ${downCount ? "badge-red" : "badge-muted"}">${downCount} Down</span></div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Disponibilité Parc</div>
          <div class="kpi-value" style="color:${upPct >= 95 ? "var(--green)" : "var(--amber)"};">${upPct}%</div>
          <div class="kpi-sub">${siteBars.length} site(s) détecté(s)</div>
        </div>
        <div class="kpi-card" style="cursor:pointer;" onclick="XIQApp.navigate('nac')">
          <div class="kpi-label">End-Systems / NAC</div>
          <div class="kpi-value" style="color:var(--cyan);">${totalSessions.toLocaleString("fr-FR")}</div>
          <div class="kpi-sub">${appliances.length ? `${appliances.length} moteur(s)` : ""}${appliances.length && nacGroups.length ? " · " : ""}${nacGroups.length ? `${nacGroups.length} groupes NAC` : nacEsRes.available ? `${endSystems.length} terminaux` : "Module NAC non exposé"}</div>
        </div>
        <div class="kpi-card" style="cursor:pointer;" onclick="XIQApp.navigate('alarms')">
          <div class="kpi-label">${almRes.available ? "Alarmes Actives" : "Alertes Disponibilité"}</div>
          <div class="kpi-value" style="color:${(almRes.available ? critAlarms : downCount) ? "var(--red)" : "var(--green)"};">${almRes.available ? alarms.length : downCount}</div>
          <div class="kpi-sub">${almRes.available ? `${critAlarms} critique(s)/erreur(s)` : downCount ? `${downCount} équipement(s) Down (NBI sans table alarms)` : "0 équipement Down · Voir diagnostic"}</div>
        </div>
        ${auditSummary ? (() => {
          const pct = auditSummary.totalUniqueGroupMacs
            ? Math.round((auditSummary.neverSeenCount / auditSummary.totalUniqueGroupMacs) * 100)
            : 0;
          const when = auditSummary.lastRunAt
            || (auditSummary.updated_at ? new Date(auditSummary.updated_at).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "");
          const dupCount = auditSummary.duplicateCount ?? null;
          return `
        <div class="kpi-card" style="cursor:pointer;border-color:${auditSummary.neverSeenCount ? "rgba(239,68,68,0.45)" : "rgba(34,197,94,0.45)"};" onclick="XIQApp.navigate('mac_audit')" title="Ouvrir l'Audit MAC Jamais Vues">
          <div class="kpi-label">MAC Jamais Vues (Audit)</div>
          <div class="kpi-value" style="color:${auditSummary.neverSeenCount ? "var(--red)" : "var(--green)"};">${auditSummary.neverSeenCount}</div>
          <div class="kpi-sub">${pct}% sur ${auditSummary.totalUniqueGroupMacs ?? 0} MAC${when ? ` · ${esc(when)}` : ""}</div>
        </div>
        ${dupCount !== null ? `
        <div class="kpi-card" style="cursor:pointer;border-color:${dupCount ? "rgba(245,158,11,0.45)" : "rgba(34,197,94,0.35)"};" onclick="OpsViews.openDuplicatesAudit()" title="Voir les adresses MAC en doublon dans plusieurs groupes NAC">
          <div class="kpi-label">Doublons MAC (Groupes)</div>
          <div class="kpi-value" style="color:${dupCount ? "var(--amber)" : "var(--green)"};">${dupCount}</div>
          <div class="kpi-sub">MAC présentes dans ≥ 2 groupes</div>
        </div>` : ""}`;
        })() : ""}
      </div>

      ${nacEsRes.available || appliances.length || nacGroups.length ? `
      <div class="panel">
        <div class="panel-header">
          <div class="panel-title">⛨ Statistiques NAC (ExtremeControl)</div>
          <div style="display:flex;gap:6px;align-items:center;">
            ${nacSampleTotal ? `<span class="badge badge-muted">Échantillon : ${nacSampleTotal} End-Systems${totalSessions > nacSampleTotal ? ` / ${totalSessions.toLocaleString("fr-FR")}` : ""}</span>` : ""}
            <button class="btn btn-xs btn-ghost" onclick="XIQApp.navigate('nac')">Ouvrir NAC →</button>
          </div>
        </div>
        <div class="panel-body">
          ${appliances.length ? `
            <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px;">
              ${appliances.map((a) => `
                <div style="flex:1;min-width:210px;background:var(--bg-elevated);border:1px solid var(--border);border-radius:8px;padding:10px 12px;display:flex;justify-content:space-between;align-items:center;gap:8px;">
                  <div>
                    <div style="font-weight:700;font-size:12.5px;">${esc(a.displayName || a.name || a.hostName || a.ipAddress || "Moteur NAC")}</div>
                    <div style="margin-top:2px;">${XIQApi.switchIpLink(a.ipAddress || a.ip || "")}</div>
                  </div>
                  <div style="text-align:right;">
                    <span class="badge ${/down|err|fail|off/i.test(String(a.status || a.state || "")) ? "badge-red" : "badge-green"}">${esc(a.status || a.state || "Actif")}</span>
                    ${(a.activeEndSystems ?? a.endSystemCount) !== undefined ? `<div style="font-size:11px;color:var(--text-muted);margin-top:3px;">${a.activeEndSystems ?? a.endSystemCount} sessions</div>` : ""}
                  </div>
                </div>`).join("")}
            </div>` : ""}

          ${nacSampleTotal ? `
            <div style="margin-bottom:16px;">
              <div style="display:flex;justify-content:space-between;align-items:center;font-size:12px;margin-bottom:6px;flex-wrap:wrap;gap:6px;">
                <strong>État des authentifications NAC</strong>
                <div style="display:flex;gap:6px;flex-wrap:wrap;">
                  <span class="badge badge-green">Acceptés : ${nacAccept} (${nacAcceptPct}%)</span>
                  <span class="badge ${nacBlocked ? "badge-red" : "badge-muted"}">Quarantaine / Rejetés : ${nacBlocked} (${nacBlockedPct}%)</span>
                  ${nacOther ? `<span class="badge badge-amber">Autres : ${nacOther} (${nacOtherPct}%)</span>` : ""}
                  ${seenLast24h ? `<span class="badge badge-cyan">Vus &lt; 24h : ${seenLast24h}</span>` : ""}
                </div>
              </div>
              <div style="display:flex;height:10px;border-radius:999px;overflow:hidden;background:var(--bg-elevated);">
                <div style="width:${nacAcceptPct}%;background:var(--green);" title="Acceptés : ${nacAccept}"></div>
                <div style="width:${nacBlockedPct}%;background:var(--red);" title="Quarantaine / Rejetés : ${nacBlocked}"></div>
                <div style="width:${nacOtherPct}%;background:var(--amber);" title="Autres : ${nacOther}"></div>
              </div>
            </div>

            <div class="grid-2" style="margin-bottom:4px;">
              <div>
                <div style="font-size:12px;font-weight:700;color:var(--text-secondary);margin-bottom:8px;">Top Profils / Politiques NAC</div>
                ${topProfiles.map(([name, cnt]) => `
                  <div style="margin-bottom:8px;">
                    <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:3px;">
                      <span>${esc(name)}</span><strong class="mono">${cnt} (${Math.round((cnt / nacSampleTotal) * 100)}%)</strong>
                    </div>
                    <div class="bar-track"><div class="bar-fill" style="width:${Math.round((cnt / maxProfCount) * 100)}%;"></div></div>
                  </div>`).join("")}
              </div>
              <div>
                <div style="font-size:12px;font-weight:700;color:var(--text-secondary);margin-bottom:8px;">Répartition par Méthode d'Authentification</div>
                ${topAuths.map(([name, cnt]) => `
                  <div style="margin-bottom:8px;">
                    <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:3px;">
                      <span>${esc(name)}</span><strong class="mono">${cnt} (${Math.round((cnt / nacSampleTotal) * 100)}%)</strong>
                    </div>
                    <div class="bar-track"><div class="bar-fill" style="width:${Math.round((cnt / maxAuthCount) * 100)}%;background:linear-gradient(90deg, var(--cyan), var(--green));"></div></div>
                  </div>`).join("")}
                ${topVlans.length ? `
                  <div style="margin-top:10px;padding-top:8px;border-top:1px solid var(--border);display:flex;gap:6px;flex-wrap:wrap;align-items:center;">
                    <span style="font-size:11.5px;font-weight:700;color:var(--text-secondary);">Top VLANs NAC :</span>
                    ${topVlans.map(([vName, cnt]) => `<span class="badge badge-purple">${esc(vName)} · ${cnt}</span>`).join("")}
                  </div>` : ""}
                ${auditSummary ? `
                  <div style="margin-top:12px;padding-top:10px;border-top:1px solid var(--border);display:flex;gap:6px;flex-wrap:wrap;align-items:center;">
                    <span style="font-size:11.5px;font-weight:700;color:var(--text-secondary);">Hygiène NAC :</span>
                    <button class="btn btn-xs btn-ghost" onclick="XIQApp.navigate('mac_audit')">Jamais vues : <strong>${auditSummary.neverSeenCount ?? 0}</strong></button>
                    <button class="btn btn-xs btn-ghost" onclick="OpsViews.openDuplicatesAudit()">Doublons : <strong>${auditSummary.duplicateCount ?? 0}</strong></button>
                    ${auditSummary.conflictsCount !== undefined ? `<button class="btn btn-xs btn-ghost" onclick="XIQApp.navigate('suggestions')">Conflits : <strong>${auditSummary.conflictsCount}</strong></button>` : ""}
                    ${auditSummary.inactive365Count !== undefined ? `<button class="btn btn-xs btn-ghost" onclick="XIQApp.navigate('suggestions')">Inactives &gt;1an : <strong>${auditSummary.inactive365Count}</strong></button>` : ""}
                  </div>` : ""}
              </div>
            </div>
          ` : `<div class="empty-state" style="padding:16px;">Aucun End-System retourné pour les statistiques détaillées.</div>`}
        </div>
      </div>` : ""}

      <div class="grid-2">
        <div class="panel">
          <div class="panel-header">
            <div class="panel-title">Répartition des équipements par Site</div>
            <button class="btn btn-xs btn-ghost" onclick="XIQApp.navigate('network')">Voir l'inventaire →</button>
          </div>
          <div class="panel-body">
            ${siteBars.length ? siteBars.slice(0, 12).map((b) => `
              <div style="margin-bottom:10px;">
                <div style="display:flex;justify-content:space-between;font-size:12.5px;margin-bottom:4px;">
                  <span>${esc(b.name)}</span><strong>${b.count} équip.</strong>
                </div>
                <div class="bar-track"><div class="bar-fill" style="width:${Math.round((b.count / maxSiteCount) * 100)}%;"></div></div>
              </div>`).join("") : `<div class="empty-state">Aucun site retourné par le serveur.</div>`}
          </div>
        </div>

        <div class="panel">
          <div class="panel-header">
            <div class="panel-title">Serveur XIQ-SE (administration.serverInfo)</div>
            <button class="btn btn-xs btn-ghost" data-open-studio="1">&lt;/&gt; Voir GraphQL</button>
          </div>
          <div class="panel-body">
            ${renderKeyValueTable(srv)}
            <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap;">
              <button class="btn btn-sm btn-primary" onclick="XIQApp.navigate('studio')">Studio GraphQL (100% API)</button>
              <button class="btn btn-sm btn-secondary" onclick="XIQApp.navigate('locator')">⌕ Localisateur Express</button>
              <button class="btn btn-sm btn-secondary" onclick="XIQApp.navigate('mac_audit')">◎ Audit MAC &amp; Doublons</button>
              <button class="btn btn-sm btn-secondary" onclick="NetOpsTools.openInventoryReportModal()">📋 Rapport Inventaire</button>
            </div>
          </div>
        </div>
      </div>

      <div class="panel">
        <div class="panel-header">
          <div class="panel-title">${almRes.available ? "Alarmes actives récentes" : "Derniers équipements supervisés"}</div>
          <button class="btn btn-xs btn-ghost" onclick="XIQApp.navigate('${almRes.available ? "alarms" : "network"}')">Tout voir →</button>
        </div>
        ${almRes.available
          ? renderDynamicTable(alarms.slice(0, 8), "Aucune alarme active.")
          : renderDynamicTable(devices.slice(0, 8), "Aucun équipement trouvé.")}
      </div>
    `;
    bindOpenStudio(viewport, devRes.query || srvRes.query);
  }

  // =========================================================================
  // 2. NETWORK & INVENTORY (Schema-Adaptive)
  // =========================================================================
  const netState = { search: "", siteFilter: "", limit: "250", displayCap: 300 };

  async function renderNetwork(viewport) {
    viewport.classList.remove("studio-mode");
    netState.displayCap = 300;
    const setNetLoading = (msg) => {
      viewport.innerHTML = `<div class="loading-state">${esc(msg)}</div>`;
    };
    setNetLoading(`Chargement adaptatif de l'inventaire réseau XIQ-SE (portée : ${netState.limit === "all" ? "toute la base" : netState.limit})...`);

    const indexed = await getSchema();
    const devRes = await runAdaptivePaginated(
      indexed,
      ["network"],
      ["devices", "allDevices"],
      {
        preferredScalars: [
          "ip", "sysName", "deviceName", "name", "baseMac", "macAddress",
          "status", "down", "lastStatus", "up", "deviceDisplayFamily", "family", "firmware",
          "sitePath", "sysUpTime", "sysDescr",
        ],
        nestedSpecs: [
          { candidates: ["deviceData"], preferred: ["vendor", "serialNumber", "family", "subFamily"] },
        ],
        includeAllScalars: false,
      },
      "network",
      netState.limit,
      (loaded, cap) => setNetLoading(`Chargement de l'inventaire réseau : ${loaded.toLocaleString("fr-FR")}${cap ? ` / ${cap.toLocaleString("fr-FR")}` : ""} équipements...`)
    );

    const devices = Array.isArray(devRes.data) ? devRes.data : [];
    if (netState._announceScope) {
      netState._announceScope = false;
      XIQApi.toast(
        `${devices.length.toLocaleString("fr-FR")} équipement(s) chargé(s) · ${devRes.paginationMode}`,
        devices.length > 0 ? "info" : "warn"
      );
    }

    // Check if network.createDevices / deleteDevices exist on this server
    const netMutations = SchemaTools.listDomainMutations(indexed, ["network"]);
    const hasCreateDev = netMutations.some((m) => m.field.name === "createDevices");
    const hasDeleteDev = netMutations.some((m) => m.field.name === "deleteDevices");

    const drawNet = () => {
      const q = netState.search.trim().toLowerCase();
      const siteOptions = Array.from(
        new Set(devices.map((d) => d.sitePath).filter(Boolean))
      ).sort();

      const filtered = devices.filter((d) => {
        if (netState.siteFilter && d.sitePath !== netState.siteFilter) return false;
        if (!q) return true;
        return [
          d.ip, d.sysName, d.deviceName, d.name, d.baseMac, d.macAddress,
          d.deviceDisplayFamily, d.family, d.firmware, d.sitePath, d.deviceData?.serialNumber,
        ].some((v) => String(v || "").toLowerCase().includes(q));
      });
      const visibleDevices = filtered.slice(0, netState.displayCap);

      viewport.innerHTML = `
        ${renderErrorBanner(devRes.errors || [], devRes.query)}
        ${devRes.truncatedByLimit ? `
          <div class="alert-banner" style="margin-bottom:10px;">
            <div><strong>Portée actuelle (${esc(netState.limit)}) atteinte :</strong> ${devices.length.toLocaleString("fr-FR")} équipements chargés. Pour chercher sur toute la base, élargissez la portée.</div>
            <button class="btn btn-xs btn-primary" id="btn-net-load-all">Charger toute la base</button>
          </div>` : ""}
        <div class="toolbar">
          <div class="toolbar-group">
            <span class="badge badge-cyan" style="font-size:12px;">Équipements : ${filtered.length.toLocaleString("fr-FR")}${filtered.length !== devices.length ? ` / ${devices.length.toLocaleString("fr-FR")}` : ""}</span>
            <input id="net-search" placeholder="Rechercher IP, nom, MAC, modèle, série..." value="${esc(netState.search)}" style="width:260px;" />
            <select id="net-site-filter">
              <option value="">Tous les sites</option>
              ${siteOptions.map((loc) => `<option value="${esc(loc)}" ${netState.siteFilter === loc ? "selected" : ""}>${esc(loc)}</option>`).join("")}
            </select>
            ${renderLimitSelect("net-limit-select", netState.limit, devRes.paginationMode)}
          </div>
          <div class="toolbar-group">
            ${hasCreateDev ? `<button class="btn btn-sm btn-primary" id="btn-add-device">+ Ajouter équipement</button>` : ""}
            <button class="btn btn-sm btn-success" id="btn-full-inv-report">📋 Rapport Inventaire Complet</button>
            <button class="btn btn-sm btn-secondary" id="btn-export-dev-csv">Exporter CSV</button>
            <button class="btn btn-sm btn-ghost" data-open-studio="1">&lt;/&gt; GraphQL</button>
          </div>
        </div>
        <div class="panel">
          <div class="table-wrap">
            <table>
              <thead><tr><th>Statut</th><th>Nom / IP</th><th>Famille / Modèle</th><th>Firmware</th><th>MAC / Série</th><th>Site</th><th>Uptime</th><th>Actions</th></tr></thead>
              <tbody>
                ${visibleDevices.length ? visibleDevices.map((d) => {
                  const up = isDeviceUp(d);
                  const dName = d.sysName || d.deviceName || d.name || d.ip;
                  const mac = d.baseMac || d.macAddress || "—";
                  const fam = d.deviceDisplayFamily || d.family || d.deviceData?.family || "—";
                  return `
                  <tr class="clickable" data-inspect-ip="${esc(d.ip)}">
                    <td><span class="badge ${up ? "badge-green" : "badge-red"}">${up ? "● Up" : "● Down"}</span></td>
                    <td><strong>${esc(dName)}</strong><div>${XIQApi.switchIpLink(d.ip)}</div></td>
                    <td>${esc(fam)}<div style="font-size:11px;color:var(--text-muted);">${esc(d.deviceData?.subFamily || "")}</div></td>
                    <td class="mono">${esc(d.firmware || "—")}</td>
                    <td class="mono">${esc(mac)}<div style="font-size:11px;color:var(--text-muted);">${esc(d.deviceData?.serialNumber || "")}</div></td>
                    <td><span class="badge badge-muted">${esc(d.sitePath || "—")}</span></td>
                    <td class="mono">${esc(d.sysUpTime || "—")}</td>
                    <td style="white-space:nowrap;">
                      <button class="btn btn-xs btn-secondary" data-inspect-ip="${esc(d.ip)}">Détails / Ports</button>
                      ${hasDeleteDev ? `<button class="btn btn-xs btn-danger" data-del-ip="${esc(d.ip)}">Suppr.</button>` : ""}
                    </td>
                  </tr>`;
                }).join("") : `<tr><td colspan="8" class="empty-state">Aucun équipement trouvé.</td></tr>`}
              </tbody>
            </table>
          </div>
          ${filtered.length > visibleDevices.length ? `
            <div style="padding:10px 14px;display:flex;justify-content:space-between;align-items:center;border-top:1px solid var(--border);font-size:12px;color:var(--text-secondary);">
              <span>Affichage de <strong>${visibleDevices.length}</strong> sur <strong>${filtered.length.toLocaleString("fr-FR")}</strong> résultats (la recherche couvre bien les ${devices.length.toLocaleString("fr-FR")} équipements chargés).</span>
              <div style="display:flex;gap:6px;">
                <button class="btn btn-xs btn-secondary" id="btn-net-more">+ Afficher 300 suivants</button>
                <button class="btn btn-xs btn-ghost" id="btn-net-show-all">Tout afficher</button>
              </div>
            </div>` : ""}
        </div>

        ${renderDomainCatalogPanel(indexed, ["network"], "Toutes les opérations du domaine network")}
      `;

      bindOpenStudio(viewport, devRes.query);
      bindDomainCatalogButtons(viewport, indexed);

      const limSel = viewport.querySelector("#net-limit-select");
      if (limSel) {
        limSel.addEventListener("change", async (e) => {
          netState.limit = e.target.value;
          netState._announceScope = true;
          await renderNetwork(viewport);
        });
      }
      const loadAllBtn = viewport.querySelector("#btn-net-load-all");
      if (loadAllBtn) {
        loadAllBtn.addEventListener("click", async () => {
          netState.limit = "all";
          netState._announceScope = true;
          await renderNetwork(viewport);
        });
      }
      const moreBtn = viewport.querySelector("#btn-net-more");
      if (moreBtn) moreBtn.addEventListener("click", () => { netState.displayCap += 300; drawNet(); });
      const showAllBtn = viewport.querySelector("#btn-net-show-all");
      if (showAllBtn) showAllBtn.addEventListener("click", () => { netState.displayCap = filtered.length; drawNet(); });

      const sInp = viewport.querySelector("#net-search");
      if (sInp) {
        sInp.addEventListener("input", (e) => {
          netState.search = e.target.value;
          netState.displayCap = 300;
          const pos = e.target.selectionStart;
          drawNet();
          const el = viewport.querySelector("#net-search");
          el.focus(); el.setSelectionRange(pos, pos);
        });
      }
      const sSel = viewport.querySelector("#net-site-filter");
      if (sSel) {
        sSel.addEventListener("change", (e) => { netState.siteFilter = e.target.value; netState.displayCap = 300; drawNet(); });
      }

      const expBtn = viewport.querySelector("#btn-export-dev-csv");
      if (expBtn) {
        expBtn.addEventListener("click", () => {
          const rows = SchemaTools.extractTableRows({ devices: filtered });
          XIQApi.exportFile(`xiqse-devices-${Date.now()}.csv`, XIQApi.rowsToCsv(rows));
        });
      }
      const repBtn = viewport.querySelector("#btn-full-inv-report");
      if (repBtn) {
        repBtn.addEventListener("click", () => NetOpsTools.openInventoryReportModal(devices));
      }

      // Adaptive Device Details & Ports modal
      viewport.querySelectorAll("[data-inspect-ip]").forEach((el) => {
        el.addEventListener("click", async (e) => {
          if (e.target.closest("[data-del-ip]") || e.target.closest("[data-open-ip]") || e.target.closest("[data-copy-val]")) return;
          const ip = el.dataset.inspectIp;
          const devDetailRes = await runAdaptive(
            indexed,
            ["network"],
            ["device", "deviceByIp"],
            {
              args: { ip, ipAddress: ip, deviceIp: ip },
              preferredScalars: ["ip", "sysName", "deviceName", "baseMac", "firmware", "status", "sitePath", "sysDescr", "sysUpTime"],
              nestedSpecs: [
                { candidates: ["interfaces", "ports", "portData"], preferred: ["name", "ifName", "alias", "adminStatus", "operStatus", "status", "speed", "vlan", "poePowerWatts"], includeAllScalars: true },
                { candidates: ["deviceData"], includeAllScalars: true },
              ],
              includeAllScalars: true,
            },
            "network"
          );
          const dev = devDetailRes.data || devices.find((x) => x.ip === ip);
          if (!dev) return XIQApi.toast("Impossible de charger cet équipement.", "error");
          const ports = dev.interfaces || dev.ports || dev.portData || [];
          const scalarProps = {};
          Object.entries(dev).forEach(([k, v]) => {
            if (v !== null && v !== undefined && typeof v !== "object") scalarProps[k] = v;
          });
          XIQApi.showModal({
            title: `${dev.sysName || dev.deviceName || dev.ip} (${dev.ip})`,
            bodyHtml: `
              <h4 style="margin-bottom:8px;font-size:12.5px;color:var(--text-secondary);">Propriétés de l'équipement</h4>
              ${renderKeyValueTable(scalarProps)}
              ${Array.isArray(ports) && ports.length ? `
                <h4 style="margin:14px 0 8px;font-size:12.5px;color:var(--text-secondary);">Interfaces / Ports (${ports.length})</h4>
                ${renderDynamicTable(ports)}
              ` : `<div style="margin-top:12px;font-size:12px;color:var(--text-muted);">Aucun sous-champ ports/interfaces retourné pour cet équipement.</div>`}
            `,
            footerHtml: `
              <button class="btn btn-secondary btn-sm" data-open-ip="${esc(dev.ip)}">🌐 Ouvrir https://${esc(dev.ip)}</button>
              ${devDetailRes.query ? `<button class="btn btn-secondary btn-sm" id="btn-ports-studio">&lt;/&gt; Ouvrir dans Studio</button>` : ""}
              <button class="btn btn-primary btn-sm" onclick="XIQApi.closeModal()">Fermer</button>`,
            onMount: () => {
              const b = document.getElementById("btn-ports-studio");
              if (b) b.addEventListener("click", () => { XIQApi.closeModal(); openInStudio(devDetailRes.query, {}); });
            },
          });
        });
      });

      viewport.querySelectorAll("[data-del-ip]").forEach((btn) => {
        btn.addEventListener("click", async (e) => {
          e.stopPropagation();
          const ip = btn.dataset.delIp;
          if (!confirm(`Supprimer l'équipement ${ip} de XIQ-SE ?`)) return;
          const m = `mutation DeleteDev($ip: String!) { network { deleteDevices(input: { ipAddresses: [$ip] }) { status message } } }`;
          const r = await runOp(m, { ip }, "network");
          XIQApi.toast(r.data?.network?.deleteDevices?.message || r.errors?.[0]?.message || "Terminé", r.ok ? "success" : "error");
          renderNetwork(viewport);
        });
      });

      const addDevBtn = viewport.querySelector("#btn-add-device");
      if (addDevBtn) {
        addDevBtn.addEventListener("click", () => {
          XIQApi.showModal({
            title: "Ajouter un équipement (network.createDevices)",
            bodyHtml: `
              <div class="form-grid">
                <div class="form-field"><label>Adresse IP *</label><input id="nd-ip" placeholder="10.10.5.21" /></div>
                <div class="form-field"><label>Nom système (sysName)</label><input id="nd-name" placeholder="SW-ACC-NEW-01" /></div>
                <div class="form-field"><label>Site cible</label>
                  <input id="nd-site" value="${esc(siteOptions[0] || "/World")}" />
                </div>
                <div class="form-field"><label>Profil SNMP/CLI</label><input id="nd-prof" value="SNMPv3-Prod" /></div>
              </div>`,
            footerHtml: `
              <button class="btn btn-ghost" onclick="XIQApi.closeModal()">Annuler</button>
              <button class="btn btn-primary" id="btn-nd-submit">Provisionner</button>`,
            onMount: () => {
              document.getElementById("btn-nd-submit").addEventListener("click", async () => {
                const ip = document.getElementById("nd-ip").value.trim();
                const sysName = document.getElementById("nd-name").value.trim();
                const siteLocation = document.getElementById("nd-site").value.trim();
                const profileName = document.getElementById("nd-prof").value.trim();
                if (!ip) return XIQApi.toast("Adresse IP requise.", "warn");
                const m = `mutation CreateDev($ip: String!, $sysName: String!, $siteLocation: String!, $profileName: String!) {
  network { createDevices(input: { devices: [{ ipAddress: $ip, sysName: $sysName, siteLocation: $siteLocation, profileName: $profileName }] }) { status message } }
}`;
                const r = await runOp(m, { ip, sysName, siteLocation, profileName }, "network");
                XIQApi.closeModal();
                XIQApi.toast(r.data?.network?.createDevices?.message || r.errors?.[0]?.message || "Terminé", r.ok ? "success" : "error");
                renderNetwork(viewport);
              });
            },
          });
        });
      }
    };

    drawNet();
  }

  // =========================================================================
  // 3. ACCESS CONTROL / NAC (Schema-Adaptive: handles WsEndSystemListResult & group.values!)
  // =========================================================================
  const nacState = { tab: "endsystems", search: "", groupSearch: "", onlyNonEmptyGroups: false, groupTypeFilter: "ALL", limit: "250", displayCap: 300, groupCap: 120 };

  function classifyNacGroupType(g) {
    const gName = typeof g === "object" ? (g.name || g.groupName || "") : String(g);
    const raw = typeof g === "object"
      ? String(g.type || g.groupType || g.typeStr || g.category || "").trim()
      : "";
    const lower = raw.toLowerCase();

    if (/blacklist|quarant|blocklist/i.test(gName)) {
      return { key: "BLACKLIST", label: "Blacklist / Quarantaine", rawType: raw || "Blacklist", icon: "⊘", badgeClass: "badge-red", order: 1 };
    }
    if (/location|site|switch|port|geo|building|zone|\bap\b|ssid/i.test(lower)) {
      return { key: "LOCATION", label: "Location / Emplacement", rawType: raw, icon: "⌖", badgeClass: "badge-cyan", order: 3 };
    }
    if (/^mac|mac_|end.?system|endpoint|device.?type|os.?type/i.test(lower)) {
      return { key: "ENDPOINT_MAC", label: "Endpoint / MAC", rawType: raw, icon: "⛨", badgeClass: "badge-purple", order: 2 };
    }
    if (/^ip|subnet|cidr|host|dns|fqdn/i.test(lower)) {
      return { key: "IP_HOST", label: "IP / Hostname", rawType: raw, icon: "🌐", badgeClass: "badge-cyan", order: 4 };
    }
    if (/user|ldap|\bad\b|ident|role|dir/i.test(lower)) {
      return { key: "USER", label: "Utilisateurs / LDAP", rawType: raw, icon: "👤", badgeClass: "badge-green", order: 5 };
    }
    if (/time|sched|hour|date/i.test(lower)) {
      return { key: "TIME", label: "Plages Horaires (Time)", rawType: raw, icon: "◷", badgeClass: "badge-amber", order: 6 };
    }
    if (/appliance|engine|radius|nac/i.test(lower)) {
      return { key: "APPLIANCE", label: "Moteurs / Appliances", rawType: raw, icon: "⚙", badgeClass: "badge-muted", order: 7 };
    }
    if (raw) {
      return { key: `RAW:${raw.toUpperCase()}`, label: raw, rawType: raw, icon: "◈", badgeClass: "badge-muted", order: 8 };
    }
    return { key: "OTHER", label: "Autres / Non typés", rawType: "", icon: "◈", badgeClass: "badge-muted", order: 9 };
  }

  function getGroupEntries(g) {
    if (!g || typeof g !== "object") return [];
    const raw =
      g.values ??
      g.entries ??
      g.members ??
      g.groupValues ??
      g.valueList ??
      g.endSystemValues ??
      [];
    if (!Array.isArray(raw)) return [];
    return raw.map((item) => {
      if (item === null || item === undefined) return "";
      if (typeof item === "object") {
        const val = item.value ?? item.entry ?? item.macAddress ?? item.ipAddress ?? item.name ?? JSON.stringify(item);
        const desc = item.description ? ` (${item.description})` : "";
        return { raw: String(val), label: `${val}${desc}` };
      }
      return { raw: String(item), label: String(item) };
    }).filter((x) => x && x.raw !== "");
  }

  function buildAdaptiveGroupMutation(indexed, mutationName, { groupName, value, description }) {
    const dom = SchemaTools.getDomainType(indexed, ["accessControl"], "mutation");
    const field = dom ? SchemaTools.getFieldDef(indexed, dom.domainType, mutationName) : null;
    const inputArg = field?.args?.find((a) => a.name === "input");
    const inputTypeName = inputArg ? SchemaTools.unwrapType(inputArg.type).name : null;
    const inputType = inputTypeName ? SchemaTools.getType(indexed, inputTypeName) : null;
    const inputFields = (inputType?.inputFields || []).map((f) => f.name);

    const payload = {};
    if (groupName !== undefined) {
      if (inputFields.includes("group")) payload.group = groupName;
      else if (inputFields.includes("groupName")) payload.groupName = groupName;
      else if (inputFields.includes("name")) payload.name = groupName;
      else payload.group = groupName;
    }
    if (value !== undefined) {
      if (inputFields.includes("value")) payload.value = value;
      else if (inputFields.includes("entry")) payload.entry = value;
      else if (inputFields.includes("macAddress")) payload.macAddress = value;
      else if (inputFields.includes("ipAddress")) payload.ipAddress = value;
      else payload.value = value;
    }
    if (description && (!inputFields.length || inputFields.includes("description"))) {
      payload.description = description;
    }

    const retBase = field ? SchemaTools.unwrapType(field.type) : null;
    const retSel = (retBase && SchemaTools.buildSafeSelection(indexed, retBase.name, ["status", "message", "errorCode", "success"], [], false)) || "status message";
    const inputGraphqlType = inputArg ? SchemaTools.formatTypeRef(inputArg.type) : "GroupAddEntryInput!";

    return {
      query: `mutation ExecNacMut($input: ${inputGraphqlType}) { accessControl { ${mutationName}(input: $input) { ${retSel} } } }`,
      variables: { input: payload },
    };
  }

  async function renderNac(viewport) {
    viewport.classList.remove("studio-mode");
    nacState.displayCap = 300;
    nacState.groupCap = 120;
    const setNacLoading = (msg) => {
      viewport.innerHTML = `<div class="loading-state">${esc(msg)}</div>`;
    };
    setNacLoading(`Chargement adaptatif d'ExtremeControl (NAC) — portée End-Systems : ${nacState.limit === "all" ? "toute la base" : nacState.limit}...`);

    const indexed = await getSchema();
    const [esRes, appRes, grpRes, mlRes, radRes] = await Promise.all([
      runAdaptivePaginated(
        indexed,
        ["accessControl"],
        ["endSystems", "allEndSystemsAsProperties", "allEndSystems"],
        {
          wrapperCandidates: ["endSystem", "endSystems", "results", "items"],
          preferredScalars: [
            "macAddress", "ipAddress", "username", "userName", "hostName",
            "switchIp", "switchIP", "portName", "switchPortName", "portIfName", "portDisplayName",
            "interfaceName", "ifName", "switchPort", "port", "switchPortId", "authType",
            "profile", "policy", "vlan", "state", "zone", "operatingSystemName", "lastSeenTime",
          ],
          includeAllScalars: true,
        },
        "nac",
        nacState.limit,
        (loaded, cap) => setNacLoading(`Chargement des End-Systems NAC : ${loaded.toLocaleString("fr-FR")}${cap ? ` / ${cap.toLocaleString("fr-FR")}` : ""}...`)
      ),
      runAdaptive(
        indexed,
        ["accessControl"],
        ["appliances", "engines", "nacAppliances", "allAppliances"],
        { includeAllScalars: true },
        "nac"
      ),
      runAdaptive(
        indexed,
        ["accessControl"],
        ["endSystemGroups", "groups", "allGroups", "groupNames"],
        {
          preferredScalars: ["name", "groupName", "type", "groupType", "typeStr", "category", "description", "values", "entries", "members", "valueCount", "size"],
          nestedSpecs: [
            { candidates: ["values", "entries", "members", "groupValues", "valueList"], includeAllScalars: true },
          ],
          includeAllScalars: true,
        },
        "nac"
      ),
      runAdaptive(
        indexed,
        ["accessControl"],
        ["macLocks", "allMacLocks"],
        { includeAllScalars: true },
        "nac"
      ),
      runAdaptive(
        indexed,
        ["accessControl"],
        ["radiusServers", "allRadiusServers"],
        { includeAllScalars: true },
        "nac"
      ),
    ]);

    const endSystems = Array.isArray(esRes.data) ? esRes.data : [];
    const portLookupSample = endSystems.length > 500 ? endSystems.slice(0, 300) : endSystems;
    const nacSwitchPortMap = await NetOpsTools.buildSwitchPortLookupMap(indexed, portLookupSample).catch(() => new Map());
    const appliances = Array.isArray(appRes.data) ? appRes.data : [];
    const groups = Array.isArray(grpRes.data) ? grpRes.data : [];
    const macLocks = Array.isArray(mlRes.data) ? mlRes.data : [];
    const radius = Array.isArray(radRes.data) ? radRes.data : [];

    const nacMutations = SchemaTools.listDomainMutations(indexed, ["accessControl"]);
    const hasMut = (n) => nacMutations.some((m) => m.field.name === n);
    const hasSingleGroupQuery = Boolean(
      SchemaTools.listCallableDomainQueries(indexed, ["accessControl"]).find((q) =>
        ["group", "groupByName", "endSystemGroup"].includes(q.field.name)
      )
    );

    const openGroupDetailsModal = async (groupObj) => {
      const gName = groupObj.name || groupObj.groupName || String(groupObj);
      let entries = getGroupEntries(groupObj);
      let detailQuery = "";
      let extraInfo = groupObj;

      if (hasSingleGroupQuery) {
        const singleRes = await runAdaptive(
          indexed,
          ["accessControl"],
          ["group", "groupByName", "endSystemGroup"],
          {
            args: { name: gName, groupName: gName, group: gName },
            preferredScalars: ["name", "type", "description", "values", "entries", "members"],
            nestedSpecs: [
              { candidates: ["values", "entries", "members", "groupValues", "valueList"], includeAllScalars: true },
            ],
            includeAllScalars: true,
          },
          "nac"
        );
        detailQuery = singleRes.query || "";
        if (singleRes.ok && singleRes.data) {
          extraInfo = singleRes.data;
          const fetchedEntries = getGroupEntries(singleRes.data);
          if (fetchedEntries.length || !entries.length) {
            entries = fetchedEntries;
          }
        }
      }

      XIQApi.showModal({
        title: `Groupe NAC : ${gName} (${entries.length} entrée(s))`,
        bodyHtml: `
          <div style="margin-bottom:10px;display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
            ${extraInfo.type ? `<span class="badge badge-purple">Type : ${esc(extraInfo.type)}</span>` : ""}
            ${extraInfo.description ? `<span style="font-size:12px;color:var(--text-secondary);">${esc(extraInfo.description)}</span>` : ""}
          </div>
          ${entries.length ? `
            <input id="grp-modal-filter" placeholder="Filtrer dans les ${entries.length} entrées..." style="width:100%;margin-bottom:10px;" />
            <div id="grp-modal-list" style="max-height:360px;overflow-y:auto;border:1px solid var(--border);border-radius:6px;padding:6px 10px;">
              ${entries.map((ent) => `
                <div class="grp-entry-row" data-txt="${esc(ent.label.toLowerCase())}" style="display:flex;justify-content:space-between;align-items:center;padding:5px 0;border-bottom:1px solid var(--border);">
                  <span class="mono">${esc(ent.label)}</span>
                  ${hasMut("removeEntryFromGroup") ? `<button class="btn btn-xs btn-ghost" data-modal-rm="${esc(ent.raw)}">Retirer</button>` : ""}
                </div>`).join("")}
            </div>` : `<div class="empty-state">Ce groupe ne contient actuellement aucune entrée.</div>`}
        `,
        footerHtml: `
          ${entries.length ? `<button class="btn btn-secondary btn-sm" id="btn-grp-export-csv">Exporter CSV</button>` : ""}
          ${detailQuery ? `<button class="btn btn-ghost btn-sm" id="btn-grp-studio">&lt;/&gt; Studio</button>` : ""}
          <button class="btn btn-primary btn-sm" onclick="XIQApi.closeModal()">Fermer</button>
        `,
        onMount: () => {
          const flt = document.getElementById("grp-modal-filter");
          if (flt) {
            flt.addEventListener("input", () => {
              const q = flt.value.trim().toLowerCase();
              document.querySelectorAll(".grp-entry-row").forEach((row) => {
                row.style.display = !q || row.dataset.txt.includes(q) ? "flex" : "none";
              });
            });
          }
          const exp = document.getElementById("btn-grp-export-csv");
          if (exp) {
            exp.addEventListener("click", () => {
              const rows = entries.map((e) => ({ Groupe: gName, Entree: e.raw, Details: e.label }));
              XIQApi.exportFile(`xiqse-group-${gName.replace(/[^a-zA-Z0-9_-]/g, "_")}.csv`, XIQApi.rowsToCsv(rows));
            });
          }
          const st = document.getElementById("btn-grp-studio");
          if (st) {
            st.addEventListener("click", () => {
              XIQApi.closeModal();
              openInStudio(detailQuery, {});
            });
          }
          document.querySelectorAll("[data-modal-rm]").forEach((btn) => {
            btn.addEventListener("click", async () => {
              const mut = buildAdaptiveGroupMutation(indexed, "removeEntryFromGroup", {
                groupName: gName,
                value: btn.dataset.modalRm,
              });
              const r = await runOp(mut.query, mut.variables, "nac");
              XIQApi.toast(r.data?.accessControl?.removeEntryFromGroup?.message || r.errors?.[0]?.message || "Entrée retirée.", r.ok ? "success" : "error");
              XIQApi.closeModal();
              renderNac(viewport);
            });
          });
        },
      });
    };

    const drawNac = () => {
      const q = nacState.search.trim().toLowerCase();
      const filteredEs = endSystems.filter(
        (e) =>
          !q ||
          Object.values(e || {}).some((v) => String(v || "").toLowerCase().includes(q))
      );

      const gq = nacState.groupSearch.trim().toLowerCase();
      // Annotate each group with its original index and detected NAC type
      const annotatedGroups = groups.map((g, origIdx) => ({
        g,
        origIdx,
        typeInfo: classifyNacGroupType(g),
        entries: getGroupEntries(g),
      }));

      // Apply search + non-empty filter first so type counts stay accurate
      const searchFilteredGroups = annotatedGroups.filter(({ g, typeInfo, entries }) => {
        const gName = typeof g === "object" ? (g.name || g.groupName || "") : String(g);
        const gDesc = typeof g === "object" ? (g.description || "") : "";
        if (nacState.onlyNonEmptyGroups && entries.length === 0) return false;
        if (!gq) return true;
        return (
          gName.toLowerCase().includes(gq) ||
          gDesc.toLowerCase().includes(gq) ||
          typeInfo.label.toLowerCase().includes(gq) ||
          typeInfo.rawType.toLowerCase().includes(gq) ||
          entries.some((e) => e.label.toLowerCase().includes(gq))
        );
      });

      // Build ordered list of detected group types + counts
      const typeBucketsMap = new Map();
      searchFilteredGroups.forEach((item) => {
        const k = item.typeInfo.key;
        if (!typeBucketsMap.has(k)) {
          typeBucketsMap.set(k, { ...item.typeInfo, items: [] });
        }
        typeBucketsMap.get(k).items.push(item);
      });
      const typeBuckets = Array.from(typeBucketsMap.values()).sort(
        (a, b) => a.order - b.order || b.items.length - a.items.length || a.label.localeCompare(b.label)
      );

      // Reset filter to ALL if selected type no longer has any group (e.g. after profile switch)
      if (nacState.groupTypeFilter !== "ALL" && !typeBucketsMap.has(nacState.groupTypeFilter)) {
        nacState.groupTypeFilter = "ALL";
      }

      const filteredAnnotatedGroups =
        nacState.groupTypeFilter === "ALL"
          ? searchFilteredGroups
          : (typeBucketsMap.get(nacState.groupTypeFilter)?.items || []);
      const filteredGroups = filteredAnnotatedGroups.map((x) => x.g);

      const renderGroupCard = ({ g, origIdx, typeInfo, entries }) => {
        const gName = typeof g === "object" ? (g.name || g.groupName || "Groupe") : String(g);
        const preview = entries.slice(0, 8);
        const remaining = entries.length - preview.length;
        return `
        <div class="panel">
          <div class="panel-header">
            <div style="min-width:0;">
              <div class="panel-title">
                ${esc(gName)}
                <span class="badge ${typeInfo.badgeClass}" style="margin-left:5px;">${typeInfo.icon} ${esc(typeInfo.rawType || typeInfo.label)}</span>
              </div>
              <div style="font-size:11.5px;color:var(--text-muted);">${esc((typeof g === "object" && g.description) || "")}</div>
            </div>
            <div style="display:flex;gap:6px;align-items:center;">
              <span class="badge ${typeInfo.key === "BLACKLIST" ? "badge-red" : entries.length ? "badge-cyan" : "badge-muted"}">${entries.length} entrée(s)</span>
              <button class="btn btn-xs btn-secondary" data-inspect-grp="${origIdx}">Ouvrir / Membres</button>
            </div>
          </div>
          <div class="panel-body">
            ${preview.length ? preview.map((ent) => `
              <div style="display:flex;justify-content:space-between;align-items:center;padding:4px 0;border-bottom:1px solid var(--border);">
                <span class="mono">${esc(ent.label)}</span>
                ${hasMut("removeEntryFromGroup") ? `<button class="btn btn-xs btn-ghost" data-rm-grp="${esc(gName)}" data-rm-ent="${esc(ent.raw)}">Retirer</button>` : ""}
              </div>`).join("") + (remaining > 0 ? `<div style="margin-top:6px;"><button class="btn btn-xs btn-ghost" data-inspect-grp="${origIdx}">+ Voir les ${remaining} autres entrées...</button></div>` : "")
              : `<div style="color:var(--text-muted);font-size:12px;">${hasSingleGroupQuery ? "Aucune entrée dans la liste rapide — cliquez sur « Ouvrir / Membres » pour interroger le détail du groupe." : "Aucune entrée"}</div>`}
          </div>
        </div>`;
      };

      viewport.innerHTML = `
        ${renderErrorBanner([...(esRes.errors || []), ...(appRes.errors || []), ...(grpRes.errors || [])], esRes.query || grpRes.query)}
        ${appliances.length ? `
          <div class="kpi-grid">
            ${appliances.map((a) => {
              const sessions = a.activeEndSystems ?? a.endSystemCount ?? a.numEndSystems;
              return `
              <div class="kpi-card">
                <div class="kpi-label">${esc(a.displayName || a.name || a.ipAddress)}</div>
                <div class="kpi-value" style="font-size:19px;">${sessions !== undefined && sessions !== null ? `${sessions} <span style="font-size:12px;color:var(--text-muted);">sessions</span>` : esc(a.engineGroup || a.version || "Moteur NAC")}</div>
                <div class="kpi-sub"><span class="badge badge-green">${esc(a.status || "Actif")}</span> ${XIQApi.switchIpLink(a.ipAddress || a.ip || "")}</div>
              </div>`;
            }).join("")}
          </div>` : ""}

        <div class="tabs">
          <button class="tab-btn ${nacState.tab === "endsystems" ? "active" : ""}" data-actab="endsystems">End-Systems (${endSystems.length})</button>
          <button class="tab-btn ${nacState.tab === "groups" ? "active" : ""}" data-actab="groups">Groupes &amp; Blacklist (${groups.length})</button>
          <button class="tab-btn ${nacState.tab === "maclocks" ? "active" : ""}" data-actab="maclocks">MAC Locks (${macLocks.length})</button>
          <button class="tab-btn ${nacState.tab === "radius" ? "active" : ""}" data-actab="radius">Serveurs RADIUS (${radius.length})</button>
        </div>

        ${nacState.tab === "endsystems" ? `
          ${esRes.truncatedByLimit ? `
            <div class="alert-banner" style="margin-bottom:10px;">
              <div><strong>Portée actuelle (${esc(nacState.limit)}) atteinte :</strong> ${endSystems.length.toLocaleString("fr-FR")} End-Systems chargés. Pour rechercher sur toute la base NAC, élargissez la portée.</div>
              <button class="btn btn-xs btn-primary" id="btn-nac-load-all">Charger toute la base</button>
            </div>` : ""}
          <div class="toolbar">
            <div class="toolbar-group">
              <span class="badge badge-cyan" style="font-size:12px;">${filteredEs.length.toLocaleString("fr-FR")}${filteredEs.length !== endSystems.length ? ` / ${endSystems.length.toLocaleString("fr-FR")}` : ""}</span>
              <input id="nac-search" placeholder="Filtrer MAC, IP, utilisateur, switch, profil..." value="${esc(nacState.search)}" style="width:280px;" />
              ${renderLimitSelect("nac-limit-select", nacState.limit, esRes.paginationMode)}
            </div>
            <div class="toolbar-group">
              ${hasMut("addMACToBlacklist") ? `<button class="btn btn-sm btn-danger" id="btn-quick-blacklist">⊘ Blacklister une MAC</button>` : ""}
              <button class="btn btn-sm btn-secondary" id="btn-export-es-csv">Exporter CSV</button>
              <button class="btn btn-sm btn-ghost" data-open-studio="1">&lt;/&gt; GraphQL</button>
            </div>
          </div>
          <div class="panel"><div class="table-wrap"><table>
            <thead><tr><th>État</th><th>MAC / IP</th><th>Utilisateur / Hôte</th><th>Switch &amp; Port</th><th>Auth / OS</th><th>Profil / VLAN</th><th>Actions</th></tr></thead>
            <tbody>
              ${filteredEs.length ? filteredEs.slice(0, nacState.displayCap).map((e) => {
                const st = e.state || "—";
                const stBadge = /accept/i.test(st) ? "badge-green" : /quarant|reject|block/i.test(st) ? "badge-red" : "badge-amber";
                const swIp = e.switchIp || e.switchIP || "—";
                const swPort = NetOpsTools.resolveEndSystemPortDisplay(e, nacSwitchPortMap);
                const prof = e.profile || e.policy || "—";
                const user = e.username || e.userName || "—";
                return `<tr>
                  <td><span class="badge ${stBadge}">${esc(st)}</span></td>
                  <td class="mono"><strong>${XIQApi.macLink(e.macAddress)}</strong><div style="color:var(--text-muted);">${esc(e.ipAddress || "")}</div></td>
                  <td><strong>${esc(user)}</strong><div style="font-size:11.5px;color:var(--text-muted);">${esc(e.hostName || "")}</div></td>
                  <td class="mono">${XIQApi.switchIpLink(swIp)}<div style="color:var(--cyan);">${esc(swPort)}</div></td>
                  <td>${esc(e.authType || e.operatingSystemName || "—")}</td>
                  <td><span class="badge badge-purple">${esc(prof)}</span> ${e.vlan ? `<span class="mono">VLAN ${esc(e.vlan)}</span>` : ""}</td>
                  <td style="white-space:nowrap;">
                    ${hasMut("reauthenticateEndSystem") ? `<button class="btn btn-xs btn-secondary" data-reauth="${esc(e.macAddress)}">CoA</button>` : ""}
                    ${hasMut("addMACToBlacklist") && e.macAddress ? `<button class="btn btn-xs btn-danger" data-bl-mac="${esc(e.macAddress)}">Blacklist</button>` : ""}
                  </td>
                </tr>`;
              }).join("") : `<tr><td colspan="7" class="empty-state">${esRes.available ? "Aucun End-System trouvé." : "La requête End-Systems n'est pas exposée ou autorisée sur ce serveur."}</td></tr>`}
            </tbody>
          </table></div>
          ${filteredEs.length > nacState.displayCap ? `
            <div style="padding:10px 14px;display:flex;justify-content:space-between;align-items:center;border-top:1px solid var(--border);font-size:12px;color:var(--text-secondary);">
              <span>Affichage de <strong>${nacState.displayCap}</strong> sur <strong>${filteredEs.length.toLocaleString("fr-FR")}</strong> résultats (recherche active sur les ${endSystems.length.toLocaleString("fr-FR")} End-Systems chargés).</span>
              <div style="display:flex;gap:6px;">
                <button class="btn btn-xs btn-secondary" id="btn-nac-more">+ Afficher 300 suivants</button>
                <button class="btn btn-xs btn-ghost" id="btn-nac-show-all">Tout afficher</button>
              </div>
            </div>` : ""}
          </div>
        ` : nacState.tab === "groups" ? `
          <div class="toolbar">
            <div class="toolbar-group">
              <input id="nac-grp-search" placeholder="Rechercher un groupe, type ou MAC/IP..." value="${esc(nacState.groupSearch)}" style="width:290px;" />
              <label class="checkbox-row">
                <input type="checkbox" id="chk-nonempty-grp" ${nacState.onlyNonEmptyGroups ? "checked" : ""} />
                <span>Masquer les groupes vides</span>
              </label>
              <span style="font-size:12px;color:var(--text-muted);">${filteredAnnotatedGroups.length} / ${groups.length} groupe(s)</span>
            </div>
            <div class="toolbar-group">
              ${hasMut("addMACToEndSystemGroup") || hasMut("addEntryToGroup") ? `<button class="btn btn-sm btn-success" id="btn-bulk-csv-import">↑ Import CSV en masse</button>` : ""}
              ${hasMut("addMACToEndSystemGroup") || hasMut("addEntryToGroup") ? `<button class="btn btn-sm btn-primary" id="btn-add-group-entry">+ Ajouter MAC / IP</button>` : ""}
              <button class="btn btn-sm btn-ghost" data-open-studio="1">&lt;/&gt; GraphQL</button>
            </div>
          </div>

          <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px;align-items:center;">
            <span style="font-size:12px;font-weight:700;color:var(--text-secondary);margin-right:2px;">Type de groupe :</span>
            <button class="btn btn-xs ${nacState.groupTypeFilter === "ALL" ? "btn-primary" : "btn-secondary"}" data-grp-type="ALL">
              Tous (${searchFilteredGroups.length})
            </button>
            ${typeBuckets.map((b) => `
              <button class="btn btn-xs ${nacState.groupTypeFilter === b.key ? "btn-primary" : "btn-secondary"}" data-grp-type="${esc(b.key)}">
                ${b.icon} ${esc(b.label)} (${b.items.length})
              </button>`).join("")}
          </div>

          ${filteredAnnotatedGroups.length && typeof filteredAnnotatedGroups[0].g === "object" ? (
            nacState.groupTypeFilter === "ALL" && typeBuckets.length > 1
              ? (() => {
                  const perSectionCap = nacState.groupCap >= filteredAnnotatedGroups.length ? filteredAnnotatedGroups.length : 24;
                  const sectionsHtml = typeBuckets.map((bucket) => {
                    const slice = bucket.items.slice(0, perSectionCap);
                    const hasMoreInBucket = slice.length < bucket.items.length;
                    return `
                      <div style="margin-bottom:18px;">
                        <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 12px;margin-bottom:10px;background:var(--bg-elevated);border:1px solid var(--border);border-radius:8px;flex-wrap:wrap;gap:6px;">
                          <div style="display:flex;align-items:center;gap:8px;">
                            <span class="badge ${bucket.badgeClass}" style="font-size:12px;">${bucket.icon} ${esc(bucket.label)}</span>
                            <span style="font-size:12px;color:var(--text-secondary);"><strong>${bucket.items.length}</strong> groupe(s)${hasMoreInBucket ? ` (${slice.length} affichés)` : ""}</span>
                          </div>
                          <button class="btn btn-xs btn-ghost" data-grp-type="${esc(bucket.key)}">${hasMoreInBucket ? `Voir les ${bucket.items.length} →` : "Filtrer ce type →"}</button>
                        </div>
                        <div class="grid-2">
                          ${slice.map(renderGroupCard).join("")}
                        </div>
                      </div>`;
                  }).join("");
                  return sectionsHtml + (filteredAnnotatedGroups.length > nacState.groupCap
                    ? `<div style="text-align:center;margin:12px 0;"><button class="btn btn-sm btn-secondary" id="btn-nac-all-groups">Tout déplier (${filteredAnnotatedGroups.length} groupes)</button></div>`
                    : "");
                })()
              : `<div class="grid-2">
                  ${filteredAnnotatedGroups.slice(0, nacState.groupCap).map(renderGroupCard).join("")}
                </div>
                ${filteredAnnotatedGroups.length > nacState.groupCap ? `<div style="text-align:center;margin:12px 0;"><button class="btn btn-sm btn-secondary" id="btn-nac-all-groups">Afficher les ${filteredAnnotatedGroups.length} groupes</button></div>` : ""}`
          ) : `<div class="panel">${renderDynamicTable(filteredGroups, "Aucun groupe d'End-Systems correspondant.")}</div>`}
        ` : nacState.tab === "maclocks" ? `
          <div class="toolbar">
            <strong>Verrouillages MAC statiques (createMacLock)</strong>
            ${hasMut("createMacLock") ? `<button class="btn btn-sm btn-primary" id="btn-new-maclock">+ Nouveau MAC Lock</button>` : ""}
          </div>
          <div class="panel">${renderDynamicTable(macLocks, "Aucun MAC Lock retourné par ce schéma.")}</div>
        ` : `
          <div class="toolbar">
            <strong>Serveurs RADIUS configurés</strong>
            ${hasMut("createRadiusServer") ? `<button class="btn btn-sm btn-primary" id="btn-new-radius">+ Ajouter serveur RADIUS</button>` : ""}
          </div>
          <div class="panel">${renderDynamicTable(radius, "Aucun serveur RADIUS retourné par ce schéma.")}</div>
        `}

        ${renderDomainCatalogPanel(indexed, ["accessControl"], "Toutes les opérations ExtremeControl (accessControl)")}
      `;

      bindOpenStudio(viewport, nacState.tab === "groups" ? (grpRes.query || esRes.query) : esRes.query);
      bindDomainCatalogButtons(viewport, indexed);

      viewport.querySelectorAll("[data-actab]").forEach((b) => {
        b.addEventListener("click", () => { nacState.tab = b.dataset.actab; drawNac(); });
      });

      const nacLimSel = viewport.querySelector("#nac-limit-select");
      if (nacLimSel) {
        nacLimSel.addEventListener("change", (e) => {
          nacState.limit = e.target.value;
          renderNac(viewport);
        });
      }
      const nacLoadAllBtn = viewport.querySelector("#btn-nac-load-all");
      if (nacLoadAllBtn) {
        nacLoadAllBtn.addEventListener("click", () => {
          nacState.limit = "all";
          renderNac(viewport);
        });
      }
      const nacMoreBtn = viewport.querySelector("#btn-nac-more");
      if (nacMoreBtn) nacMoreBtn.addEventListener("click", () => { nacState.displayCap += 300; drawNac(); });
      const nacShowAllBtn = viewport.querySelector("#btn-nac-show-all");
      if (nacShowAllBtn) nacShowAllBtn.addEventListener("click", () => { nacState.displayCap = filteredEs.length; drawNac(); });
      const nacAllGrpBtn = viewport.querySelector("#btn-nac-all-groups");
      if (nacAllGrpBtn) nacAllGrpBtn.addEventListener("click", () => { nacState.groupCap = filteredGroups.length; drawNac(); });

      const ns = viewport.querySelector("#nac-search");
      if (ns) {
        ns.addEventListener("input", (e) => {
          nacState.search = e.target.value;
          nacState.displayCap = 300;
          const pos = e.target.selectionStart;
          drawNac();
          const el = viewport.querySelector("#nac-search");
          el.focus(); el.setSelectionRange(pos, pos);
        });
      }

      const ngs = viewport.querySelector("#nac-grp-search");
      if (ngs) {
        ngs.addEventListener("input", (e) => {
          nacState.groupSearch = e.target.value;
          const pos = e.target.selectionStart;
          drawNac();
          const el = viewport.querySelector("#nac-grp-search");
          el.focus(); el.setSelectionRange(pos, pos);
        });
      }

      const chkNonEmpty = viewport.querySelector("#chk-nonempty-grp");
      if (chkNonEmpty) {
        chkNonEmpty.addEventListener("change", (e) => {
          nacState.onlyNonEmptyGroups = e.target.checked;
          drawNac();
        });
      }

      viewport.querySelectorAll("[data-grp-type]").forEach((btn) => {
        btn.addEventListener("click", () => {
          nacState.groupTypeFilter = btn.dataset.grpType;
          nacState.groupCap = 120;
          drawNac();
        });
      });

      viewport.querySelectorAll("[data-inspect-grp]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const origIdx = parseInt(btn.dataset.inspectGrp, 10);
          const grpObj = groups[origIdx];
          if (grpObj) openGroupDetailsModal(grpObj);
        });
      });

      const expEs = viewport.querySelector("#btn-export-es-csv");
      if (expEs) expEs.addEventListener("click", () => XIQApi.exportFile(`xiqse-endsystems-${Date.now()}.csv`, XIQApi.rowsToCsv(filteredEs)));

      viewport.querySelectorAll("[data-reauth]").forEach((b) => {
        b.addEventListener("click", async () => {
          const mac = b.dataset.reauth;
          const m = `mutation Reauth($mac: String!) { accessControl { reauthenticateEndSystem(input: { macAddress: $mac }) { status message } } }`;
          const r = await runOp(m, { mac }, "nac");
          XIQApi.toast(r.data?.accessControl?.reauthenticateEndSystem?.message || r.errors?.[0]?.message || "Signal CoA envoyé.", r.ok ? "success" : "error");
        });
      });

      viewport.querySelectorAll("[data-bl-mac]").forEach((b) => {
        b.addEventListener("click", async () => {
          const mac = b.dataset.blMac;
          if (!confirm(`Placer ${mac} en Blacklist / Quarantaine ?`)) return;
          const mut = buildAdaptiveGroupMutation(indexed, "addMACToBlacklist", { value: mac, description: "Quarantaine via XIQ-SE Studio" });
          const r = await runOp(mut.query, mut.variables, "nac");
          XIQApi.toast(r.data?.accessControl?.addMACToBlacklist?.message || r.errors?.[0]?.message || "Blacklisté.", r.ok ? "success" : "error");
          renderNac(viewport);
        });
      });

      const qBl = viewport.querySelector("#btn-quick-blacklist");
      if (qBl) {
        qBl.addEventListener("click", () => {
          XIQApi.showModal({
            title: "Blacklister une adresse MAC (addMACToBlacklist)",
            bodyHtml: `<div class="form-grid">
              <div class="form-field full"><label>Adresse MAC *</label><input id="bl-mac-inp" placeholder="AA:BB:CC:DD:EE:FF" /></div>
              <div class="form-field full"><label>Motif</label><input id="bl-desc-inp" value="Isolation sécurité via XIQ-SE Studio" /></div>
            </div>`,
            footerHtml: `<button class="btn btn-ghost" onclick="XIQApi.closeModal()">Annuler</button><button class="btn btn-danger" id="btn-bl-go">Ajouter à la Blacklist</button>`,
            onMount: () => {
              document.getElementById("btn-bl-go").addEventListener("click", async () => {
                const entry = document.getElementById("bl-mac-inp").value.trim();
                const description = document.getElementById("bl-desc-inp").value.trim();
                if (!entry) return;
                const mut = buildAdaptiveGroupMutation(indexed, "addMACToBlacklist", { value: entry, description });
                const r = await runOp(mut.query, mut.variables, "nac");
                XIQApi.closeModal();
                XIQApi.toast(r.data?.accessControl?.addMACToBlacklist?.message || r.errors?.[0]?.message || "Terminé", r.ok ? "success" : "error");
                renderNac(viewport);
              });
            },
          });
        });
      }

      const bulkCsvBtn = viewport.querySelector("#btn-bulk-csv-import");
      if (bulkCsvBtn) {
        bulkCsvBtn.addEventListener("click", () => {
          const groupNames = groups.map((g) => (typeof g === "object" ? (g.name || g.groupName) : String(g))).filter(Boolean);
          NetOpsTools.openBulkCsvImportModal(groupNames, () => renderNac(viewport));
        });
      }

      const addGrpBtn = viewport.querySelector("#btn-add-group-entry");
      if (addGrpBtn) {
        addGrpBtn.addEventListener("click", () => {
          const groupNames = groups.map((g) => (typeof g === "object" ? (g.name || g.groupName) : String(g))).filter(Boolean);
          XIQApi.showModal({
            title: "Ajouter une entrée à un groupe End-System",
            bodyHtml: `<div class="form-grid">
              <div class="form-field"><label>Type d'entrée</label>
                <select id="ge-type">
                  <option value="addMACToEndSystemGroup">MAC (addMACToEndSystemGroup)</option>
                  <option value="addIPToEndSystemGroup">IP (addIPToEndSystemGroup)</option>
                  <option value="addHostnameToEndSystemGroup">Hostname (addHostnameToEndSystemGroup)</option>
                </select>
              </div>
              <div class="form-field"><label>Nom du groupe *</label>
                <input id="ge-grp" list="nac-groups-datalist" value="${esc(groupNames[0] || "")}" placeholder="Nom du groupe NAC" />
                <datalist id="nac-groups-datalist">${groupNames.map((n) => `<option value="${esc(n)}"></option>`).join("")}</datalist>
              </div>
              <div class="form-field full"><label>Valeur (MAC, IP ou Hostname) *</label><input id="ge-val" placeholder="AA:BB:CC:DD:EE:01" /></div>
              <div class="form-field full"><label>Description (optionnel)</label><input id="ge-desc" placeholder="Ajouté via XIQ-SE API Studio" /></div>
            </div>`,
            footerHtml: `<button class="btn btn-ghost" onclick="XIQApi.closeModal()">Annuler</button><button class="btn btn-primary" id="btn-ge-go">Ajouter</button>`,
            onMount: () => {
              document.getElementById("btn-ge-go").addEventListener("click", async () => {
                const fn = document.getElementById("ge-type").value;
                const groupName = document.getElementById("ge-grp").value.trim();
                const entry = document.getElementById("ge-val").value.trim();
                const description = document.getElementById("ge-desc").value.trim();
                if (!groupName || !entry) return;
                const mut = buildAdaptiveGroupMutation(indexed, fn, { groupName, value: entry, description });
                const r = await runOp(mut.query, mut.variables, "nac");
                XIQApi.closeModal();
                XIQApi.toast(r.data?.accessControl?.[fn]?.message || r.errors?.[0]?.message || "Terminé", r.ok ? "success" : "error");
                renderNac(viewport);
              });
            },
          });
        });
      }

      viewport.querySelectorAll("[data-rm-grp]").forEach((b) => {
        b.addEventListener("click", async () => {
          const mut = buildAdaptiveGroupMutation(indexed, "removeEntryFromGroup", {
            groupName: b.dataset.rmGrp,
            value: b.dataset.rmEnt,
          });
          const r = await runOp(mut.query, mut.variables, "nac");
          XIQApi.toast(r.data?.accessControl?.removeEntryFromGroup?.message || r.errors?.[0]?.message || "Retiré", r.ok ? "success" : "error");
          renderNac(viewport);
        });
      });

      const mlBtn = viewport.querySelector("#btn-new-maclock");
      if (mlBtn) {
        mlBtn.addEventListener("click", () => {
          XIQApi.showModal({
            title: "Créer un MAC Lock (createMacLock)",
            bodyHtml: `<div class="form-grid">
              <div class="form-field full"><label>Adresse MAC *</label><input id="ml-mac" placeholder="00:1A:2B:3C:4D:01" /></div>
              <div class="form-field"><label>IP du Switch *</label><input id="ml-sw" placeholder="10.10.1.11" /></div>
              <div class="form-field"><label>Port *</label><input id="ml-port" placeholder="1:5" /></div>
            </div>`,
            footerHtml: `<button class="btn btn-ghost" onclick="XIQApi.closeModal()">Annuler</button><button class="btn btn-primary" id="btn-ml-go">Verrouiller</button>`,
            onMount: () => {
              document.getElementById("btn-ml-go").addEventListener("click", async () => {
                const macAddress = document.getElementById("ml-mac").value.trim();
                const switchIp = document.getElementById("ml-sw").value.trim();
                const portName = document.getElementById("ml-port").value.trim();
                if (!macAddress || !switchIp || !portName) return;
                const m = `mutation MkMl($macAddress: String!, $switchIp: String!, $portName: String!) { accessControl { createMacLock(input: { macAddress: $macAddress, switchIp: $switchIp, portName: $portName }) { status message } } }`;
                const r = await runOp(m, { macAddress, switchIp, portName }, "nac");
                XIQApi.closeModal();
                XIQApi.toast(r.data?.accessControl?.createMacLock?.message || r.errors?.[0]?.message || "Terminé", r.ok ? "success" : "error");
                renderNac(viewport);
              });
            },
          });
        });
      }

      const radBtn = viewport.querySelector("#btn-new-radius");
      if (radBtn) {
        radBtn.addEventListener("click", () => {
          XIQApi.showModal({
            title: "Ajouter un serveur RADIUS (createRadiusServer)",
            bodyHtml: `<div class="form-grid">
              <div class="form-field"><label>Nom *</label><input id="rad-name" placeholder="RADIUS-SEC-01" /></div>
              <div class="form-field"><label>Adresse IP *</label><input id="rad-ip" placeholder="10.10.0.25" /></div>
              <div class="form-field"><label>Port Auth</label><input id="rad-port" type="number" value="1812" /></div>
              <div class="form-field"><label>Secret partagé *</label><input id="rad-sec" type="password" /></div>
            </div>`,
            footerHtml: `<button class="btn btn-ghost" onclick="XIQApi.closeModal()">Annuler</button><button class="btn btn-primary" id="btn-rad-go">Enregistrer</button>`,
            onMount: () => {
              document.getElementById("btn-rad-go").addEventListener("click", async () => {
                const name = document.getElementById("rad-name").value.trim();
                const ipAddress = document.getElementById("rad-ip").value.trim();
                const authPort = parseInt(document.getElementById("rad-port").value, 10) || 1812;
                const sharedSecret = document.getElementById("rad-sec").value;
                if (!name || !ipAddress) return;
                const m = `mutation MkRad($name: String!, $ipAddress: String!, $authPort: Int!, $sharedSecret: String!) { accessControl { createRadiusServer(input: { name: $name, ipAddress: $ipAddress, authPort: $authPort, sharedSecret: $sharedSecret }) { status message } } }`;
                const r = await runOp(m, { name, ipAddress, authPort, sharedSecret }, "nac");
                XIQApi.closeModal();
                XIQApi.toast(r.data?.accessControl?.createRadiusServer?.message || r.errors?.[0]?.message || "Terminé", r.ok ? "success" : "error");
                renderNac(viewport);
              });
            },
          });
        });
      }
    };

    drawNac();
  }

  // =========================================================================
  // 3B. AUDIT MAC JAMAIS VUES SUR LE RÉSEAU (Cross-ref NAC Groups vs ALL End-Systems)
  // =========================================================================
  const auditState = {
    profileId: null,
    running: false,
    cancelled: false,
    progressText: "",
    progressPct: 0,
    lastRunAt: null,
    stats: null,
    items: [], // [{ mac, status, groups: [{groupName, rawValue, description}], lastSeenTime, daysInactive, switchIp, switchPort, hostName, source }]
    filterMode: "never", // never | inactive90 | inactive180 | inactive365 | all
    search: "",
    groupFilter: "",
    selectedKeys: new Set(), // "mac||groupName||rawValue"
  };

  function normalizeMac(val) {
    if (!val) return null;
    const s = String(val).trim();
    // Skip wildcards or patterns
    if (s.includes("*") || s.includes("/") || s.includes("?")) return null;
    // Match 6 octets separated by : or -
    const m1 = s.match(/^([0-9a-fA-F]{2})[:-]([0-9a-fA-F]{2})[:-]([0-9a-fA-F]{2})[:-]([0-9a-fA-F]{2})[:-]([0-9a-fA-F]{2})[:-]([0-9a-fA-F]{2})$/);
    if (m1) return m1.slice(1).join(":").toUpperCase();
    // Match Cisco format aaaa.bbbb.cccc
    const m2 = s.match(/^([0-9a-fA-F]{4})\.([0-9a-fA-F]{4})\.([0-9a-fA-F]{4})$/);
    if (m2) {
      const hex = (m2[1] + m2[2] + m2[3]).toUpperCase();
      return hex.match(/.{2}/g).join(":");
    }
    // Match bare 12 hex digits
    const m3 = s.match(/^([0-9a-fA-F]{12})$/);
    if (m3) {
      return m3[1].toUpperCase().match(/.{2}/g).join(":");
    }
    return null;
  }

  function parseTimestampMs(raw) {
    if (raw === null || raw === undefined || raw === "" || raw === 0 || raw === "0") return null;
    if (typeof raw === "number") {
      if (raw <= 0) return null;
      return raw < 1e12 ? raw * 1000 : raw;
    }
    const str = String(raw).trim();
    if (!str || /^never$/i.test(str) || /^n\/a$/i.test(str) || str.startsWith("1970-01-01") || str.startsWith("1969-12-31")) {
      return null;
    }
    if (/^\d+$/.test(str)) {
      const n = Number(str);
      if (n <= 0) return null;
      return n < 1e12 ? n * 1000 : n;
    }
    const parsed = Date.parse(str);
    if (Number.isNaN(parsed) || parsed <= 86400000) return null;
    return parsed;
  }

  function isLikelyNonMacGroupType(typeStr) {
    if (!typeStr) return false;
    const t = String(typeStr).toLowerCase();
    if (t.includes("mac") || t.includes("end") || t.includes("system") || t.includes("black") || t.includes("custom")) {
      return false;
    }
    return /(ip|subnet|host|user|location|switch|port|time|device|os|rule|policy|ssid|vlan|ldap|radius)/i.test(t);
  }

  async function fetchAllEndSystemsForAudit(indexed, onProgress) {
    const seenMacsSet = new Set();
    const endSystemByMac = new Map();

    // 1) Try fast authoritative list of all MACs ever known to NAC
    try {
      const allMacsRes = await runAdaptive(
        indexed,
        ["accessControl"],
        ["allEndSystemMacs"],
        {},
        "mac_audit"
      );
      if (allMacsRes.ok && Array.isArray(allMacsRes.data)) {
        allMacsRes.data.forEach((m) => {
          const norm = normalizeMac(m);
          if (norm) seenMacsSet.add(norm);
        });
      }
    } catch {
      // Non-fatal; pagination below will still load End-Systems
    }

    // 2) Paginate through ALL End-Systems to get lastSeenTime, switch, port, hostName...
    const dom = SchemaTools.getDomainType(indexed, ["accessControl"], "query");
    const esField = dom
      ? SchemaTools.findFieldByCandidates(indexed, dom.domainType, ["endSystems", "allEndSystemsAsProperties", "allEndSystems"])
      : null;

    if (esField) {
      const argNames = (esField.args || []).map((a) => a.name);
      const maxArg = argNames.find((n) => /^(maxresults|limit|pagesize|count)$/i.test(n));
      const firstArg = argNames.find((n) => /^(firstresult|offset|startindex)$/i.test(n));
      const pageSize = 500;
      const maxPages = 100; // up to 50,000 end-systems safely

      let offset = 0;
      for (let page = 0; page < maxPages; page++) {
        if (auditState.cancelled) break;
        const pageArgs = {};
        if (maxArg) pageArgs[maxArg] = pageSize;
        if (firstArg) pageArgs[firstArg] = offset;

        onProgress(
          `Chargement des End-Systems réseau (${endSystemByMac.size} chargés)...`,
          Math.min(28, 5 + page * 3)
        );

        let res = null;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            res = await runAdaptive(
              indexed,
              ["accessControl"],
              [esField.name],
              {
                args: pageArgs,
                wrapperCandidates: ["endSystem", "endSystems", "results", "items"],
                preferredScalars: [
                  "macAddress", "ipAddress", "hostName", "username", "userName",
                  "switchIP", "switchIp", "portName", "switchPortName", "portIfName", "portDisplayName",
                  "interfaceName", "ifName", "switchPort", "port", "switchPortId",
                  "state", "lastSeenTime", "firstSeenTime", "lastAuthEventTime",
                  "profile", "policy", "nacProfile", "policyName", "rule", "ruleName",
                  "reason", "authReason", "endSystemGroup", "category", "zone", "vlan",
                ],
                includeAllScalars: false,
              },
              "mac_audit"
            );
            break;
          } catch {
            res = null;
          }
        }
        if (!res) break;

        const batch = Array.isArray(res.data) ? res.data : [];
        let newlyAdded = 0;
        batch.forEach((es) => {
          const norm = normalizeMac(es?.macAddress);
          if (!norm) return;
          if (!endSystemByMac.has(norm)) newlyAdded++;
          endSystemByMac.set(norm, es);
          const ts = parseTimestampMs(es.lastSeenTime ?? es.lastAuthEventTime ?? es.firstSeenTime);
          if (ts !== null) {
            seenMacsSet.add(norm);
          }
        });

        // Stop if not paginated, empty page, partial page, or no new entries returned
        if (!maxArg || !firstArg || batch.length < pageSize || newlyAdded === 0) {
          break;
        }
        offset += pageSize;
      }
    }

    return { seenMacsSet, endSystemByMac };
  }

  async function runMacNeverSeenAudit(viewport) {
    const pid = getActiveProfileId();
    auditState.profileId = pid;
    auditState.running = true;
    auditState.cancelled = false;
    auditState.progressPct = 3;
    auditState.progressText = "Introspection du schéma XIQ-SE...";
    auditState.selectedKeys.clear();
    drawMacAudit(viewport);

    const updateProgress = (text, pct) => {
      auditState.progressText = text;
      auditState.progressPct = pct;
      const lbl = viewport.querySelector("#audit-progress-text");
      const bar = viewport.querySelector("#audit-progress-bar");
      if (lbl) lbl.textContent = text;
      if (bar) bar.style.width = `${pct}%`;
    };

    try {
      const indexed = await getSchema();
      if (!indexed) {
        XIQApi.toast("Schéma GraphQL indisponible pour cet audit.", "error");
        auditState.running = false;
        drawMacAudit(viewport);
        return;
      }

      // Step 1: Load ALL End-Systems from network
      const { seenMacsSet, endSystemByMac } = await fetchAllEndSystemsForAudit(indexed, updateProgress);
      if (auditState.cancelled) {
        auditState.running = false;
        drawMacAudit(viewport);
        return;
      }

      // Step 2: Load NAC groups list
      updateProgress("Chargement de la liste des groupes NAC...", 32);
      const grpRes = await runAdaptive(
        indexed,
        ["accessControl"],
        ["endSystemGroups", "groups", "allGroups", "groupNames"],
        {
          preferredScalars: ["name", "groupName", "type", "description", "values", "entries", "members"],
          nestedSpecs: [
            { candidates: ["values", "entries", "members", "groupValues", "valueList"], includeAllScalars: true },
          ],
          includeAllScalars: true,
        },
        "mac_audit"
      );

      const rawGroups = Array.isArray(grpRes.data) ? grpRes.data : [];
      const hasSingleGroupQuery = Boolean(
        SchemaTools.listCallableDomainQueries(indexed, ["accessControl"]).find((q) =>
          ["group", "groupByName", "endSystemGroup"].includes(q.field.name)
        )
      );

      // Step 3: Resolve entries for each group (inline or via accessControl.group(name: ...) in parallel batches)
      const macMap = new Map(); // normMac -> { mac, groups: [{ groupName, rawValue, description }] }
      let scannedGroups = 0;
      let totalGroupEntries = 0;

      const recordEntries = (groupName, entries) => {
        entries.forEach((ent) => {
          const norm = normalizeMac(ent.raw);
          if (!norm) return;
          totalGroupEntries++;
          if (!macMap.has(norm)) {
            macMap.set(norm, { mac: norm, groups: [] });
          }
          const rec = macMap.get(norm);
          if (!rec.groups.some((x) => x.groupName === groupName && x.rawValue === ent.raw)) {
            const descMatch = ent.label.match(/\((.*)\)$/);
            rec.groups.push({
              groupName,
              rawValue: ent.raw,
              description: descMatch ? descMatch[1] : "",
            });
          }
        });
      };

      const groupsNeedingFetch = [];
      for (const g of rawGroups) {
        const gName = typeof g === "object" ? (g.name || g.groupName || "") : String(g);
        if (!gName) continue;
        const gType = typeof g === "object" ? (g.type || "") : "";
        const inlineEntries = typeof g === "object" ? getGroupEntries(g) : [];
        if (inlineEntries.length) {
          recordEntries(gName, inlineEntries);
          scannedGroups++;
        } else if (hasSingleGroupQuery && !isLikelyNonMacGroupType(gType)) {
          groupsNeedingFetch.push(gName);
        } else {
          scannedGroups++;
        }
      }

      // Determine exact single-group field name, argument name, and safe selection from live __schema
      const acDom = SchemaTools.getDomainType(indexed, ["accessControl"], "query");
      const singleGrpField = acDom
        ? SchemaTools.findFieldByCandidates(indexed, acDom.domainType, ["group", "groupByName", "endSystemGroup"])
        : null;
      const singleGrpArgName = singleGrpField?.args?.find((a) => /^(name|groupname|group)$/i.test(a.name))?.name || "name";
      const singleGrpRetBase = singleGrpField ? SchemaTools.unwrapType(singleGrpField.type) : null;
      const singleGrpSelection = singleGrpRetBase
        ? SchemaTools.buildSafeSelection(
            indexed,
            singleGrpRetBase.name,
            ["name", "type", "values", "entries", "members"],
            [{ candidates: ["values", "entries", "members", "groupValues", "valueList"], includeAllScalars: true }],
            true
          )
        : "name values";

      const fetchSingleGroupSafe = async (gName) => {
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const singleRes = await runAdaptive(
              indexed,
              ["accessControl"],
              ["group", "groupByName", "endSystemGroup"],
              {
                args: { name: gName, groupName: gName, group: gName },
                preferredScalars: ["name", "type", "values", "entries", "members"],
                nestedSpecs: [
                  { candidates: ["values", "entries", "members", "groupValues", "valueList"], includeAllScalars: true },
                ],
                includeAllScalars: true,
              },
              "mac_audit"
            );
            if (singleRes.ok && singleRes.data) {
              recordEntries(gName, getGroupEntries(singleRes.data));
              return;
            }
          } catch {
            // retry once silently
          }
        }
      };

      // Use GraphQL aliased batch queries (15 groups per HTTP request -> ~15 calls total for 217 groups!)
      // with automatic fallback to single-group calls if a batch fails.
      const aliasBatchSize = 15;
      for (let i = 0; i < groupsNeedingFetch.length; i += aliasBatchSize) {
        if (auditState.cancelled) break;
        const chunk = groupsNeedingFetch.slice(i, i + aliasBatchSize);
        const pct = 35 + Math.round(((i + chunk.length) / Math.max(1, groupsNeedingFetch.length)) * 60);
        updateProgress(
          `Analyse des groupes NAC : ${scannedGroups + i + chunk.length} / ${rawGroups.length} (${macMap.size} MAC uniques trouvées)...`,
          Math.min(96, pct)
        );

        let batchOk = false;
        if (singleGrpField && singleGrpSelection) {
          const aliasLines = chunk
            .map((gName, idx) => `g${idx}: ${singleGrpField.name}(${singleGrpArgName}: ${JSON.stringify(gName)}) { ${singleGrpSelection} }`)
            .join("\n    ");
          const batchQuery = `query BatchNacGroups {\n  ${acDom.domainFieldName} {\n    ${aliasLines}\n  }\n}`;
          try {
            const bRes = await runOp(batchQuery, {}, "mac_audit");
            const acData = bRes?.data?.[acDom.domainFieldName];
            if (bRes?.ok && acData && typeof acData === "object") {
              chunk.forEach((gName, idx) => {
                const gObj = acData[`g${idx}`];
                if (gObj) recordEntries(gName, getGroupEntries(gObj));
              });
              batchOk = true;
            }
          } catch {
            batchOk = false;
          }
        }

        if (!batchOk) {
          // Gentle sequential/small-batch fallback so a single bad group never breaks the audit
          for (let j = 0; j < chunk.length; j += 3) {
            if (auditState.cancelled) break;
            await Promise.all(chunk.slice(j, j + 3).map(fetchSingleGroupSafe));
          }
        }
      }

      // Step 4: Resolve physical port names (e.g. 1/6) from switch port tables & cross-reference
      updateProgress("Résolution des noms physiques de ports (ex: 1/6) sur les switches...", 96);
      const relevantEndSystems = [];
      for (const normMac of macMap.keys()) {
        const es = endSystemByMac.get(normMac);
        if (es) relevantEndSystems.push(es);
      }
      const auditSwitchMap = await NetOpsTools.buildSwitchPortLookupMap(
        indexed,
        relevantEndSystems,
        (done, total) => updateProgress(`Résolution des ports physiques : ${done} / ${total} switches...`, 96)
      ).catch(() => new Map());

      updateProgress("Croisement des MAC avec les End-Systems réseau...", 98);
      const nowMs = Date.now();
      const items = [];

      for (const [normMac, rec] of macMap.entries()) {
        const es = endSystemByMac.get(normMac) || null;
        const tsMs = es ? parseTimestampMs(es.lastSeenTime ?? es.lastAuthEventTime ?? es.firstSeenTime) : null;
        const inAllMacs = seenMacsSet.has(normMac);

        let status = "ACTIVE";
        let daysInactive = null;
        if (!inAllMacs && !es) {
          status = "NEVER_SEEN";
        } else if (es && tsMs === null) {
          status = "NEVER_SEEN_ES";
        } else if (tsMs !== null) {
          daysInactive = Math.max(0, Math.floor((nowMs - tsMs) / 86400000));
          status = daysInactive >= 90 ? "INACTIVE" : "ACTIVE";
        } else if (inAllMacs) {
          status = "SEEN_NO_DATE";
        }

        const swIp = es?.switchIP || es?.switchIp || "";
        const swDev = swIp ? auditSwitchMap.get(swIp) : null;
        const swName = swDev?.sysName || swDev?.deviceName || "";
        const resolvedPort = es ? NetOpsTools.resolveEndSystemPortDisplay(es, auditSwitchMap) : "";

        items.push({
          mac: normMac,
          status,
          groups: rec.groups,
          groupNames: rec.groups.map((g) => g.groupName),
          descriptions: rec.groups.map((g) => g.description).filter(Boolean).join(" | "),
          lastSeenTime: tsMs ? new Date(tsMs).toISOString() : (es?.lastSeenTime || ""),
          daysInactive,
          switchIp: swIp,
          switchName: swName,
          switchPort: resolvedPort,
          ipAddress: es?.ipAddress || "",
          hostName: es?.hostName || "",
          esState: es?.state || "",
          nacSignals: es
            ? {
                endSystemGroup: es.endSystemGroup || "",
                ruleName: es.ruleName || es.rule || "",
                reason: es.reason || es.authReason || "",
                profile: es.profile || es.nacProfile || "",
                policy: es.policy || es.policyName || "",
                category: es.category || "",
                zone: es.zone || "",
                vlan: es.vlan || "",
              }
            : null,
          source: "Groupe NAC",
        });
      }

      // Also include any End-System registered in NAC with NO lastSeenTime at all
      let orphanNeverSeenEs = 0;
      for (const [normMac, es] of endSystemByMac.entries()) {
        if (macMap.has(normMac)) continue;
        const tsMs = parseTimestampMs(es.lastSeenTime ?? es.lastAuthEventTime ?? es.firstSeenTime);
        if (tsMs === null) {
          orphanNeverSeenEs++;
          const swIp = es.switchIP || es.switchIp || "";
          const swDev = swIp ? auditSwitchMap.get(swIp) : null;
          items.push({
            mac: normMac,
            status: "NEVER_SEEN_ES",
            groups: [],
            groupNames: [],
            descriptions: es.profile || es.policy || "",
            lastSeenTime: "",
            daysInactive: null,
            switchIp: swIp,
            switchName: swDev?.sysName || swDev?.deviceName || "",
            switchPort: NetOpsTools.resolveEndSystemPortDisplay(es, auditSwitchMap),
            hostName: es.hostName || "",
            esState: es.state || "",
            source: "End-System sans date",
          });
        }
      }

      // Sort: never seen first, then oldest inactive, then MAC
      const order = { NEVER_SEEN: 0, NEVER_SEEN_ES: 1, INACTIVE: 2, SEEN_NO_DATE: 3, ACTIVE: 4 };
      items.sort((a, b) => {
        if (order[a.status] !== order[b.status]) return order[a.status] - order[b.status];
        if ((b.daysInactive ?? -1) !== (a.daysInactive ?? -1)) return (b.daysInactive ?? -1) - (a.daysInactive ?? -1);
        return a.mac.localeCompare(b.mac);
      });

      const neverSeenCount = items.filter((x) => x.status === "NEVER_SEEN" || x.status === "NEVER_SEEN_ES").length;
      const inactive90Count = items.filter((x) => x.daysInactive !== null && x.daysInactive >= 90).length;
      const inactive365Count = items.filter((x) => x.groups.length > 0 && x.daysInactive !== null && x.daysInactive >= 365).length;
      const duplicateCount = items.filter((x) => x.groupNames.length >= 2).length;
      const conflictsCount = analyzeSecurityConflicts(items).length;

      auditState.items = items;
      auditState.lastRunAt = new Date().toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
      auditState.stats = {
        totalGroups: rawGroups.length,
        totalUniqueGroupMacs: macMap.size,
        totalGroupEntries,
        totalNetworkEndSystems: Math.max(seenMacsSet.size, endSystemByMac.size),
        neverSeenCount,
        duplicateCount,
        conflictsCount,
        inactive90Count,
        inactive365Count,
        orphanNeverSeenEs,
      };
      XIQApi.saveAuditSummary({ ...auditState.stats, lastRunAt: auditState.lastRunAt }).catch(() => {});
      XIQApi.toast(
        `Audit terminé : ${neverSeenCount} MAC jamais vue(s), ${duplicateCount} doublon(s) multi-groupes sur ${macMap.size} MAC uniques.`,
        neverSeenCount || duplicateCount ? "warn" : "success"
      );
    } catch (err) {
      XIQApi.toast(`Erreur pendant l'audit MAC : ${err.message}`, "error");
    } finally {
      auditState.running = false;
      auditState.progressPct = 100;
      drawMacAudit(viewport);
    }
  }

  function drawMacAudit(viewport) {
    const indexed = SchemaTools.getCachedSchemaInfo().indexed;
    const nacMuts = indexed ? SchemaTools.listDomainMutations(indexed, ["accessControl"]) : [];
    const canRemove = nacMuts.some((m) => m.field.name === "removeEntryFromGroup");

    // Filter items according to UI controls
    const q = auditState.search.trim().toLowerCase();
    const filtered = auditState.items.filter((item) => {
      if (auditState.filterMode === "never") {
        if (item.status !== "NEVER_SEEN" && item.status !== "NEVER_SEEN_ES") return false;
      } else if (auditState.filterMode === "duplicates") {
        if (item.groupNames.length < 2) return false;
      } else if (auditState.filterMode === "inactive90") {
        if (!(item.status === "NEVER_SEEN" || item.status === "NEVER_SEEN_ES" || (item.daysInactive !== null && item.daysInactive >= 90))) return false;
      } else if (auditState.filterMode === "inactive180") {
        if (!(item.status === "NEVER_SEEN" || item.status === "NEVER_SEEN_ES" || (item.daysInactive !== null && item.daysInactive >= 180))) return false;
      } else if (auditState.filterMode === "inactive365") {
        if (!(item.status === "NEVER_SEEN" || item.status === "NEVER_SEEN_ES" || (item.daysInactive !== null && item.daysInactive >= 365))) return false;
      }
      if (auditState.groupFilter && !item.groupNames.includes(auditState.groupFilter)) return false;
      if (!q) return true;
      return (
        item.mac.toLowerCase().includes(q) ||
        item.groupNames.some((g) => g.toLowerCase().includes(q)) ||
        (item.descriptions || "").toLowerCase().includes(q) ||
        (item.hostName || "").toLowerCase().includes(q)
      );
    });

    // Count never-seen MACs per group for the group filter dropdown
    const groupCounts = {};
    auditState.items.forEach((it) => {
      const isNever = it.status === "NEVER_SEEN" || it.status === "NEVER_SEEN_ES";
      it.groupNames.forEach((gn) => {
        if (!groupCounts[gn]) groupCounts[gn] = { total: 0, never: 0 };
        groupCounts[gn].total++;
        if (isNever) groupCounts[gn].never++;
      });
    });
    const sortedGroupOptions = Object.entries(groupCounts).sort((a, b) => b[1].never - a[1].never || a[0].localeCompare(b[0]));

    const st = auditState.stats;
    const neverPct = st && st.totalUniqueGroupMacs ? Math.round((st.neverSeenCount / st.totalUniqueGroupMacs) * 100) : 0;

    viewport.innerHTML = `
      <div class="alert-banner">
        <div>
          <strong>Audit MAC Jamais Vues &amp; Doublons Multi-Groupes :</strong> croise toutes les MAC de vos groupes NAC avec l'ensemble complet des End-Systems réseau et détecte les MAC présentes dans plusieurs groupes.
          ${auditState.lastRunAt ? `<span style="color:var(--text-muted);margin-left:6px;">Dernier scan : ${esc(auditState.lastRunAt)}</span>` : ""}
        </div>
        <div style="display:flex;gap:6px;">
          ${auditState.running
            ? `<button class="btn btn-xs btn-danger" id="btn-audit-cancel">Arrêter</button>`
            : `<button class="btn btn-xs btn-primary" id="btn-audit-run">↻ ${st ? "Relancer l'audit" : "Lancer l'audit"}</button>`}
        </div>
      </div>

      ${auditState.running ? `
        <div class="panel">
          <div class="panel-body">
            <div style="display:flex;justify-content:space-between;margin-bottom:8px;font-size:13px;">
              <span id="audit-progress-text">${esc(auditState.progressText)}</span>
              <strong>${auditState.progressPct}%</strong>
            </div>
            <div class="bar-track" style="height:10px;">
              <div class="bar-fill" id="audit-progress-bar" style="width:${auditState.progressPct}%;transition:width 0.2s;"></div>
            </div>
          </div>
        </div>` : ""}

      ${st ? `
        <div class="kpi-grid">
          <div class="kpi-card" style="cursor:pointer;" data-amode="never">
            <div class="kpi-label">MAC Jamais Vues</div>
            <div class="kpi-value" style="color:${st.neverSeenCount ? "var(--red)" : "var(--green)"};">${st.neverSeenCount}</div>
            <div class="kpi-sub">${neverPct}% des MAC déclarées en groupes</div>
          </div>
          <div class="kpi-card" style="cursor:pointer;border-color:${st.duplicateCount ? "rgba(245,158,11,0.45)" : "var(--border)"};" data-amode="duplicates">
            <div class="kpi-label">Doublons Multi-Groupes</div>
            <div class="kpi-value" style="color:${st.duplicateCount ? "var(--amber)" : "var(--green)"};">${st.duplicateCount ?? 0}</div>
            <div class="kpi-sub">MAC dans ≥ 2 groupes NAC</div>
          </div>
          <div class="kpi-card">
            <div class="kpi-label">MAC dans Groupes NAC</div>
            <div class="kpi-value">${st.totalUniqueGroupMacs}</div>
            <div class="kpi-sub">${st.totalGroups} groupe(s) analysé(s)</div>
          </div>
          <div class="kpi-card">
            <div class="kpi-label">End-Systems Réseau Scannés</div>
            <div class="kpi-value" style="color:var(--cyan);">${st.totalNetworkEndSystems}</div>
            <div class="kpi-sub">Base de référence complète</div>
          </div>
          <div class="kpi-card" style="cursor:pointer;" data-amode="inactive90">
            <div class="kpi-label">Vues mais Inactives &gt; 90j</div>
            <div class="kpi-value" style="color:var(--amber);">${st.inactive90Count}</div>
            <div class="kpi-sub">Candidats au nettoyage</div>
          </div>
        </div>

        <div class="toolbar">
          <div class="toolbar-group">
            <button class="btn btn-xs ${auditState.filterMode === "never" ? "btn-primary" : "btn-ghost"}" data-amode="never">Jamais vues (${st.neverSeenCount})</button>
            <button class="btn btn-xs ${auditState.filterMode === "duplicates" ? "btn-primary" : "btn-ghost"}" data-amode="duplicates">Doublons multi-groupes (${st.duplicateCount ?? 0})</button>
            <button class="btn btn-xs btn-success" onclick="XIQApp.navigate('suggestions')">✦ Suggestions nettoyage</button>
            <button class="btn btn-xs ${auditState.filterMode === "inactive90" ? "btn-primary" : "btn-ghost"}" data-amode="inactive90">Jamais vues + &gt;90j</button>
            <button class="btn btn-xs ${auditState.filterMode === "inactive180" ? "btn-primary" : "btn-ghost"}" data-amode="inactive180">Jamais vues + &gt;180j</button>
            <button class="btn btn-xs ${auditState.filterMode === "inactive365" ? "btn-primary" : "btn-ghost"}" data-amode="inactive365">Jamais vues + &gt;1 an</button>
            <button class="btn btn-xs ${auditState.filterMode === "all" ? "btn-primary" : "btn-ghost"}" data-amode="all">Toutes (${auditState.items.length})</button>
          </div>
          <div class="toolbar-group">
            ${canRemove && auditState.selectedKeys.size ? `<button class="btn btn-sm btn-danger" id="btn-audit-bulk-remove">Retirer la sélection (${auditState.selectedKeys.size})</button>` : ""}
            <button class="btn btn-sm btn-secondary" id="btn-audit-csv">Exporter CSV (${filtered.length})</button>
            <button class="btn btn-sm btn-ghost" id="btn-audit-json">Exporter JSON</button>
          </div>
        </div>

        <div class="toolbar">
          <div class="toolbar-group">
            <input id="audit-search" placeholder="Filtrer par MAC, groupe, description..." value="${esc(auditState.search)}" style="width:280px;" />
            <select id="audit-group-filter" style="max-width:300px;">
              <option value="">Tous les groupes NAC (${sortedGroupOptions.length})</option>
              ${sortedGroupOptions.map(([gn, c]) => `<option value="${esc(gn)}" ${auditState.groupFilter === gn ? "selected" : ""}>${esc(gn)} — ${c.never} jamais vue(s) / ${c.total}</option>`).join("")}
            </select>
          </div>
          <span style="font-size:12px;color:var(--text-muted);">${filtered.length} résultat(s) affiché(s)</span>
        </div>

        <div class="panel">
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  ${canRemove ? `<th style="width:32px;"><input type="checkbox" id="audit-select-all" title="Tout sélectionner (filtrés)" /></th>` : ""}
                  <th>Adresse MAC</th>
                  <th>Statut Réseau</th>
                  <th>Groupe(s) NAC</th>
                  <th>Description</th>
                  <th>Dernière Activité</th>
                  <th>Switch / Port</th>
                  ${canRemove ? `<th>Action</th>` : ""}
                </tr>
              </thead>
              <tbody>
                ${filtered.length ? filtered.slice(0, 500).map((it) => {
                  const statusBadge =
                    it.status === "NEVER_SEEN"
                      ? `<span class="badge badge-red">Jamais vue (Absente NAC)</span>`
                      : it.status === "NEVER_SEEN_ES"
                      ? `<span class="badge badge-red">Jamais vue (Sans date)</span>`
                      : it.status === "INACTIVE"
                      ? `<span class="badge badge-amber">Inactive (${it.daysInactive} j)</span>`
                      : it.status === "SEEN_NO_DATE"
                      ? `<span class="badge badge-cyan">Vue (date N/A)</span>`
                      : `<span class="badge badge-green">Active (${it.daysInactive ?? 0} j)</span>`;

                  const firstGrp = it.groups[0];
                  const selKey = firstGrp ? `${it.mac}||${firstGrp.groupName}||${firstGrp.rawValue}` : "";
                  const checked = selKey && auditState.selectedKeys.has(selKey);

                  return `<tr>
                    ${canRemove ? `<td>${firstGrp ? `<input type="checkbox" class="audit-row-chk" data-key="${esc(selKey)}" ${checked ? "checked" : ""} />` : ""}</td>` : ""}
                    <td class="mono"><strong>${XIQApi.macLink(it.mac)}</strong>${it.hostName ? `<div style="font-size:11px;color:var(--text-muted);">${esc(it.hostName)}</div>` : ""}</td>
                    <td>${statusBadge}</td>
                    <td>${it.groups.length ? it.groups.map((g) => `<span class="badge ${it.groups.length >= 2 ? "badge-amber" : "badge-purple"}" style="margin:2px;">${esc(g.groupName)}${canRemove ? ` <button type="button" data-rm-single="${esc(`${it.mac}||${g.groupName}||${g.rawValue}`)}" title="Retirer de ${esc(g.groupName)}" style="background:none;border:none;color:inherit;cursor:pointer;font-weight:700;margin-left:3px;padding:0;">✕</button>` : ""}</span>`).join(" ") : `<span class="badge badge-muted">${esc(it.source)}</span>`}</td>
                    <td style="font-size:12px;color:var(--text-secondary);">${esc(it.descriptions || "—")}</td>
                    <td class="mono">${it.lastSeenTime ? esc(it.lastSeenTime.slice(0, 19).replace("T", " ")) : `<span style="color:var(--red);">Jamais</span>`}</td>
                    <td class="mono">${it.switchIp ? `${it.switchName && it.switchName !== it.switchIp ? `<div><strong>${esc(it.switchName)}</strong></div>` : ""}${XIQApi.switchIpLink(it.switchIp)} <span style="color:var(--cyan);margin-left:4px;">${esc(it.switchPort)}</span>` : "—"}</td>
                    ${canRemove ? `<td>${firstGrp ? `<button class="btn btn-xs btn-danger" data-rm-single="${esc(selKey)}">Retirer</button>` : "—"}</td>` : ""}
                  </tr>`;
                }).join("") : `<tr><td colspan="${canRemove ? 8 : 6}" class="empty-state">Aucune adresse MAC ne correspond à ce filtre.</td></tr>`}
              </tbody>
            </table>
          </div>
          ${filtered.length > 500 ? `<div style="padding:8px 14px;font-size:12px;color:var(--text-muted);border-top:1px solid var(--border);">Affichage limité aux 500 premières lignes. Utilisez « Exporter CSV » pour obtenir l'intégralité des ${filtered.length} résultats.</div>` : ""}
        </div>
      ` : !auditState.running ? `<div class="panel"><div class="empty-state">Cliquez sur « Lancer l'audit » pour analyser vos groupes NAC et détecter les adresses MAC jamais vues sur le réseau.</div></div>` : ""}
    `;

    // Bind events
    const runBtn = viewport.querySelector("#btn-audit-run");
    if (runBtn) runBtn.addEventListener("click", () => runMacNeverSeenAudit(viewport));

    const cancelBtn = viewport.querySelector("#btn-audit-cancel");
    if (cancelBtn) cancelBtn.addEventListener("click", () => { auditState.cancelled = true; });

    viewport.querySelectorAll("[data-amode]").forEach((b) => {
      b.addEventListener("click", () => {
        auditState.filterMode = b.dataset.amode;
        auditState.selectedKeys.clear();
        drawMacAudit(viewport);
      });
    });

    const srch = viewport.querySelector("#audit-search");
    if (srch) {
      srch.addEventListener("input", (e) => {
        auditState.search = e.target.value;
        const pos = e.target.selectionStart;
        drawMacAudit(viewport);
        const el = viewport.querySelector("#audit-search");
        el.focus(); el.setSelectionRange(pos, pos);
      });
    }

    const gFlt = viewport.querySelector("#audit-group-filter");
    if (gFlt) {
      gFlt.addEventListener("change", (e) => {
        auditState.groupFilter = e.target.value;
        auditState.selectedKeys.clear();
        drawMacAudit(viewport);
      });
    }

    const csvBtn = viewport.querySelector("#btn-audit-csv");
    if (csvBtn) {
      csvBtn.addEventListener("click", () => {
        const rows = filtered.map((it) => ({
          MAC: it.mac,
          Statut:
            it.status === "NEVER_SEEN"
              ? "Jamais vue (absente End-Systems)"
              : it.status === "NEVER_SEEN_ES"
              ? "Jamais vue (sans date lastSeenTime)"
              : it.status === "INACTIVE"
              ? `Inactive (${it.daysInactive} jours)`
              : "Active",
          Groupes_NAC: it.groupNames.join(" | "),
          Nb_Groupes: it.groupNames.length,
          Descriptions: it.descriptions,
          Derniere_Activite: it.lastSeenTime || "Jamais",
          Jours_Inactif: it.daysInactive ?? "",
          Switch: it.switchIp,
          Port: it.switchPort,
          HostName: it.hostName,
        }));
        XIQApi.exportFile(`xiqse-audit-mac-jamais-vues-${Date.now()}.csv`, XIQApi.rowsToCsv(rows));
      });
    }

    const jsonBtn = viewport.querySelector("#btn-audit-json");
    if (jsonBtn) {
      jsonBtn.addEventListener("click", () => {
        XIQApi.exportFile(`xiqse-audit-mac-jamais-vues-${Date.now()}.json`, JSON.stringify(filtered, null, 2));
      });
    }

    const selAll = viewport.querySelector("#audit-select-all");
    if (selAll) {
      selAll.addEventListener("change", (e) => {
        const chks = viewport.querySelectorAll(".audit-row-chk");
        chks.forEach((c) => {
          c.checked = e.target.checked;
          if (e.target.checked) auditState.selectedKeys.add(c.dataset.key);
          else auditState.selectedKeys.delete(c.dataset.key);
        });
        drawMacAudit(viewport);
      });
    }

    viewport.querySelectorAll(".audit-row-chk").forEach((c) => {
      c.addEventListener("change", () => {
        if (c.checked) auditState.selectedKeys.add(c.dataset.key);
        else auditState.selectedKeys.delete(c.dataset.key);
        drawMacAudit(viewport);
      });
    });

    const removeEntries = async (keysList) => {
      if (!keysList.length) return;
      if (!confirm(`Retirer ${keysList.length} adresse(s) MAC de leur groupe NAC sur XIQ-SE ?`)) return;
      let okCount = 0;
      let errCount = 0;
      const removedSet = new Set();
      for (const k of keysList) {
        const [, groupName, rawValue] = k.split("||");
        const mut = buildAdaptiveGroupMutation(indexed, "removeEntryFromGroup", { groupName, value: rawValue });
        const r = await runOp(mut.query, mut.variables, "mac_audit");
        if (r.ok) {
          okCount++;
          removedSet.add(k);
        } else {
          errCount++;
        }
      }
      if (removedSet.size) {
        auditState.items = auditState.items
          .map((it) => {
            const kept = it.groups.filter((g) => !removedSet.has(`${it.mac}||${g.groupName}||${g.rawValue}`));
            if (kept.length === it.groups.length) return it;
            return { ...it, groups: kept, groupNames: kept.map((g) => g.groupName) };
          })
          .filter((it) => it.groups.length > 0 || it.source !== "Groupe NAC");
        if (auditState.stats) {
          auditState.stats.neverSeenCount = auditState.items.filter(
            (x) => x.status === "NEVER_SEEN" || x.status === "NEVER_SEEN_ES"
          ).length;
          auditState.stats.duplicateCount = auditState.items.filter(
            (x) => x.groupNames.length >= 2
          ).length;
          XIQApi.saveAuditSummary({ ...auditState.stats, lastRunAt: auditState.lastRunAt }).catch(() => {});
        }
      }
      auditState.selectedKeys.clear();
      XIQApi.toast(`Nettoyage terminé : ${okCount} retirée(s), ${errCount} erreur(s).`, errCount ? "warn" : "success");
      drawMacAudit(viewport);
    };

    viewport.querySelectorAll("[data-rm-single]").forEach((b) => {
      b.addEventListener("click", () => removeEntries([b.dataset.rmSingle]));
    });

    const bulkBtn = viewport.querySelector("#btn-audit-bulk-remove");
    if (bulkBtn) {
      bulkBtn.addEventListener("click", () => removeEntries(Array.from(auditState.selectedKeys)));
    }
  }

  async function renderMacAudit(viewport) {
    viewport.classList.remove("studio-mode");
    const pid = getActiveProfileId();
    if (auditState.profileId !== pid) {
      auditState.items = [];
      auditState.stats = null;
      auditState.lastRunAt = null;
      auditState.selectedKeys.clear();
      auditState.profileId = pid;
    }
    if (!auditState.stats && !auditState.running) {
      await runMacNeverSeenAudit(viewport);
    } else {
      drawMacAudit(viewport);
    }
  }

  // =========================================================================
  // 3C. SUGGESTIONS DE NETTOYAGE NAC (Doublons, Conflits Sécurité, Inactives > 1 an)
  // =========================================================================
  const sugState = {
    tab: "duplicates", // duplicates | conflicts | inactive365
    showManual: false,
    search: "",
    groupFilter: "",
    autoBackupCsv: true,
    keepOverrides: {}, // mac -> chosen groupName
    selectedMacs: new Set(),
  };

  function isSecurityBlockGroup(groupName) {
    return /(blacklist|quarant|block|deny|isolat|rogue|ban|remediat)/i.test(String(groupName || ""));
  }

  function analyzeSecurityConflicts(items) {
    const conflicts = [];
    for (const it of items) {
      if (!it || !Array.isArray(it.groups) || !it.groups.length) continue;
      const secGroups = it.groups.filter((g) => isSecurityBlockGroup(g.groupName));
      const authGroups = it.groups.filter((g) => !isSecurityBlockGroup(g.groupName));
      const esBlocked = /(quarant|reject|block|deny)/i.test(String(it.esState || ""));

      if (authGroups.length && (secGroups.length || esBlocked)) {
        conflicts.push({
          item: it,
          secGroups,
          authGroups,
          reason: secGroups.length
            ? `Présente dans ${secGroups.map((g) => g.groupName).join(", ")} ET dans ${authGroups.length} groupe(s) autorisé(s)`
            : `État NAC « ${it.esState} » mais toujours présente dans ${authGroups.length} groupe(s) autorisé(s)`,
          groupsToRemove: authGroups,
          chosenKeep: secGroups.length ? secGroups.map((g) => g.groupName).join(", ") : `État ${it.esState}`,
        });
      }
    }
    return conflicts;
  }

  function analyzeInactiveOverYear(items) {
    return items
      .filter((it) => it && Array.isArray(it.groups) && it.groups.length > 0 && it.daysInactive !== null && it.daysInactive >= 365)
      .sort((a, b) => (b.daysInactive || 0) - (a.daysInactive || 0))
      .map((it) => ({
        item: it,
        days: it.daysInactive,
        months: Math.floor(it.daysInactive / 30),
        groupsToRemove: it.groups,
      }));
  }

  function normalizeTokenStr(s) {
    return String(s || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  function analyzeDuplicateSuggestion(it) {
    if (!it || !Array.isArray(it.groups) || it.groups.length < 2) return null;
    const signals = it.nacSignals || {};
    const signalOrder = [
      ["endSystemGroup", "Groupe NAC actif"],
      ["ruleName", "Règle NAC"],
      ["reason", "Raison d'auth"],
      ["profile", "Profil NAC"],
      ["policy", "Policy"],
      ["category", "Catégorie"],
      ["zone", "Zone"],
    ];

    const nonEmptySignals = signalOrder
      .map(([k, lbl]) => ({ key: k, label: lbl, val: String(signals[k] || "").trim() }))
      .filter((x) => x.val);

    let identifiedGroup = null;
    let confidence = "manual"; // high | medium | manual
    let evidence = "";

    // 1) Exact match (case-insensitive) against one of the MAC's groups
    for (const sig of nonEmptySignals) {
      const sigLow = sig.val.toLowerCase();
      const exact = it.groups.filter((g) => g.groupName.toLowerCase() === sigLow);
      if (exact.length === 1) {
        identifiedGroup = exact[0].groupName;
        confidence = "high";
        evidence = `${sig.label} : ${sig.val}`;
        break;
      }
    }

    // 2) Inclusion match (e.g. reason/profile/policy contains exact groupName, or groupName contains profile/policy)
    if (!identifiedGroup) {
      for (const sig of nonEmptySignals) {
        const sigNorm = normalizeTokenStr(sig.val);
        if (!sigNorm || sigNorm.length < 3) continue;
        const hits = it.groups.filter((g) => {
          const gNorm = normalizeTokenStr(g.groupName);
          if (!gNorm || gNorm.length < 3) return false;
          return sigNorm.includes(gNorm) || gNorm.includes(sigNorm);
        });
        if (hits.length === 1) {
          identifiedGroup = hits[0].groupName;
          confidence = "medium";
          evidence = `${sig.label} : ${sig.val}`;
          break;
        }
      }
    }

    // 3) Distinctive token overlap (e.g. "VoIP-Phone" vs "VoIP-Phones", "APP_BIOMED_VLAN" vs "APP_BIOMED")
    if (!identifiedGroup) {
      for (const sig of nonEmptySignals) {
        const sigTokens = normalizeTokenStr(sig.val).split(" ").filter((t) => t.length >= 3);
        if (!sigTokens.length) continue;
        const scored = it.groups.map((g) => {
          const gTokens = normalizeTokenStr(g.groupName).split(" ").filter((t) => t.length >= 3);
          const overlap = sigTokens.filter((st) =>
            gTokens.some((gt) => gt === st || gt.startsWith(st) || st.startsWith(gt))
          ).length;
          return { groupName: g.groupName, score: overlap };
        });
        scored.sort((a, b) => b.score - a.score);
        if (scored[0].score > 0 && (scored.length < 2 || scored[0].score > scored[1].score)) {
          identifiedGroup = scored[0].groupName;
          confidence = "medium";
          evidence = `${sig.label} : ${sig.val}`;
          break;
        }
      }
    }

    const chosenKeep =
      sugState.keepOverrides[it.mac] && it.groupNames.includes(sugState.keepOverrides[it.mac])
        ? sugState.keepOverrides[it.mac]
        : identifiedGroup || it.groups[0].groupName;

    const groupsToRemove = it.groups.filter((g) => g.groupName !== chosenKeep);

    return {
      item: it,
      identifiedGroup,
      chosenKeep,
      groupsToRemove,
      confidence,
      evidence:
        evidence ||
        (nonEmptySignals.length
          ? nonEmptySignals.slice(0, 2).map((s) => `${s.label} : ${s.val}`).join(" · ")
          : it.status === "NEVER_SEEN" || it.status === "NEVER_SEEN_ES"
          ? "Jamais vue sur le réseau"
          : "Aucun attribut NAC discriminant remonté"),
    };
  }

  function drawSuggestions(viewport) {
    const indexed = SchemaTools.getCachedSchemaInfo().indexed;
    const nacMuts = indexed ? SchemaTools.listDomainMutations(indexed, ["accessControl"]) : [];
    const canRemove = nacMuts.some((m) => m.field.name === "removeEntryFromGroup");

    // 1. Doublons identifiés
    const allDuplicates = auditState.items
      .filter((it) => it.groups && it.groups.length >= 2)
      .map(analyzeDuplicateSuggestion)
      .filter(Boolean);
    const autoIdentified = allDuplicates.filter((s) => s.confidence === "high" || s.confidence === "medium");
    const manualOnly = allDuplicates.filter((s) => s.confidence === "manual");

    // 2. Conflits Sécurité (Blacklist / Quarantine + Groupe autorisé)
    const securityConflicts = analyzeSecurityConflicts(auditState.items);

    // 3. MAC Inactives > 1 an (> 365 jours)
    const inactiveOverYear = analyzeInactiveOverYear(auditState.items);

    const q = sugState.search.trim().toLowerCase();

    const visibleDuplicates = (sugState.showManual ? allDuplicates : autoIdentified).filter((s) => {
      if (!q) return true;
      return (
        s.item.mac.toLowerCase().includes(q) ||
        s.chosenKeep.toLowerCase().includes(q) ||
        s.groupsToRemove.some((g) => g.groupName.toLowerCase().includes(q)) ||
        s.evidence.toLowerCase().includes(q) ||
        (s.item.hostName || "").toLowerCase().includes(q)
      );
    });

    const visibleConflicts = securityConflicts.filter((c) => {
      if (!q) return true;
      return (
        c.item.mac.toLowerCase().includes(q) ||
        c.reason.toLowerCase().includes(q) ||
        c.item.groupNames.some((g) => g.toLowerCase().includes(q)) ||
        (c.item.hostName || "").toLowerCase().includes(q)
      );
    });

    // Group options for Inactive > 1 year filter
    const inactGroupCounts = {};
    inactiveOverYear.forEach((x) => {
      x.item.groupNames.forEach((gn) => {
        inactGroupCounts[gn] = (inactGroupCounts[gn] || 0) + 1;
      });
    });
    const inactGroupOpts = Object.entries(inactGroupCounts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

    const visibleInactive = inactiveOverYear.filter((x) => {
      if (sugState.groupFilter && !x.item.groupNames.includes(sugState.groupFilter)) return false;
      if (!q) return true;
      return (
        x.item.mac.toLowerCase().includes(q) ||
        x.item.groupNames.some((g) => g.toLowerCase().includes(q)) ||
        (x.item.descriptions || "").toLowerCase().includes(q) ||
        (x.item.hostName || "").toLowerCase().includes(q)
      );
    });

    const activeList =
      sugState.tab === "duplicates"
        ? visibleDuplicates
        : sugState.tab === "conflicts"
        ? visibleConflicts
        : visibleInactive;

    const totalRemovalsPlanned = activeList
      .filter((s) => sugState.selectedMacs.has(s.item.mac))
      .reduce((acc, s) => acc + s.groupsToRemove.length, 0);

    viewport.innerHTML = `
      <div class="alert-banner">
        <div>
          <strong>✦ Suggestions de nettoyage NAC :</strong> aucune suppression n'est effectuée sans votre validation explicite.
          ${auditState.lastRunAt ? `<span style="color:var(--text-muted);margin-left:6px;">Dernier scan : ${esc(auditState.lastRunAt)}</span>` : ""}
        </div>
        <div style="display:flex;gap:8px;align-items:center;">
          <label class="checkbox-row" style="font-size:12px;">
            <input type="checkbox" id="chk-sug-backup" ${sugState.autoBackupCsv ? "checked" : ""} />
            <span>Sauvegarde CSV auto avant suppression</span>
          </label>
          <button class="btn btn-xs btn-secondary" id="btn-sug-rescan">↻ Actualiser l'audit</button>
        </div>
      </div>

      ${auditState.running ? `
        <div class="panel"><div class="panel-body">
          <div style="display:flex;justify-content:space-between;margin-bottom:8px;font-size:13px;">
            <span id="audit-progress-text">${esc(auditState.progressText)}</span>
            <strong>${auditState.progressPct}%</strong>
          </div>
          <div class="bar-track" style="height:10px;"><div class="bar-fill" id="audit-progress-bar" style="width:${auditState.progressPct}%;"></div></div>
        </div></div>` : ""}

      <div class="kpi-grid">
        <div class="kpi-card" style="cursor:pointer;border-color:${sugState.tab === "duplicates" ? "var(--accent)" : autoIdentified.length ? "rgba(34,197,94,0.45)" : "var(--border)"};" data-stab="duplicates">
          <div class="kpi-label">Doublons Auto-identifiés</div>
          <div class="kpi-value" style="color:${autoIdentified.length ? "var(--green)" : "var(--text-secondary)"};">${autoIdentified.length}</div>
          <div class="kpi-sub">${allDuplicates.length} doublon(s) multi-groupes au total</div>
        </div>
        <div class="kpi-card" style="cursor:pointer;border-color:${sugState.tab === "conflicts" ? "var(--accent)" : securityConflicts.length ? "rgba(239,68,68,0.5)" : "var(--border)"};" data-stab="conflicts">
          <div class="kpi-label">Conflits Sécurité (Blacklist)</div>
          <div class="kpi-value" style="color:${securityConflicts.length ? "var(--red)" : "var(--green)"};">${securityConflicts.length}</div>
          <div class="kpi-sub">Blacklist/Quarantaine + groupe autorisé</div>
        </div>
        <div class="kpi-card" style="cursor:pointer;border-color:${sugState.tab === "inactive365" ? "var(--accent)" : inactiveOverYear.length ? "rgba(245,158,11,0.5)" : "var(--border)"};" data-stab="inactive365">
          <div class="kpi-label">MAC Inactives &gt; 1 an</div>
          <div class="kpi-value" style="color:${inactiveOverYear.length ? "var(--amber)" : "var(--green)"};">${inactiveOverYear.length}</div>
          <div class="kpi-sub">Dernière vue &gt; 365 jours (matériel réformé)</div>
        </div>
      </div>

      <div class="tabs">
        <button class="tab-btn ${sugState.tab === "duplicates" ? "active" : ""}" data-stab="duplicates">Doublons Identifiés (${autoIdentified.length})</button>
        <button class="tab-btn ${sugState.tab === "conflicts" ? "active" : ""}" data-stab="conflicts">Conflits Sécurité (${securityConflicts.length})</button>
        <button class="tab-btn ${sugState.tab === "inactive365" ? "active" : ""}" data-stab="inactive365">Inactives &gt; 1 an (${inactiveOverYear.length})</button>
      </div>

      <div class="toolbar">
        <div class="toolbar-group">
          <input id="sug-search" placeholder="Filtrer MAC, groupe, profil, hostname..." value="${esc(sugState.search)}" style="width:265px;" />
          ${sugState.tab === "duplicates" ? `
            <label class="checkbox-row">
              <input type="checkbox" id="chk-sug-manual" ${sugState.showManual ? "checked" : ""} />
              <span>Inclure les doublons à arbitrer manuellement (${manualOnly.length})</span>
            </label>` : ""}
          ${sugState.tab === "inactive365" ? `
            <select id="sug-grp-filter" style="max-width:290px;">
              <option value="">Tous les groupes (${inactGroupOpts.length})</option>
              ${inactGroupOpts.map(([gn, cnt]) => `<option value="${esc(gn)}" ${sugState.groupFilter === gn ? "selected" : ""}>${esc(gn)} (${cnt})</option>`).join("")}
            </select>` : ""}
        </div>
        <div class="toolbar-group">
          ${canRemove && sugState.selectedMacs.size ? `<button class="btn btn-sm ${sugState.tab === "inactive365" ? "btn-danger" : "btn-success"}" id="btn-sug-apply-bulk">${sugState.tab === "inactive365" ? "✕ Purger" : "✓ Valider"} la sélection (${sugState.selectedMacs.size} MAC · ${totalRemovalsPlanned} suppr.)</button>` : ""}
          <button class="btn btn-sm btn-secondary" id="btn-sug-csv">Exporter CSV (${activeList.length})</button>
        </div>
      </div>

      ${sugState.tab === "duplicates" ? `
        <div class="panel">
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  ${canRemove ? `<th style="width:32px;"><input type="checkbox" id="sug-select-all" title="Tout sélectionner" /></th>` : ""}
                  <th>Adresse MAC</th>
                  <th>Identification NAC (Preuve)</th>
                  <th>✓ Groupe conservé</th>
                  <th>✕ Groupe(s) à supprimer</th>
                  ${canRemove ? `<th>Validation</th>` : ""}
                </tr>
              </thead>
              <tbody>
                ${visibleDuplicates.length ? visibleDuplicates.map((s) => {
                  const it = s.item;
                  const confBadge =
                    s.confidence === "high"
                      ? `<span class="badge badge-green">Confiance Haute</span>`
                      : s.confidence === "medium"
                      ? `<span class="badge badge-cyan">Confiance Moyenne</span>`
                      : `<span class="badge badge-amber">Choix Manuel</span>`;
                  const checked = sugState.selectedMacs.has(it.mac);
                  return `<tr>
                    ${canRemove ? `<td><input type="checkbox" class="sug-chk" data-mac="${esc(it.mac)}" ${checked ? "checked" : ""} /></td>` : ""}
                    <td class="mono">
                      <strong>${XIQApi.macLink(it.mac)}</strong>
                      ${it.hostName || it.ipAddress ? `<div style="font-size:11px;color:var(--text-muted);">${esc([it.hostName, it.ipAddress].filter(Boolean).join(" · "))}</div>` : ""}
                    </td>
                    <td>
                      <div style="margin-bottom:3px;">${confBadge}</div>
                      <div style="font-size:12px;color:var(--text-secondary);">${esc(s.evidence)}</div>
                    </td>
                    <td>
                      <select class="select-compact sug-keep-sel" data-mac="${esc(it.mac)}" style="border-color:rgba(34,197,94,0.5);">
                        ${it.groupNames.map((gn) => `<option value="${esc(gn)}" ${gn === s.chosenKeep ? "selected" : ""}>✓ ${esc(gn)}</option>`).join("")}
                      </select>
                    </td>
                    <td>
                      ${s.groupsToRemove.map((g) => `<span class="badge badge-red" style="margin:2px;">✕ ${esc(g.groupName)}</span>`).join(" ")}
                    </td>
                    ${canRemove ? `<td style="white-space:nowrap;">
                      <button class="btn btn-xs btn-success" data-sug-apply="${esc(it.mac)}">✓ Valider</button>
                    </td>` : ""}
                  </tr>`;
                }).join("") : `<tr><td colspan="${canRemove ? 6 : 4}" class="empty-state">${
                  allDuplicates.length
                    ? "Aucune suggestion auto-identifiée trouvée. Cochez « Inclure les doublons à arbitrer manuellement » ci-dessus pour traiter vos " + allDuplicates.length + " doublon(s)."
                    : "Aucun doublon MAC multi-groupes détecté sur votre serveur !"
                }</td></tr>`}
              </tbody>
            </table>
          </div>
        </div>
      ` : sugState.tab === "conflicts" ? `
        <div class="panel">
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  ${canRemove ? `<th style="width:32px;"><input type="checkbox" id="sug-select-all" title="Tout sélectionner" /></th>` : ""}
                  <th>Adresse MAC</th>
                  <th>Conflit Sécurité détecté</th>
                  <th>Groupe / État Blocage conservé</th>
                  <th>✕ Groupe(s) autorisé(s) à retirer</th>
                  ${canRemove ? `<th>Action</th>` : ""}
                </tr>
              </thead>
              <tbody>
                ${visibleConflicts.length ? visibleConflicts.map((c) => {
                  const it = c.item;
                  const checked = sugState.selectedMacs.has(it.mac);
                  return `<tr>
                    ${canRemove ? `<td><input type="checkbox" class="sug-chk" data-mac="${esc(it.mac)}" ${checked ? "checked" : ""} /></td>` : ""}
                    <td class="mono">
                      <strong>${XIQApi.macLink(it.mac)}</strong>
                      ${it.hostName || it.ipAddress ? `<div style="font-size:11px;color:var(--text-muted);">${esc([it.hostName, it.ipAddress].filter(Boolean).join(" · "))}</div>` : ""}
                    </td>
                    <td style="font-size:12px;">${esc(c.reason)}</td>
                    <td>${c.secGroups.length ? c.secGroups.map((g) => `<span class="badge badge-red" style="margin:2px;">⊘ ${esc(g.groupName)}</span>`).join(" ") : `<span class="badge badge-red">${esc(it.esState)}</span>`}</td>
                    <td>${c.authGroups.map((g) => `<span class="badge badge-amber" style="margin:2px;">✕ ${esc(g.groupName)}</span>`).join(" ")}</td>
                    ${canRemove ? `<td style="white-space:nowrap;">
                      <button class="btn btn-xs btn-danger" data-sug-apply="${esc(it.mac)}">✓ Nettoyer</button>
                    </td>` : ""}
                  </tr>`;
                }).join("") : `<tr><td colspan="${canRemove ? 6 : 4}" class="empty-state">Aucun conflit Blacklist / Quarantaine + groupe autorisé détecté.</td></tr>`}
              </tbody>
            </table>
          </div>
        </div>
      ` : `
        <div class="panel">
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  ${canRemove ? `<th style="width:32px;"><input type="checkbox" id="sug-select-all" title="Tout sélectionner" /></th>` : ""}
                  <th>Adresse MAC</th>
                  <th>Dernière Activité</th>
                  <th>Inactivité</th>
                  <th>✕ Groupe(s) NAC à purger</th>
                  <th>Description</th>
                  <th>Dernier Switch / Port</th>
                  ${canRemove ? `<th>Action</th>` : ""}
                </tr>
              </thead>
              <tbody>
                ${visibleInactive.length ? visibleInactive.slice(0, 500).map((x) => {
                  const it = x.item;
                  const checked = sugState.selectedMacs.has(it.mac);
                  return `<tr>
                    ${canRemove ? `<td><input type="checkbox" class="sug-chk" data-mac="${esc(it.mac)}" ${checked ? "checked" : ""} /></td>` : ""}
                    <td class="mono">
                      <strong>${XIQApi.macLink(it.mac)}</strong>
                      ${it.hostName || it.ipAddress ? `<div style="font-size:11px;color:var(--text-muted);">${esc([it.hostName, it.ipAddress].filter(Boolean).join(" · "))}</div>` : ""}
                    </td>
                    <td class="mono">${esc((it.lastSeenTime || "").slice(0, 19).replace("T", " "))}</td>
                    <td><span class="badge badge-amber">${x.days} jours (~${x.months} mois)</span></td>
                    <td>${it.groups.map((g) => `<span class="badge badge-red" style="margin:2px;">✕ ${esc(g.groupName)}</span>`).join(" ")}</td>
                    <td style="font-size:12px;color:var(--text-secondary);">${esc(it.descriptions || "—")}</td>
                    <td class="mono">${it.switchIp ? `${it.switchName && it.switchName !== it.switchIp ? `<div><strong>${esc(it.switchName)}</strong></div>` : ""}${XIQApi.switchIpLink(it.switchIp)} <span style="color:var(--cyan);margin-left:4px;">${esc(it.switchPort)}</span>` : "—"}</td>
                    ${canRemove ? `<td style="white-space:nowrap;">
                      <button class="btn btn-xs btn-danger" data-sug-apply="${esc(it.mac)}">✕ Purger</button>
                    </td>` : ""}
                  </tr>`;
                }).join("") : `<tr><td colspan="${canRemove ? 8 : 6}" class="empty-state">Aucune adresse MAC inactive depuis plus de 365 jours dans vos groupes NAC.</td></tr>`}
              </tbody>
            </table>
          </div>
          ${visibleInactive.length > 500 ? `<div style="padding:8px 14px;font-size:12px;color:var(--text-muted);border-top:1px solid var(--border);">Affichage limité aux 500 premières lignes. Utilisez « Exporter CSV » pour la liste complète (${visibleInactive.length}).</div>` : ""}
        </div>
      `}
    `;

    // Bind events
    viewport.querySelectorAll("[data-stab]").forEach((el) => {
      el.addEventListener("click", () => {
        sugState.tab = el.dataset.stab;
        sugState.selectedMacs.clear();
        drawSuggestions(viewport);
      });
    });

    viewport.querySelector("#chk-sug-backup").addEventListener("change", (e) => {
      sugState.autoBackupCsv = e.target.checked;
    });

    viewport.querySelector("#btn-sug-rescan").addEventListener("click", async () => {
      await runMacNeverSeenAudit(viewport);
      drawSuggestions(viewport);
    });

    const srch = viewport.querySelector("#sug-search");
    srch.addEventListener("input", (e) => {
      sugState.search = e.target.value;
      const pos = e.target.selectionStart;
      drawSuggestions(viewport);
      const el = viewport.querySelector("#sug-search");
      el.focus(); el.setSelectionRange(pos, pos);
    });

    const chkMan = viewport.querySelector("#chk-sug-manual");
    if (chkMan) {
      chkMan.addEventListener("change", (e) => {
        sugState.showManual = e.target.checked;
        sugState.selectedMacs.clear();
        drawSuggestions(viewport);
      });
    }

    const grpFlt = viewport.querySelector("#sug-grp-filter");
    if (grpFlt) {
      grpFlt.addEventListener("change", (e) => {
        sugState.groupFilter = e.target.value;
        sugState.selectedMacs.clear();
        drawSuggestions(viewport);
      });
    }

    viewport.querySelectorAll(".sug-keep-sel").forEach((sel) => {
      sel.addEventListener("change", () => {
        sugState.keepOverrides[sel.dataset.mac] = sel.value;
        drawSuggestions(viewport);
      });
    });

    const selAll = viewport.querySelector("#sug-select-all");
    if (selAll) {
      selAll.addEventListener("change", (e) => {
        activeList.slice(0, 500).forEach((s) => {
          if (e.target.checked) sugState.selectedMacs.add(s.item.mac);
          else sugState.selectedMacs.delete(s.item.mac);
        });
        drawSuggestions(viewport);
      });
    }

    viewport.querySelectorAll(".sug-chk").forEach((chk) => {
      chk.addEventListener("change", () => {
        if (chk.checked) sugState.selectedMacs.add(chk.dataset.mac);
        else sugState.selectedMacs.delete(chk.dataset.mac);
        drawSuggestions(viewport);
      });
    });

    const buildExportRows = (list) => {
      if (sugState.tab === "duplicates") {
        return list.map((s) => ({
          Type: "Doublon",
          MAC: s.item.mac,
          HostName: s.item.hostName || "",
          IP: s.item.ipAddress || "",
          Confiance: s.confidence,
          Preuve_NAC: s.evidence,
          Groupe_Conserve: s.chosenKeep,
          Groupes_A_Supprimer: s.groupsToRemove.map((g) => g.groupName).join(" | "),
        }));
      }
      if (sugState.tab === "conflicts") {
        return list.map((c) => ({
          Type: "Conflit_Securite",
          MAC: c.item.mac,
          HostName: c.item.hostName || "",
          IP: c.item.ipAddress || "",
          Conflit: c.reason,
          Blocage_Conserve: c.chosenKeep,
          Groupes_Autorises_A_Retirer: c.groupsToRemove.map((g) => g.groupName).join(" | "),
        }));
      }
      return list.map((x) => ({
        Type: "Inactive_Plus_1_An",
        MAC: x.item.mac,
        HostName: x.item.hostName || "",
        IP: x.item.ipAddress || "",
        Derniere_Activite: x.item.lastSeenTime || "",
        Jours_Inactif: x.days,
        Groupes_NAC: x.groupsToRemove.map((g) => g.groupName).join(" | "),
        Description: x.item.descriptions || "",
        Switch: x.item.switchName || x.item.switchIp || "",
        Port: x.item.switchPort || "",
      }));
    };

    viewport.querySelector("#btn-sug-csv").addEventListener("click", () => {
      XIQApi.exportFile(`xiqse-suggestions-${sugState.tab}-${Date.now()}.csv`, XIQApi.rowsToCsv(buildExportRows(activeList)));
    });

    const applySuggestionsList = async (sugList) => {
      if (!sugList.length) return;
      const totalOps = sugList.reduce((acc, s) => acc + s.groupsToRemove.length, 0);
      const summaryLines = sugList
        .slice(0, 6)
        .map((s) =>
          s.chosenKeep
            ? `• ${s.item.mac} : garder [${s.chosenKeep}], retirer [${s.groupsToRemove.map((g) => g.groupName).join(", ")}]`
            : `• ${s.item.mac} (inactive ${s.days} j) : retirer de [${s.groupsToRemove.map((g) => g.groupName).join(", ")}]`
        )
        .join("\n");
      const more = sugList.length > 6 ? `\n... et ${sugList.length - 6} autre(s) MAC.` : "";
      const backupNote = sugState.autoBackupCsv ? "\n\n(Une sauvegarde CSV sera enregistrée dans Téléchargements avant suppression.)" : "";
      if (!confirm(`Valider le nettoyage de ${sugList.length} MAC (${totalOps} retrait(s) de groupes) sur XIQ-SE ?\n\n${summaryLines}${more}${backupNote}`)) {
        return;
      }

      if (sugState.autoBackupCsv) {
        await XIQApi.exportFile(
          `xiqse-backup-avant-nettoyage-${sugState.tab}-${Date.now()}.csv`,
          XIQApi.rowsToCsv(buildExportRows(sugList))
        );
      }

      let okCount = 0;
      let errCount = 0;
      const removedPairs = new Set();

      for (const s of sugList) {
        for (const g of s.groupsToRemove) {
          const mut = buildAdaptiveGroupMutation(indexed, "removeEntryFromGroup", {
            groupName: g.groupName,
            value: g.rawValue,
          });
          const r = await runOp(mut.query, mut.variables, "mac_audit");
          if (r.ok) {
            okCount++;
            removedPairs.add(`${s.item.mac}||${g.groupName}||${g.rawValue}`);
          } else {
            errCount++;
          }
        }
        sugState.selectedMacs.delete(s.item.mac);
      }

      if (removedPairs.size) {
        auditState.items = auditState.items
          .map((it) => {
            const kept = it.groups.filter((g) => !removedPairs.has(`${it.mac}||${g.groupName}||${g.rawValue}`));
            if (kept.length === it.groups.length) return it;
            return { ...it, groups: kept, groupNames: kept.map((g) => g.groupName) };
          })
          .filter((it) => it.groups.length > 0 || it.source !== "Groupe NAC");
        if (auditState.stats) {
          auditState.stats.neverSeenCount = auditState.items.filter(
            (x) => x.status === "NEVER_SEEN" || x.status === "NEVER_SEEN_ES"
          ).length;
          auditState.stats.duplicateCount = auditState.items.filter((x) => x.groupNames.length >= 2).length;
          auditState.stats.conflictsCount = analyzeSecurityConflicts(auditState.items).length;
          auditState.stats.inactive365Count = auditState.items.filter(
            (x) => x.groups.length > 0 && x.daysInactive !== null && x.daysInactive >= 365
          ).length;
          XIQApi.saveAuditSummary({ ...auditState.stats, lastRunAt: auditState.lastRunAt }).catch(() => {});
        }
      }

      XIQApi.toast(`Nettoyage appliqué : ${okCount} retrait(s) effectué(s), ${errCount} erreur(s).`, errCount ? "warn" : "success");
      drawSuggestions(viewport);
    };

    viewport.querySelectorAll("[data-sug-apply]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const s = activeList.find((x) => x.item.mac === btn.dataset.sugApply);
        if (s) applySuggestionsList([s]);
      });
    });

    const bulkBtn = viewport.querySelector("#btn-sug-apply-bulk");
    if (bulkBtn) {
      bulkBtn.addEventListener("click", () => {
        const list = activeList.filter((s) => sugState.selectedMacs.has(s.item.mac));
        applySuggestionsList(list);
      });
    }
  }

  async function renderSuggestions(viewport) {
    viewport.classList.remove("studio-mode");
    const pid = getActiveProfileId();
    if (auditState.profileId !== pid) {
      auditState.items = [];
      auditState.stats = null;
      auditState.lastRunAt = null;
      auditState.selectedKeys.clear();
      auditState.profileId = pid;
      sugState.selectedMacs.clear();
      sugState.keepOverrides = {};
    }
    if (!auditState.stats && !auditState.running) {
      await runMacNeverSeenAudit(viewport);
    }
    drawSuggestions(viewport);
  }

  // =========================================================================
  // 4. WORKFLOWS & AUTOMATION (Schema-Adaptive)
  // =========================================================================
  async function renderWorkflows(viewport) {
    viewport.classList.remove("studio-mode");
    viewport.innerHTML = `<div class="loading-state">Découverte des Workflows sur votre serveur XIQ-SE...</div>`;

    const indexed = await getSchema();
    const wfQueries = SchemaTools.listCallableDomainQueries(indexed, ["workflows"]);
    const callable = wfQueries.filter((q) => q.callableWithoutRequiredArgs);

    // Execute every callable query under workflows (e.g. workflows, allWorkflows, systemWorkflows, executions...)
    const results = await Promise.all(
      callable.slice(0, 6).map(async (q) => {
        const res = await runAdaptive(
          indexed,
          ["workflows"],
          [q.field.name],
          {
            nestedSpecs: [
              { candidates: ["variables", "inputs"], preferred: ["name", "type", "defaultValue", "required"], includeAllScalars: true },
            ],
            includeAllScalars: true,
          },
          "workflows"
        );
        return { fieldName: q.field.name, description: q.field.description, ...res };
      })
    );

    const wfRes = results.find((r) => Array.isArray(r.data) && !/exec/i.test(r.fieldName));
    const execRes = results.find((r) => Array.isArray(r.data) && /exec/i.test(r.fieldName));
    const wfs = wfRes?.data || [];
    const execs = execRes?.data || [];

    const wfMuts = SchemaTools.listDomainMutations(indexed, ["workflows"]);
    const hasStartWf = wfMuts.some((m) => m.field.name === "startWorkflow");

    viewport.innerHTML = `
      ${renderErrorBanner(results.flatMap((r) => r.errors || []), wfRes?.query || results[0]?.query || "")}
      <div class="toolbar">
        <strong>Workflows XIQ-SE (${wfs.length})</strong>
        <div class="toolbar-group">
          ${hasStartWf ? `<button class="btn btn-sm btn-primary" id="btn-run-wf-manual">⚡ Lancer un Workflow par ID</button>` : ""}
          ${wfRes?.query ? `<button class="btn btn-sm btn-ghost" data-open-studio="1">&lt;/&gt; GraphQL</button>` : ""}
        </div>
      </div>

      ${wfs.length ? `
        <div class="grid-3">
          ${wfs.slice(0, 48).map((w) => {
            const wid = w.id ?? w.workflowId ?? "";
            const wname = w.name || w.workflowName || `Workflow ${wid}`;
            const wcat = w.category || w.group || (w.isSystem ? "Système" : "Utilisateur");
            return `
            <div class="panel" style="margin-bottom:0;display:flex;flex-direction:column;">
              <div class="panel-header">
                <div class="panel-title" style="font-size:13.5px;">${esc(wname)}</div>
                <span class="badge ${w.isSystem ? "badge-cyan" : "badge-purple"}">${esc(wcat)}</span>
              </div>
              <div class="panel-body" style="flex:1;display:flex;flex-direction:column;justify-content:space-between;gap:10px;">
                <div>
                  <p style="font-size:12.5px;color:var(--text-secondary);margin-bottom:6px;">${esc(w.description || "")}</p>
                  <div style="font-size:11px;color:var(--text-muted);">ID : <span class="mono">${esc(wid)}</span></div>
                </div>
                ${hasStartWf ? `<button class="btn btn-sm btn-primary btn-full" data-run-wf="${esc(wid)}">▶ Exécuter ce Workflow</button>` : ""}
              </div>
            </div>`;
          }).join("")}
        </div>
      ` : results.length ? results.map((r) => `
        <div class="panel">
          <div class="panel-header"><div class="panel-title">workflows.${esc(r.fieldName)}</div></div>
          ${Array.isArray(r.data) ? renderDynamicTable(r.data) : `<div class="panel-body">${renderKeyValueTable(r.data)}</div>`}
        </div>`).join("") : `<div class="panel"><div class="empty-state">Aucune requête sans paramètre obligatoire détectée dans <code>WorkflowQueries</code>. Utilisez les opérations détectées ci-dessous pour interroger ou démarrer un workflow.</div></div>`}

      ${execs.length ? `
        <div class="panel" style="margin-top:16px;">
          <div class="panel-header"><div class="panel-title">Historique des exécutions (${execs.length})</div></div>
          ${renderDynamicTable(execs)}
        </div>` : ""}

      ${renderDomainCatalogPanel(indexed, ["workflows"], "Toutes les opérations Workflows (WorkflowQueries / Mutations)")}
    `;

    bindOpenStudio(viewport, wfRes?.query || results[0]?.query || "");
    bindDomainCatalogButtons(viewport, indexed);

    const openLaunchModal = (wf) => {
      const wid = wf ? (wf.id ?? wf.workflowId ?? "") : "";
      const wname = wf ? (wf.name || wf.workflowName || wid) : "Workflow XIQ-SE";
      const vars = Array.isArray(wf?.variables) ? wf.variables : [];
      XIQApi.showModal({
        title: `Lancer : ${wname}`,
        bodyHtml: `
          <div class="form-grid">
            <div class="form-field full"><label>ID du Workflow *</label><input id="wf-id-inp" value="${esc(wid)}" /></div>
            ${vars.length
              ? vars.map((v) => `
                  <div class="form-field full">
                    <label>${esc(v.name)} <span class="badge badge-muted">${esc(v.type || "String")}</span></label>
                    <input data-wf-var="${esc(v.name)}" value="${esc(v.defaultValue || "")}" />
                  </div>`).join("")
              : `<div class="form-field full"><label>Variables (JSON)</label><textarea id="wf-vars-raw" rows="4" class="mono">[]</textarea></div>`}
          </div>`,
        footerHtml: `
          <button class="btn btn-ghost" onclick="XIQApi.closeModal()">Annuler</button>
          <button class="btn btn-primary" id="btn-wf-launch">⚡ Démarrer (startWorkflow)</button>`,
        onMount: () => {
          document.getElementById("btn-wf-launch").addEventListener("click", async () => {
            const targetId = document.getElementById("wf-id-inp").value.trim();
            if (!targetId) return XIQApi.toast("ID du workflow requis.", "warn");
            let variablesPayload = "[]";
            const varInputs = document.querySelectorAll("[data-wf-var]");
            if (varInputs.length) {
              variablesPayload = JSON.stringify(
                Array.from(varInputs).map((inp) => ({ name: inp.dataset.wfVar, value: inp.value }))
              );
            } else {
              variablesPayload = document.getElementById("wf-vars-raw").value.trim() || "[]";
            }
            const m = `mutation RunWf($id: String!, $variables: String) {
  workflows { startWorkflow(input: { id: $id, variables: $variables }) { statusmessage } }
}`;
            const r = await runOp(m, { id: targetId, variables: variablesPayload }, "workflows");
            XIQApi.closeModal();
            XIQApi.toast(r.data?.workflows?.startWorkflow?.statusmessage || r.errors?.[0]?.message || "Workflow lancé.", r.ok ? "success" : "error");
            renderWorkflows(viewport);
          });
        },
      });
    };

    const manualBtn = viewport.querySelector("#btn-run-wf-manual");
    if (manualBtn) manualBtn.addEventListener("click", () => openLaunchModal(null));
    viewport.querySelectorAll("[data-run-wf]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const wf = wfs.find((w) => String(w.id ?? w.workflowId) === btn.dataset.runWf);
        openLaunchModal(wf);
      });
    });
  }

  // =========================================================================
  // 5. POLICY & ROLES (Schema-Adaptive)
  // =========================================================================
  async function renderPolicy(viewport) {
    viewport.classList.remove("studio-mode");
    viewport.innerHTML = `<div class="loading-state">Chargement adaptatif d'Extreme Policy...</div>`;

    const indexed = await getSchema();
    const polQueries = SchemaTools.listCallableDomainQueries(indexed, ["policy"]);
    const callable = polQueries.filter((q) => q.callableWithoutRequiredArgs);

    const results = await Promise.all(
      callable.slice(0, 6).map(async (q) => {
        const res = await runAdaptive(
          indexed,
          ["policy"],
          [q.field.name],
          {
            nestedSpecs: [
              { candidates: ["roles", "rules", "services"], includeAllScalars: true },
            ],
            includeAllScalars: true,
          },
          "policy"
        );
        return { fieldName: q.field.name, ...res };
      })
    );

    const polMuts = SchemaTools.listDomainMutations(indexed, ["policy"]);
    const hasEnforce = polMuts.some((m) => m.field.name === "enforcePolicy");

    viewport.innerHTML = `
      ${renderErrorBanner(results.flatMap((r) => r.errors || []), results[0]?.query || "")}
      <div class="toolbar">
        <strong>Extreme Policy &amp; Rôles</strong>
        ${results[0]?.query ? `<button class="btn btn-sm btn-ghost" data-open-studio="1">&lt;/&gt; GraphQL</button>` : ""}
      </div>
      ${results.length ? results.map((r) => {
        const items = Array.isArray(r.data) ? r.data : null;
        if (items && items.length && Array.isArray(items[0]?.roles)) {
          return items.map((dom) => `
            <div class="panel">
              <div class="panel-header">
                <div>
                  <div class="panel-title">${esc(dom.name || dom.domainName)}</div>
                  <div style="font-size:12px;color:var(--text-secondary);">${esc(dom.description || "")}</div>
                </div>
                <div style="display:flex;gap:8px;align-items:center;">
                  ${dom.deviceCount !== undefined ? `<span class="badge badge-cyan">${dom.deviceCount} équipement(s)</span>` : ""}
                  ${hasEnforce ? `<button class="btn btn-sm btn-primary" data-enforce="${esc(dom.name)}">⚡ Enforce Policy</button>` : ""}
                </div>
              </div>
              ${renderDynamicTable(dom.roles)}
            </div>`).join("");
        }
        return `<div class="panel">
          <div class="panel-header"><div class="panel-title">policy.${esc(r.fieldName)}</div></div>
          ${items ? renderDynamicTable(items) : `<div class="panel-body">${renderKeyValueTable(r.data)}</div>`}
        </div>`;
      }).join("") : `<div class="panel"><div class="empty-state">Aucune requête sans paramètre obligatoire détectée dans le domaine <code>policy</code>. Sélectionnez une opération ci-dessous pour l'ouvrir dans Studio GraphQL.</div></div>`}

      ${renderDomainCatalogPanel(indexed, ["policy"], "Toutes les opérations Extreme Policy")}
    `;

    bindOpenStudio(viewport, results[0]?.query || "");
    bindDomainCatalogButtons(viewport, indexed);

    viewport.querySelectorAll("[data-enforce]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const domainName = btn.dataset.enforce;
        const m = `mutation EnforcePol($domainName: String!) { policy { enforcePolicy(input: { domainName: $domainName }) { status message } } }`;
        const r = await runOp(m, { domainName }, "policy");
        XIQApi.toast(r.data?.policy?.enforcePolicy?.message || r.errors?.[0]?.message || "Enforce lancé.", r.ok ? "success" : "error");
        renderPolicy(viewport);
      });
    });
  }

  // =========================================================================
  // 6. ALARMS & EVENTS (Full-Schema Auto-Discovery + Real-Time NBI Health Alerts)
  // =========================================================================
  const almState = { tab: "alarms", subTab: "down", sev: "ALL", days: 7, search: "", alarmSourceKey: "", eventSourceKey: "" };

  function buildAdaptiveAlarmMutation(indexed, mutOp, alarmId) {
    if (!mutOp) return null;
    const field = mutOp.field;
    const isRoot = mutOp.domainName === "(Racine)";
    const inputArg = (field.args || []).find((a) => a.name === "input");
    const retBase = SchemaTools.unwrapType(field.type);
    const retSel = (retBase && SchemaTools.buildSafeSelection(indexed, retBase.name, ["status", "message", "errorCode", "success"], [], false)) || "status message";

    if (inputArg) {
      const inputTypeName = SchemaTools.unwrapType(inputArg.type).name;
      const inputType = SchemaTools.getType(indexed, inputTypeName);
      const inFields = (inputType?.inputFields || []).map((f) => f.name);
      const payload = {};
      if (inFields.includes("id")) payload.id = alarmId;
      else if (inFields.includes("alarmId")) payload.alarmId = alarmId;
      else if (inFields.includes("ids")) payload.ids = [alarmId];
      else if (inFields.includes("alarmIds")) payload.alarmIds = [alarmId];
      else payload.id = alarmId;
      const gqlType = SchemaTools.formatTypeRef(inputArg.type);
      const body = `${field.name}(input: $input) { ${retSel} }`;
      return {
        query: isRoot
          ? `mutation ExecAlmMut($input: ${gqlType}) { ${body} }`
          : `mutation ExecAlmMut($input: ${gqlType}) { ${mutOp.domainName} { ${body} } }`,
        variables: { input: payload },
        domainName: isRoot ? null : mutOp.domainName,
        fieldName: field.name,
      };
    }

    const idArg = (field.args || []).find((a) => /^(id|alarmid)$/i.test(a.name)) || (field.args || [])[0];
    if (!idArg) return null;
    const gqlType = SchemaTools.formatTypeRef(idArg.type);
    const body = `${field.name}(${idArg.name}: $id) { ${retSel} }`;
    return {
      query: isRoot
        ? `mutation ExecAlmMut($id: ${gqlType}) { ${body} }`
        : `mutation ExecAlmMut($id: ${gqlType}) { ${mutOp.domainName} { ${body} } }`,
      variables: { id: alarmId },
      domainName: isRoot ? null : mutOp.domainName,
      fieldName: field.name,
    };
  }

  async function renderAlarms(viewport) {
    viewport.classList.remove("studio-mode");
    viewport.innerHTML = `<div class="loading-state">Chargement des Alarmes, Événements &amp; Alertes de santé XIQ-SE...</div>`;

    const indexed = await getSchema();
    const pid = window.XIQApp?.getActiveProfile?.()?.id || "default";
    const alarmOps = SchemaTools.findFieldsByTokens(indexed, ALARM_QUERY_TOKENS, "query");
    const eventOps = SchemaTools.findFieldsByTokens(indexed, EVENT_QUERY_TOKENS, "query");
    const allRelatedMuts = SchemaTools.findFieldsByTokens(indexed, [...ALARM_QUERY_TOKENS, ...EVENT_QUERY_TOKENS], "mutation");

    const [almRes, evtProbeRes, devStatusRes, nacAppRes, nacEsRes, auditSumRes] = await Promise.all([
      fetchDiscoveredAlarms(indexed, almState.days, "alarms", almState.alarmSourceKey),
      probeDiscoveredOps(
        indexed,
        eventOps,
        scoreEventOp,
        ["events", "recentEvents", "eventLogs", "auditEvents", "items", "results", "list", "data"],
        almState.days,
        "alarms",
        almState.eventSourceKey
      ),
      runAdaptivePaginated(
        indexed,
        ["network"],
        ["devices", "allDevices"],
        { preferredScalars: ["ip", "sysName", "deviceName", "status", "down", "lastStatus", "sitePath", "deviceDisplayFamily", "sysUpTime"], includeAllScalars: false },
        "alarms",
        "all"
      ),
      runAdaptive(
        indexed,
        ["accessControl"],
        ["appliances", "engines", "nacAppliances", "allAppliances"],
        { preferredScalars: ["displayName", "name", "hostName", "ipAddress", "ip", "status", "state", "version", "engineGroup", "activeEndSystems", "endSystemCount"], includeAllScalars: true },
        "alarms"
      ),
      runAdaptivePaginated(
        indexed,
        ["accessControl"],
        ["endSystems", "allEndSystemsAsProperties", "allEndSystems"],
        {
          wrapperCandidates: ["endSystem", "endSystems", "results", "items"],
          preferredScalars: [
            "macAddress", "ipAddress", "username", "userName", "hostName",
            "switchIp", "switchIP", "portName", "switchPortName", "switchPort", "port",
            "state", "authorizationState", "status", "authType", "profile", "policy", "vlan", "lastSeenTime",
          ],
          includeAllScalars: false,
        },
        "alarms",
        "1000"
      ),
      XIQApi.getAuditSummary(pid).catch(() => ({ summary: null })),
    ]);

    const evtChosen = evtProbeRes.chosen;
    const evtRes = evtChosen
      ? {
          available: true,
          items: evtChosen.items,
          query: evtChosen.query,
          sourceLabel: evtChosen.key,
          errors: evtChosen.errors || [],
          probes: evtProbeRes.probes,
          workingSources: evtProbeRes.workingSources,
        }
      : {
          available: false,
          items: [],
          query: evtProbeRes.probes[0]?.query || "",
          sourceLabel: "",
          errors: evtProbeRes.probes.flatMap((p) => p.errors || []),
          probes: evtProbeRes.probes,
          workingSources: evtProbeRes.workingSources,
        };

    const rawAlarms = almRes.items || [];
    const normAlarms = rawAlarms.map(normalizeAlarmRecord);
    const events = evtRes.items || [];
    const allDevices = Array.isArray(devStatusRes.data) ? devStatusRes.data : [];
    const allDevicesCount = allDevices.length;
    const downDevices = allDevices.filter((d) => !isDeviceUp(d));
    const appliances = Array.isArray(nacAppRes.data) ? nacAppRes.data : [];
    const alertAppliances = appliances.filter((a) => /down|err|fail|off|warn|degrad/i.test(String(a.status || a.state || "")));
    const sampledEndSystems = Array.isArray(nacEsRes.data) ? nacEsRes.data : [];
    const blockedEndSystems = sampledEndSystems.filter((e) =>
      /quarant|reject|block|deny|fail|black/i.test(String(e?.state || e?.authorizationState || e?.status || ""))
    );
    const auditSummary = auditSumRes?.summary || null;

    const ackMutOp = allRelatedMuts.find((m) => /acknowledge.*alarm|ack.*alarm/i.test(m.field.name)) || null;
    const clrMutOp = allRelatedMuts.find((m) => /clear.*alarm|close.*alarm|delete.*alarm/i.test(m.field.name)) || null;
    const hasAck = Boolean(ackMutOp);
    const hasClr = Boolean(clrMutOp);

    // Combine probe diagnostics (deduplicated by domain.field)
    const probeMap = new Map();
    [...(almRes.probes || []), ...(evtRes.probes || [])].forEach((p) => {
      if (!probeMap.has(p.key)) probeMap.set(p.key, p);
    });

    const allDiscoveredQueries = [...alarmOps, ...eventOps];
    const uniqueDiscovered = [];
    const seenKeys = new Set();
    allDiscoveredQueries.forEach((op) => {
      const k = `${op.domainName}.${op.field.name}`;
      if (!seenKeys.has(k)) {
        seenKeys.add(k);
        uniqueDiscovered.push(op);
      }
    });

    const drawAlm = () => {
      const q = almState.search.trim().toLowerCase();
      const filteredAlarms = normAlarms.filter((a) => {
        if (!matchesSeverityFilter(a.severity, almState.sev)) return false;
        if (!q) return true;
        return [a.id, a.severity, a.sourceName, a.sourceIp, a.message, a.timestamp]
          .some((v) => String(v || "").toLowerCase().includes(q));
      });
      const filteredEvents = events.filter((ev) => {
        if (!q) return true;
        return JSON.stringify(ev || "").toLowerCase().includes(q);
      });
      const filteredDown = downDevices.filter((d) => {
        if (!q) return true;
        return [d.ip, d.sysName, d.deviceName, d.sitePath, d.deviceDisplayFamily]
          .some((v) => String(v || "").toLowerCase().includes(q));
      });
      const filteredBlocked = blockedEndSystems.filter((e) => {
        if (!q) return true;
        return [e.macAddress, e.ipAddress, e.username, e.userName, e.hostName, e.switchIp, e.switchIP, e.profile, e.state]
          .some((v) => String(v || "").toLowerCase().includes(q));
      });
      const activeProbes = Array.from(probeMap.values());
      const healthTotalAlerts = downDevices.length + blockedEndSystems.length + alertAppliances.length;

      viewport.innerHTML = `
        ${renderErrorBanner([...(almRes.errors || []), ...(evtRes.errors || [])], almRes.query || evtRes.query)}

        ${almRes.available || evtRes.available ? `
          <div class="tabs">
            <button class="tab-btn ${almState.tab === "alarms" ? "active" : ""}" data-atab="alarms">Alarmes (${almRes.available ? rawAlarms.length : downDevices.length})</button>
            <button class="tab-btn ${almState.tab === "events" ? "active" : ""}" data-atab="events">Événements (${events.length})</button>
          </div>
        ` : `
          <div class="alert-banner" style="margin-bottom:14px;">
            <div>
              <strong>Info API GraphQL XIQ-SE :</strong> Le schéma NBI de votre serveur (${(indexed?.queryGroups || []).map((g) => `<code>${esc(g.domain)}</code>`).join(", ")}) n'expose pas la table <em>OneView Alarms / Events</em> (limitation native de l'API NBI sur cette version).
              Cette vue regroupe automatiquement <strong>toutes les alertes temps réel disponibles via l'API</strong> : équipements Down, terminaux NAC bloqués/quarantaine, santé des moteurs NAC et hygiène NAC.
            </div>
            <span class="badge badge-cyan" title="${esc(devStatusRes.paginationMode || "")}">${allDevicesCount.toLocaleString("fr-FR")} équip. analysés</span>
          </div>

          <div class="kpi-grid" style="margin-bottom:14px;">
            <div class="kpi-card" style="cursor:pointer;border-color:${downDevices.length ? "rgba(239,68,68,0.45)" : "rgba(34,197,94,0.35)"};" data-hsub="down">
              <div class="kpi-label">Équipements Down</div>
              <div class="kpi-value" style="color:${downDevices.length ? "var(--red)" : "var(--green)"};">${downDevices.length}</div>
              <div class="kpi-sub">sur ${allDevicesCount.toLocaleString("fr-FR")} équipements (${esc(devStatusRes.paginationMode || "NBI")})</div>
            </div>
            <div class="kpi-card" style="cursor:pointer;border-color:${blockedEndSystems.length ? "rgba(245,158,11,0.45)" : "rgba(34,197,94,0.35)"};" data-hsub="nac_blocked">
              <div class="kpi-label">NAC Quarantaine / Rejetés</div>
              <div class="kpi-value" style="color:${blockedEndSystems.length ? "var(--amber)" : "var(--green)"};">${blockedEndSystems.length}</div>
              <div class="kpi-sub">sur ${sampledEndSystems.length.toLocaleString("fr-FR")} End-Systems inspectés</div>
            </div>
            <div class="kpi-card" style="cursor:pointer;border-color:${alertAppliances.length ? "rgba(239,68,68,0.45)" : "rgba(34,197,94,0.35)"};" data-hsub="health">
              <div class="kpi-label">Moteurs NAC (Appliances)</div>
              <div class="kpi-value" style="color:${alertAppliances.length ? "var(--red)" : "var(--green)"};">${appliances.length - alertAppliances.length}/${appliances.length}</div>
              <div class="kpi-sub">${alertAppliances.length ? `${alertAppliances.length} moteur(s) en alerte` : "Tous les moteurs opérationnels"}</div>
            </div>
            <div class="kpi-card" style="cursor:pointer;" onclick="XIQApp.navigate('suggestions')">
              <div class="kpi-label">Hygiène NAC (Audit)</div>
              <div class="kpi-value" style="color:${auditSummary && (auditSummary.neverSeenCount || auditSummary.duplicateCount) ? "var(--amber)" : "var(--cyan)"};">${auditSummary ? ((auditSummary.neverSeenCount || 0) + (auditSummary.duplicateCount || 0)) : "—"}</div>
              <div class="kpi-sub">${auditSummary ? `${auditSummary.neverSeenCount || 0} jamais vues · ${auditSummary.duplicateCount || 0} doublons` : "Lancer un audit MAC →"}</div>
            </div>
          </div>

          <div class="tabs">
            <button class="tab-btn ${almState.subTab === "down" ? "active" : ""}" data-hsub="down">Équipements Down (${downDevices.length})</button>
            <button class="tab-btn ${almState.subTab === "nac_blocked" ? "active" : ""}" data-hsub="nac_blocked">NAC Quarantaine / Rejetés (${blockedEndSystems.length})</button>
            <button class="tab-btn ${almState.subTab === "health" ? "active" : ""}" data-hsub="health">Moteurs NAC &amp; Hygiène (${appliances.length})</button>
          </div>
        `}

        ${(almRes.available || evtRes.available) ? (almState.tab === "alarms" ? `
          <div class="toolbar">
            <div class="toolbar-group">
              ${["ALL", "Critical", "Error", "Warning", "Info"].map((s) => `
                <button class="btn btn-xs ${almState.sev === s ? "btn-primary" : "btn-ghost"}" data-sev="${s}">${s === "ALL" ? "Toutes" : s}</button>`).join("")}
              <input id="alm-search" placeholder="Filtrer IP, switch, message..." value="${esc(almState.search)}" style="width:210px;" />
              <select id="alm-days" class="select-compact" title="Fenêtre temporelle">
                <option value="1" ${almState.days === 1 ? "selected" : ""}>Dernières 24h</option>
                <option value="7" ${almState.days === 7 ? "selected" : ""}>7 derniers jours</option>
                <option value="30" ${almState.days === 30 ? "selected" : ""}>30 derniers jours</option>
              </select>
              ${(almRes.workingSources || []).length > 1 ? `
                <select id="alm-source-sel" class="select-compact" title="Source GraphQL des alarmes">
                  ${almRes.workingSources.map((s) => `<option value="${esc(s.key)}" ${s.key === almRes.sourceLabel ? "selected" : ""}>Source : ${esc(s.key)} (${s.count})</option>`).join("")}
                </select>` : ""}
            </div>
            <div class="toolbar-group">
              ${almRes.sourceLabel && (almRes.workingSources || []).length <= 1 ? `<span class="badge badge-cyan">Source : ${esc(almRes.sourceLabel)}</span>` : ""}
              ${filteredAlarms.length || downDevices.length ? `<button class="btn btn-sm btn-secondary" id="btn-export-alm-csv">Exporter CSV</button>` : ""}
              ${almRes.query ? `<button class="btn btn-sm btn-ghost" data-open-studio="1">&lt;/&gt; GraphQL</button>` : ""}
            </div>
          </div>

          <div class="panel">
            ${filteredAlarms.length ? `<div class="table-wrap"><table>
              <thead><tr><th>ID</th><th>Sévérité</th><th>Source</th><th>Message</th><th>Date</th>${hasAck || hasClr ? "<th>Actions</th>" : ""}</tr></thead>
              <tbody>
                ${filteredAlarms.slice(0, 500).map((a) => {
                  const sb = /crit|fatal|emerg|err|major|severe/i.test(a.severity) ? "badge-red" : /warn|minor/i.test(a.severity) ? "badge-amber" : "badge-cyan";
                  return `<tr>
                    <td class="mono">${esc(a.id || "—")}</td>
                    <td><span class="badge ${sb}">${esc(a.severity)}</span></td>
                    <td><strong>${esc(a.sourceName)}</strong> ${a.sourceIp ? `<div>${XIQApi.switchIpLink(a.sourceIp)}</div>` : ""}</td>
                    <td>${esc(a.message || "—")}</td>
                    <td class="mono">${esc(a.timestamp || "—")}</td>
                    ${hasAck || hasClr ? `<td style="white-space:nowrap;">
                      ${hasAck ? (!a.acknowledged && a.id ? `<button class="btn btn-xs btn-secondary" data-ack="${esc(a.id)}">Acquitter</button>` : `<span class="badge badge-muted">${a.acknowledged ? "Acq." : "—"}</span>`) : ""}
                      ${hasClr && a.id ? `<button class="btn btn-xs btn-danger" data-clr="${esc(a.id)}">Clôturer</button>` : ""}
                    </td>` : ""}
                  </tr>`;
                }).join("")}
              </tbody>
            </table></div>` : `<div class="empty-state">Aucune alarme active sur cette période (source interrogée : <code>${esc(almRes.sourceLabel)}</code>).</div>`}
          </div>
          ${downDevices.length ? `
            <div class="panel" style="margin-top:12px;">
              <div class="panel-header">
                <div class="panel-title">Équipements actuellement Down (${downDevices.length} / ${allDevicesCount})</div>
                <span class="badge badge-red">${downDevices.length} injoignable(s)</span>
              </div>
              ${renderDynamicTable(downDevices, "Aucun équipement Down.")}
            </div>` : ""}
        ` : `
          <div class="toolbar">
            <div class="toolbar-group">
              <input id="alm-search" placeholder="Filtrer les événements..." value="${esc(almState.search)}" style="width:240px;" />
              <select id="alm-days" class="select-compact" title="Fenêtre temporelle">
                <option value="1" ${almState.days === 1 ? "selected" : ""}>Dernières 24h</option>
                <option value="7" ${almState.days === 7 ? "selected" : ""}>7 derniers jours</option>
                <option value="30" ${almState.days === 30 ? "selected" : ""}>30 derniers jours</option>
              </select>
              ${(evtRes.workingSources || []).length > 1 ? `
                <select id="evt-source-sel" class="select-compact" title="Source GraphQL des événements">
                  ${evtRes.workingSources.map((s) => `<option value="${esc(s.key)}" ${s.key === evtRes.sourceLabel ? "selected" : ""}>Source : ${esc(s.key)} (${s.count})</option>`).join("")}
                </select>` : ""}
            </div>
            <div class="toolbar-group">
              ${evtRes.sourceLabel && (evtRes.workingSources || []).length <= 1 ? `<span class="badge badge-cyan">Source : ${esc(evtRes.sourceLabel)}</span>` : ""}
              ${filteredEvents.length ? `<button class="btn btn-sm btn-secondary" id="btn-export-evt-csv">Exporter CSV</button>` : ""}
              ${evtRes.query ? `<button class="btn btn-sm btn-ghost" data-open-studio="1">&lt;/&gt; GraphQL</button>` : ""}
            </div>
          </div>
          <div class="panel">
            ${renderDynamicTable(filteredEvents, evtRes.available ? `Aucun événement retourné sur cette période (source : ${evtRes.sourceLabel}).` : "Aucune requête d'événements appelable automatiquement n'a répondu sur ce schéma GraphQL NBI.")}
          </div>
        `) : (almState.subTab === "down" ? `
          <div class="toolbar">
            <div class="toolbar-group">
              <input id="alm-search" placeholder="Filtrer IP, switch, site, modèle..." value="${esc(almState.search)}" style="width:260px;" />
              <span style="font-size:12px;color:var(--text-muted);">${filteredDown.length} / ${downDevices.length} injoignable(s)</span>
            </div>
            <div class="toolbar-group">
              ${filteredDown.length ? `<button class="btn btn-sm btn-secondary" id="btn-export-alm-csv">Exporter CSV</button>` : ""}
              ${devStatusRes.query ? `<button class="btn btn-sm btn-ghost" data-open-studio="1">&lt;/&gt; GraphQL</button>` : ""}
            </div>
          </div>
          <div class="panel">
            <div class="panel-header">
              <div class="panel-title">Équipements actuellement Down (${filteredDown.length} sur ${allDevicesCount.toLocaleString("fr-FR")})</div>
              <span class="badge ${filteredDown.length ? "badge-red" : "badge-green"}">${filteredDown.length ? `${filteredDown.length} injoignable(s)` : "Tous les équipements sont Up"}</span>
            </div>
            ${filteredDown.length ? `<div class="table-wrap"><table>
              <thead><tr><th>Statut</th><th>Nom / IP</th><th>Modèle</th><th>Site</th><th>Uptime</th></tr></thead>
              <tbody>
                ${filteredDown.map((d) => `
                  <tr>
                    <td><span class="badge badge-red">● Down</span></td>
                    <td><strong>${esc(d.sysName || d.deviceName || d.ip || "—")}</strong><div>${XIQApi.switchIpLink(d.ip || "")}</div></td>
                    <td>${esc(d.deviceDisplayFamily || d.family || "—")}</td>
                    <td><span class="badge badge-muted">${esc(d.sitePath || "—")}</span></td>
                    <td class="mono">${esc(d.sysUpTime || "—")}</td>
                  </tr>`).join("")}
              </tbody>
            </table></div>` : `<div class="empty-state">Aucun équipement Down détecté actuellement sur votre parc XIQ-SE.</div>`}
          </div>
        ` : almState.subTab === "nac_blocked" ? `
          <div class="toolbar">
            <div class="toolbar-group">
              <input id="alm-search" placeholder="Filtrer MAC, IP, utilisateur, switch, profil..." value="${esc(almState.search)}" style="width:280px;" />
              <span style="font-size:12px;color:var(--text-muted);">${filteredBlocked.length} terminal(aux) bloqué(s)/quarantaine</span>
            </div>
            <div class="toolbar-group">
              ${filteredBlocked.length ? `<button class="btn btn-sm btn-secondary" id="btn-export-blocked-csv">Exporter CSV</button>` : ""}
              <button class="btn btn-sm btn-ghost" onclick="XIQApp.navigate('nac')">Ouvrir NAC →</button>
            </div>
          </div>
          <div class="panel">
            ${filteredBlocked.length ? `<div class="table-wrap"><table>
              <thead><tr><th>État</th><th>MAC / IP</th><th>Utilisateur / Hôte</th><th>Switch &amp; Port</th><th>Profil / Auth</th><th>Action</th></tr></thead>
              <tbody>
                ${filteredBlocked.slice(0, 300).map((e) => {
                  const st = e.state || e.authorizationState || e.status || "Bloqué";
                  const swIp = e.switchIp || e.switchIP || "";
                  const port = e.portName || e.switchPortName || e.switchPort || e.port || "";
                  return `<tr>
                    <td><span class="badge badge-red">${esc(st)}</span></td>
                    <td class="mono"><strong>${XIQApi.macLink(e.macAddress || "")}</strong><div style="color:var(--text-muted);">${esc(e.ipAddress || "")}</div></td>
                    <td><strong>${esc(e.username || e.userName || "—")}</strong><div style="font-size:11.5px;color:var(--text-muted);">${esc(e.hostName || "")}</div></td>
                    <td class="mono">${swIp ? XIQApi.switchIpLink(swIp) : "—"}${port ? `<div style="color:var(--cyan);">${esc(port)}</div>` : ""}</td>
                    <td>${esc(e.profile || e.policy || "—")}<div style="font-size:11.5px;color:var(--text-muted);">${esc(e.authType || "")}</div></td>
                    <td><button class="btn btn-xs btn-secondary" onclick="XIQApp.navigate('locator', '${esc(e.macAddress || e.ipAddress || "")}')">Localiser</button></td>
                  </tr>`;
                }).join("")}
              </tbody>
            </table></div>` : `<div class="empty-state">Aucun terminal en Quarantaine ou Rejeté sur les ${sampledEndSystems.length.toLocaleString("fr-FR")} End-Systems inspectés.</div>`}
          </div>
        ` : `
          <div class="grid-2">
            <div class="panel">
              <div class="panel-header">
                <div class="panel-title">Moteurs NAC (ExtremeControl Appliances)</div>
                <span class="badge ${alertAppliances.length ? "badge-red" : "badge-green"}">${alertAppliances.length ? `${alertAppliances.length} alerte(s)` : `${appliances.length} actif(s)`}</span>
              </div>
              <div class="panel-body">
                ${appliances.length ? appliances.map((a) => {
                  const bad = /down|err|fail|off|warn|degrad/i.test(String(a.status || a.state || ""));
                  return `<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 10px;margin-bottom:8px;background:var(--bg-elevated);border:1px solid ${bad ? "rgba(239,68,68,0.45)" : "var(--border)"};border-radius:8px;">
                    <div>
                      <strong>${esc(a.displayName || a.name || a.hostName || a.ipAddress || "Moteur NAC")}</strong>
                      <div style="margin-top:2px;">${XIQApi.switchIpLink(a.ipAddress || a.ip || "")} ${a.version ? `<span class="badge badge-muted">${esc(a.version)}</span>` : ""}</div>
                    </div>
                    <div style="text-align:right;">
                      <span class="badge ${bad ? "badge-red" : "badge-green"}">${esc(a.status || a.state || "Actif")}</span>
                      ${(a.activeEndSystems ?? a.endSystemCount) !== undefined ? `<div style="font-size:11.5px;color:var(--text-muted);margin-top:3px;">${a.activeEndSystems ?? a.endSystemCount} sessions</div>` : ""}
                    </div>
                  </div>`;
                }).join("") : `<div class="empty-state">Aucun moteur NAC retourné.</div>`}
              </div>
            </div>
            <div class="panel">
              <div class="panel-header">
                <div class="panel-title">Alertes d'Hygiène NAC (Groupes &amp; MAC)</div>
                <button class="btn btn-xs btn-primary" onclick="XIQApp.navigate('suggestions')">Ouvrir Suggestions →</button>
              </div>
              <div class="panel-body">
                ${auditSummary ? `
                  <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px;">
                    <div style="padding:10px;background:var(--bg-elevated);border-radius:8px;border:1px solid var(--border);">
                      <div style="font-size:11.5px;color:var(--text-muted);">MAC jamais vues</div>
                      <div style="font-size:20px;font-weight:800;color:${auditSummary.neverSeenCount ? "var(--red)" : "var(--green)"};">${auditSummary.neverSeenCount ?? 0}</div>
                    </div>
                    <div style="padding:10px;background:var(--bg-elevated);border-radius:8px;border:1px solid var(--border);">
                      <div style="font-size:11.5px;color:var(--text-muted);">Doublons multi-groupes</div>
                      <div style="font-size:20px;font-weight:800;color:${auditSummary.duplicateCount ? "var(--amber)" : "var(--green)"};">${auditSummary.duplicateCount ?? 0}</div>
                    </div>
                  </div>
                  <div style="display:flex;gap:8px;flex-wrap:wrap;">
                    <button class="btn btn-sm btn-secondary" onclick="XIQApp.navigate('mac_audit')">Ouvrir Audit MAC &amp; Doublons</button>
                    <button class="btn btn-sm btn-secondary" onclick="XIQApp.navigate('suggestions')">Suggestions de Nettoyage</button>
                  </div>
                ` : `
                  <div class="empty-state" style="padding:18px;">
                    <p style="margin-bottom:10px;">Lancez un audit MAC pour détecter les entrées obsolètes, doublons et conflits Blacklist.</p>
                    <button class="btn btn-sm btn-primary" onclick="XIQApp.navigate('mac_audit')">Lancer l'Audit MAC</button>
                  </div>
                `}
              </div>
            </div>
          </div>
        `)}

        <details class="panel" style="margin-top:16px;">
          <summary class="panel-header" style="cursor:pointer;list-style:none;">
            <div class="panel-title">▸ Diagnostic technique du schéma GraphQL NBI (Alarmes &amp; Événements)</div>
            <span class="badge badge-muted">${uniqueDiscovered.length} requête(s) · ${allRelatedMuts.length} mutation(s)</span>
          </summary>
          <div class="panel-body">
            ${activeProbes.length ? `
              <div style="margin-bottom:12px;">
                <div style="font-size:12px;font-weight:700;color:var(--text-secondary);margin-bottom:6px;">Sondes GraphQL testées :</div>
                <div class="table-wrap"><table>
                  <thead><tr><th>Requête testée</th><th>Statut</th><th>Résultats</th><th>Action</th></tr></thead>
                  <tbody>
                    ${activeProbes.map((p) => `
                      <tr>
                        <td class="mono">${esc(p.key)}</td>
                        <td>${p.ok ? `<span class="badge badge-green">OK</span>` : `<span class="badge badge-red">Erreur</span>`}</td>
                        <td>${p.ok ? `<strong>${p.count}</strong> élément(s)` : `<span style="color:var(--red);font-size:11.5px;">${esc(p.errorMsg || "Réponse non exploitable")}</span>`}</td>
                        <td>${p.query ? `<button class="btn btn-xs btn-ghost" data-open-probe="${esc(p.key)}">&lt;/&gt; Studio</button>` : "—"}</td>
                      </tr>`).join("")}
                  </tbody>
                </table></div>
              </div>` : ""}
            ${uniqueDiscovered.length || allRelatedMuts.length ? `
              <div style="font-size:12px;font-weight:700;color:var(--text-secondary);margin-bottom:6px;">Opérations Alarmes / Événements exposées par le schéma :</div>
              <div style="display:flex;gap:6px;flex-wrap:wrap;">
                ${uniqueDiscovered.map((q) => `<button class="btn btn-xs ${q.callable ? "btn-secondary" : "btn-ghost"}" data-gen-op="query" data-gen-dom="${esc(q.domainName)}" data-gen-fn="${esc(q.field.name)}" title="${esc((q.callable ? "" : "[Paramètre obligatoire] ") + (q.field.description || ""))}">Q: ${esc(q.domainName)}.${esc(q.field.name)}${q.callable ? "" : " (param.)"}</button>`).join("")}
                ${allRelatedMuts.map((m) => `<button class="btn btn-xs btn-ghost" style="border-color:rgba(245,158,11,0.45);color:var(--amber);" data-gen-op="mutation" data-gen-dom="${esc(m.domainName)}" data-gen-fn="${esc(m.field.name)}" title="${esc(m.field.description || "")}">M: ${esc(m.domainName)}.${esc(m.field.name)}</button>`).join("")}
              </div>
            ` : `<div style="font-size:12.5px;color:var(--text-secondary);">Aucune requête de lecture d'alarmes ou d'événements n'est exposée dans le schéma GraphQL NBI de ce serveur XIQ-SE. Pour exporter les alarmes OneView en temps réel, utilisez le transfert <strong>Syslog</strong> ou les <strong>Actions d'Alarme / Workflows</strong> côté XIQ-SE.</div>`}
          </div>
        </details>
      `;

      bindOpenStudio(viewport, almRes.available ? (almState.tab === "events" ? (evtRes.query || almRes.query) : almRes.query) : (devStatusRes.query || ""));
      bindDomainCatalogButtons(viewport, indexed);

      viewport.querySelectorAll("[data-open-probe]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const p = probeMap.get(btn.dataset.openProbe);
          if (p && p.query) openInStudio(p.query, {});
        });
      });

      viewport.querySelectorAll("[data-atab]").forEach((b) => { b.addEventListener("click", () => { almState.tab = b.dataset.atab; drawAlm(); }); });
      viewport.querySelectorAll("[data-hsub]").forEach((b) => { b.addEventListener("click", () => { almState.subTab = b.dataset.hsub; drawAlm(); }); });
      viewport.querySelectorAll("[data-sev]").forEach((b) => { b.addEventListener("click", () => { almState.sev = b.dataset.sev; drawAlm(); }); });

      const almSearch = viewport.querySelector("#alm-search");
      if (almSearch) {
        almSearch.addEventListener("input", (e) => {
          almState.search = e.target.value;
          const pos = e.target.selectionStart;
          drawAlm();
          const el = viewport.querySelector("#alm-search");
          if (el) { el.focus(); el.setSelectionRange(pos, pos); }
        });
      }

      const daysSel = viewport.querySelector("#alm-days");
      if (daysSel) {
        daysSel.addEventListener("change", (e) => {
          almState.days = parseInt(e.target.value, 10) || 7;
          renderAlarms(viewport);
        });
      }
      const almSrcSel = viewport.querySelector("#alm-source-sel");
      if (almSrcSel) {
        almSrcSel.addEventListener("change", (e) => {
          almState.alarmSourceKey = e.target.value;
          renderAlarms(viewport);
        });
      }
      const evtSrcSel = viewport.querySelector("#evt-source-sel");
      if (evtSrcSel) {
        evtSrcSel.addEventListener("change", (e) => {
          almState.eventSourceKey = e.target.value;
          renderAlarms(viewport);
        });
      }

      const expAlm = viewport.querySelector("#btn-export-alm-csv");
      if (expAlm) {
        expAlm.addEventListener("click", () => {
          const rows = almRes.available
            ? filteredAlarms.map((a) => ({ ID: a.id, Severite: a.severity, Source: a.sourceName, IP: a.sourceIp, Message: a.message, Date: a.timestamp, Acquittee: a.acknowledged ? "Oui" : "Non" }))
            : SchemaTools.extractTableRows({ downDevices: filteredDown });
          XIQApi.exportFile(`xiqse-alarms-${Date.now()}.csv`, XIQApi.rowsToCsv(rows));
        });
      }
      const expBlocked = viewport.querySelector("#btn-export-blocked-csv");
      if (expBlocked) {
        expBlocked.addEventListener("click", () => {
          XIQApi.exportFile(`xiqse-nac-blocked-${Date.now()}.csv`, XIQApi.rowsToCsv(filteredBlocked));
        });
      }
      const expEvt = viewport.querySelector("#btn-export-evt-csv");
      if (expEvt) {
        expEvt.addEventListener("click", () => {
          const rows = SchemaTools.extractTableRows({ events: filteredEvents });
          XIQApi.exportFile(`xiqse-events-${Date.now()}.csv`, XIQApi.rowsToCsv(rows));
        });
      }

      viewport.querySelectorAll("[data-ack]").forEach((b) => {
        b.addEventListener("click", async () => {
          const built = buildAdaptiveAlarmMutation(indexed, ackMutOp, b.dataset.ack);
          if (!built) return XIQApi.toast("Mutation d'acquittement introuvable dans ce schéma.", "warn");
          const r = await runOp(built.query, built.variables, "alarms");
          const out = built.domainName ? r.data?.[built.domainName]?.[built.fieldName] : r.data?.[built.fieldName];
          XIQApi.toast(out?.message || r.errors?.[0]?.message || "Acquittée", r.ok ? "success" : "error");
          renderAlarms(viewport);
        });
      });
      viewport.querySelectorAll("[data-clr]").forEach((b) => {
        b.addEventListener("click", async () => {
          const built = buildAdaptiveAlarmMutation(indexed, clrMutOp, b.dataset.clr);
          if (!built) return XIQApi.toast("Mutation de clôture introuvable dans ce schéma.", "warn");
          const r = await runOp(built.query, built.variables, "alarms");
          const out = built.domainName ? r.data?.[built.domainName]?.[built.fieldName] : r.data?.[built.fieldName];
          XIQApi.toast(out?.message || r.errors?.[0]?.message || "Clôturée", r.ok ? "success" : "error");
          renderAlarms(viewport);
        });
      });
    };

    drawAlm();
  }

  // =========================================================================
  // 7. ADMINISTRATION & GUIDE XIQ-SE (Schema-Adaptive)
  // =========================================================================
  async function renderAdmin(viewport) {
    viewport.classList.remove("studio-mode");
    viewport.innerHTML = `<div class="loading-state">Chargement adaptatif de l'administration XIQ-SE...</div>`;

    const indexed = await getSchema();
    const [srvRes, grpRes, cliRes] = await Promise.all([
      runAdaptive(indexed, ["administration"], ["serverInfo"], { includeAllScalars: true }, "admin"),
      runAdaptive(indexed, ["administration"], ["authorizationGroups", "groups"], { includeAllScalars: true }, "admin"),
      runAdaptive(indexed, ["administration"], ["apiClients", "clients"], { includeAllScalars: true }, "admin"),
    ]);

    const srv = srvRes.data || {};
    const authGroups = Array.isArray(grpRes.data) ? grpRes.data : [];
    const clients = Array.isArray(cliRes.data) ? cliRes.data : [];
    const isDemo = window.XIQApp?.getActiveProfile?.()?.mode === "demo";

    viewport.innerHTML = `
      ${renderErrorBanner(srvRes.errors || [], srvRes.query)}
      <div class="grid-2">
        <div class="panel">
          <div class="panel-header">
            <div class="panel-title">Serveur XIQ-SE (administration.serverInfo)</div>
            ${srvRes.query ? `<button class="btn btn-xs btn-ghost" data-open-studio="1">&lt;/&gt; GraphQL</button>` : ""}
          </div>
          <div class="panel-body">
            ${renderKeyValueTable(srv)}
          </div>
        </div>

        <div class="panel">
          <div class="panel-header">
            <div class="panel-title">Guide &amp; Configuration XIQ-SE</div>
            <button class="btn btn-xs btn-primary" id="btn-admin-conn">Configurer un serveur</button>
          </div>
          <div class="panel-body">
            <div class="guide-step">
              <div class="guide-num">1</div>
              <div><strong>Groupe d'Autorisation NBI</strong><div style="font-size:12px;color:var(--text-secondary);">Dans XIQ-SE : <em>Administration &gt; Users &gt; Authorization Groups</em>. Activez <strong>Northbound API Read/Write</strong>, <strong>Access Control NBI</strong> et <strong>Policy NBI</strong>.</div></div>
            </div>
            <div class="guide-step">
              <div class="guide-num">2</div>
              <div><strong>Client API OAuth 2.0</strong><div style="font-size:12px;color:var(--text-secondary);">Dans <em>Administration &gt; Client API Access</em>, générez un <strong>Client ID</strong> et un <strong>Client Secret</strong> associés à votre groupe.</div></div>
            </div>
            <div class="guide-step">
              <div class="guide-num">3</div>
              <div><strong>Adaptation automatique au schéma</strong><div style="font-size:12px;color:var(--text-secondary);">XIQ-SE API Studio introspecte automatiquement <code>__schema</code> sur votre serveur afin d'adapter toutes les requêtes à votre version exacte de Site Engine.</div></div>
            </div>
            ${isDemo ? `<div style="margin-top:12px;"><button class="btn btn-xs btn-secondary" id="btn-reset-demo">↻ Réinitialiser le Mode Démo</button></div>` : ""}
          </div>
        </div>
      </div>

      ${authGroups.length || clients.length ? `<div class="grid-2">
        <div class="panel">
          <div class="panel-header"><div class="panel-title">Groupes d'autorisation NBI</div></div>
          ${renderDynamicTable(authGroups, "Non exposé.")}
        </div>
        <div class="panel">
          <div class="panel-header"><div class="panel-title">Clients API OAuth 2.0</div></div>
          ${renderDynamicTable(clients, "Non exposé.")}
        </div>
      </div>` : ""}

      ${renderDomainCatalogPanel(indexed, ["administration"], "Toutes les opérations Administration de votre serveur")}
    `;

    bindOpenStudio(viewport, srvRes.query);
    bindDomainCatalogButtons(viewport, indexed);
    viewport.querySelector("#btn-admin-conn").addEventListener("click", () => XIQApp.openConnectionsModal());
    const resetBtn = viewport.querySelector("#btn-reset-demo");
    if (resetBtn) {
      resetBtn.addEventListener("click", async () => {
        await XIQApi.resetDemo();
        XIQApi.toast("Données de démonstration réinitialisées.", "success");
        renderAdmin(viewport);
      });
    }
  }

  function openDuplicatesAudit() {
    auditState.filterMode = "duplicates";
    window.XIQApp.navigate("mac_audit");
  }

  return {
    dashboard: renderDashboard,
    network: renderNetwork,
    nac: renderNac,
    mac_audit: renderMacAudit,
    suggestions: renderSuggestions,
    workflows: renderWorkflows,
    policy: renderPolicy,
    alarms: renderAlarms,
    admin: renderAdmin,
    // Shared helpers for NetOpsTools
    openDuplicatesAudit,
    getAuditState: () => auditState,
    normalizeMac,
    buildAdaptiveGroupMutation,
    getGroupEntries,
    runAdaptive,
    runAdaptivePaginated,
    runOp,
    getSchema,
    openInStudio,
    isDeviceUp,
    renderKeyValueTable,
    renderDynamicTable,
  };
})();
