/* NetOps Power Tools: Express Locator (MAC/IP/User), Bulk CSV Import to NAC Group, Full Inventory Report */

window.NetOpsTools = (() => {
  const esc = XIQApi.escapeHtml;

  // =========================================================================
  // 1. LOCALISATEUR EXPRESS (MAC / IP / Utilisateur / Hostname)
  // =========================================================================
  const locatorState = {
    query: "",
    running: false,
    progressText: "",
    results: [], // [{ es, switchDev, matchedPort, nacGroups, searchedGroups }]
    lastQuery: "",
  };

  const deviceDirCache = { profileId: null, byIp: null };

  async function getDevicesDirectoryMap(indexed) {
    const pid = window.XIQApp?.getActiveProfile?.()?.id || "default";
    if (deviceDirCache.profileId === pid && deviceDirCache.byIp) {
      return deviceDirCache.byIp;
    }
    const byIp = new Map();
    if (!indexed) return byIp;
    try {
      const res = await OpsViews.runAdaptivePaginated(
        indexed,
        ["network"],
        ["devices", "allDevices"],
        {
          preferredScalars: [
            "ip", "sysName", "deviceName", "nickName", "name", "sitePath",
            "deviceDisplayFamily", "family", "firmware", "status", "id", "deviceId",
          ],
          includeAllScalars: false,
        },
        "mac_audit",
        "all"
      );
      if (res.ok && Array.isArray(res.data)) {
        res.data.forEach((d) => {
          if (d && d.ip) byIp.set(String(d.ip).trim(), d);
        });
      }
    } catch {
      // non-fatal
    }
    deviceDirCache.profileId = pid;
    deviceDirCache.byIp = byIp;
    return byIp;
  }

  function getSwitchDisplayName(sw, es) {
    return String(
      sw?.sysName ||
        sw?.deviceName ||
        sw?.nickName ||
        sw?.name ||
        es?.switchName ||
        es?.switchHostName ||
        es?.switchNickName ||
        es?.deviceName ||
        ""
    ).trim();
  }

  function discoverDevicePortFieldNames(indexed) {
    const netDom = SchemaTools.getDomainType(indexed, ["network"], "query");
    const devField = netDom ? SchemaTools.findFieldByCandidates(indexed, netDom.domainType, ["device", "deviceByIp"]) : null;
    const devBase = devField ? SchemaTools.unwrapType(devField.type) : null;
    const devType = devBase ? SchemaTools.getType(indexed, devBase.name) : null;
    const found = [];
    if (devType && Array.isArray(devType.fields)) {
      devType.fields.forEach((f) => {
        if (/port|interface|iftable|ifentry/i.test(f.name) && !(f.args || []).some((a) => SchemaTools.isNonNull(a.type))) {
          found.push(f.name);
        }
      });
    }
    return Array.from(new Set([...found, "interfaces", "ports", "portData", "devicePorts", "portList"]));
  }

  function extractPortsArrayFromDevice(switchDev) {
    if (!switchDev || typeof switchDev !== "object") return [];
    for (const key of ["interfaces", "ports", "portData", "devicePorts", "portList"]) {
      if (Array.isArray(switchDev[key]) && switchDev[key].length) return switchDev[key];
    }
    for (const [k, v] of Object.entries(switchDev)) {
      if (/port|interface|if/i.test(k) && Array.isArray(v) && v.length && typeof v[0] === "object") {
        return v;
      }
    }
    return [];
  }

  function getPortDisplayName(p) {
    if (!p || typeof p !== "object") return "";
    return String(
      p.name || p.ifName || p.portName || p.displayName || p.shortName || p.ifDescr || p.portDisplayName || ""
    ).trim();
  }

  function isReadablePortString(val) {
    if (val === null || val === undefined) return false;
    const s = String(val).trim();
    if (!s) return false;
    // Pure digits (like 197, 1006, 4096) are usually SNMP ifIndex / portId, not human port names like 1/6 or 1:6
    return !/^\d+$/.test(s);
  }

  function extractEndSystemPortCandidates(es) {
    if (!es || typeof es !== "object") return { readable: "", rawId: "" };
    const preferredReadableKeys = [
      "portName", "switchPortName", "portIfName", "portDisplayName",
      "interfaceName", "ifName", "switchPort", "port", "accessPort",
    ];
    let readable = "";
    for (const k of preferredReadableKeys) {
      if (isReadablePortString(es[k])) {
        readable = String(es[k]).trim();
        break;
      }
    }
    // Also scan any dynamic field on EndSystemDTO containing 'port' or 'ifname' that has a readable name (like 1/6)
    if (!readable) {
      for (const [k, v] of Object.entries(es)) {
        if (/port|ifname|interface/i.test(k) && !/id$|index$|count$/i.test(k) && isReadablePortString(v)) {
          readable = String(v).trim();
          break;
        }
      }
    }
    const rawId = String(
      es.switchPortId ?? es.portId ?? es.ifIndex ?? es.portIndex ?? es.switchPort ?? es.port ?? ""
    ).trim();
    return { readable, rawId };
  }

  function matchPortOnSwitch(switchDev, esOrRawPort) {
    if (!switchDev || !esOrRawPort) return null;
    const ports = extractPortsArrayFromDevice(switchDev);
    if (!ports.length) return null;

    const { readable, rawId } =
      typeof esOrRawPort === "object"
        ? extractEndSystemPortCandidates(esOrRawPort)
        : { readable: isReadablePortString(esOrRawPort) ? String(esOrRawPort).trim() : "", rawId: String(esOrRawPort).trim() };

    const targets = [readable, rawId].filter(Boolean).map((x) => x.toLowerCase());
    if (!targets.length) return null;

    // 1) Exact match on numeric ifIndex / portIndex / id / portId / index / portNumber
    if (rawId) {
      const idMatch = ports.find((p) => {
        const ids = [p.ifIndex, p.portIndex, p.id, p.portId, p.index, p.ifNumber, p.portNumber, p.elemId]
          .filter((x) => x !== null && x !== undefined && x !== "")
          .map((x) => String(x).trim().toLowerCase());
        return ids.includes(rawId.toLowerCase());
      });
      if (idMatch) return idMatch;
    }

    // 2) Exact match on port name / ifName / portName / displayName / ifDescr
    let found = ports.find((p) => {
      const names = [p.name, p.ifName, p.portName, p.displayName, p.ifDescr, p.portDisplayName]
        .filter(Boolean)
        .map((x) => String(x).trim().toLowerCase());
      return targets.some((t) => names.includes(t));
    });
    if (found) return found;

    // 3) Normalized slot/port suffix match (e.g. "ge.1.6" vs "1/6" vs "1:6")
    for (const target of targets) {
      if (/^\d+$/.test(target)) continue;
      const norm = target.replace(/[a-z._-]/g, "").replace(/\//g, ":");
      found = ports.find((p) => {
        const pname = getPortDisplayName(p).toLowerCase();
        if (!pname) return false;
        if (pname.endsWith(target) || target.endsWith(pname)) return true;
        const pnorm = pname.replace(/[a-z._-]/g, "").replace(/\//g, ":");
        return norm && pnorm && pnorm === norm;
      });
      if (found) return found;
    }
    return null;
  }

  function formatResolvedPort(es, matchedPort) {
    const { readable, rawId } = extractEndSystemPortCandidates(es);
    const matchedName = getPortDisplayName(matchedPort);
    const display = matchedName || readable || rawId || "—";
    const subId = rawId && rawId !== display ? rawId : "";
    return { display, subId };
  }

  function extractPoeDisplay(portObj) {
    if (!portObj) return "Non remonté";
    const watts = portObj.poePowerWatts ?? portObj.poePower ?? portObj.powerWatts ?? portObj.poeCurrentPower;
    const status = portObj.poeStatus ?? portObj.poeAdminStatus ?? portObj.poeOperStatus ?? portObj.poeState;
    if (watts !== undefined && watts !== null && Number(watts) > 0) {
      return `${watts} W${status ? ` (${status})` : " (Actif)"}`;
    }
    if (status) return String(status);
    if (watts !== undefined && watts !== null) return `${watts} W (Inactif)`;
    return "Non remonté par le switch";
  }

  async function findNacGroupsForMac(indexed, normMac) {
    // 1. Check in-memory Audit cache first (instant!)
    const audit = OpsViews.getAuditState();
    const pid = window.XIQApp?.getActiveProfile?.()?.id;
    if (audit && audit.profileId === pid && audit.items?.length) {
      const hit = audit.items.find((it) => it.mac === normMac);
      return { groups: hit ? hit.groupNames : [], fromCache: true };
    }

    // 2. Otherwise query NAC groups cleanly (using inline values or 15-group GraphQL alias batches)
    const grpRes = await OpsViews.runAdaptive(
      indexed,
      ["accessControl"],
      ["endSystemGroups", "groups", "allGroups", "groupNames"],
      {
        preferredScalars: ["name", "groupName", "type", "values", "entries", "members"],
        nestedSpecs: [{ candidates: ["values", "entries", "members", "groupValues", "valueList"], includeAllScalars: true }],
        includeAllScalars: true,
      },
      "mac_audit"
    );
    const rawGroups = Array.isArray(grpRes.data) ? grpRes.data : [];
    const matchedGroups = [];
    const needFetch = [];

    for (const g of rawGroups) {
      const gName = typeof g === "object" ? (g.name || g.groupName || "") : String(g);
      if (!gName) continue;
      const entries = typeof g === "object" ? OpsViews.getGroupEntries(g) : [];
      if (entries.length) {
        if (entries.some((e) => OpsViews.normalizeMac(e.raw) === normMac)) {
          matchedGroups.push(gName);
        }
      } else {
        const gType = typeof g === "object" ? String(g.type || "").toLowerCase() : "";
        if (!/(ip|subnet|host|user|location|switch|port|time|os|rule|policy|ssid|vlan|ldap|radius)/i.test(gType) || /mac|end|system|black/i.test(gType)) {
          needFetch.push(gName);
        }
      }
    }

    const acDom = SchemaTools.getDomainType(indexed, ["accessControl"], "query");
    const singleGrpField = acDom
      ? SchemaTools.findFieldByCandidates(indexed, acDom.domainType, ["group", "groupByName", "endSystemGroup"])
      : null;

    if (needFetch.length && singleGrpField) {
      const argName = singleGrpField.args?.find((a) => /^(name|groupname|group)$/i.test(a.name))?.name || "name";
      const retBase = SchemaTools.unwrapType(singleGrpField.type);
      const sel = SchemaTools.buildSafeSelection(
        indexed,
        retBase.name,
        ["name", "values", "entries", "members"],
        [{ candidates: ["values", "entries", "members", "groupValues", "valueList"], includeAllScalars: true }],
        true
      );
      for (let i = 0; i < needFetch.length; i += 15) {
        const chunk = needFetch.slice(i, i + 15);
        const lines = chunk
          .map((gn, idx) => `g${idx}: ${singleGrpField.name}(${argName}: ${JSON.stringify(gn)}) { ${sel} }`)
          .join("\n    ");
        const q = `query FindMacGroups {\n  ${acDom.domainFieldName} {\n    ${lines}\n  }\n}`;
        try {
          const r = await OpsViews.runOp(q, {}, "mac_audit");
          const acData = r?.data?.[acDom.domainFieldName];
          if (r?.ok && acData) {
            chunk.forEach((gn, idx) => {
              const gObj = acData[`g${idx}`];
              if (!gObj) return;
              const ents = OpsViews.getGroupEntries(gObj);
              if (ents.some((e) => OpsViews.normalizeMac(e.raw) === normMac)) {
                matchedGroups.push(gn);
              }
            });
          }
        } catch {
          // ignore batch error
        }
      }
    }

    return { groups: matchedGroups, fromCache: false };
  }

  async function executeLocate(viewport, term) {
    const clean = (term || "").trim();
    if (!clean) return;
    locatorState.query = clean;
    locatorState.lastQuery = clean;
    locatorState.running = true;
    locatorState.results = [];
    locatorState.progressText = `Recherche de « ${clean} » sur XIQ-SE...`;
    drawLocator(viewport);

    const setStatus = (txt) => {
      locatorState.progressText = txt;
      const el = viewport.querySelector("#loc-progress");
      if (el) el.textContent = txt;
    };

    try {
      const indexed = await OpsViews.getSchema();
      if (!indexed) {
        XIQApi.toast("Schéma GraphQL indisponible.", "error");
        locatorState.running = false;
        drawLocator(viewport);
        return;
      }

      const normMac = OpsViews.normalizeMac(clean);
      const lowerTerm = clean.toLowerCase();
      let matchedEndSystems = [];

      // 1) If exact MAC, try fast direct endSystemByMac first
      if (normMac) {
        setStatus(`Recherche directe de la MAC ${normMac}...`);
        const directRes = await OpsViews.runAdaptive(
          indexed,
          ["accessControl"],
          ["endSystemByMac"],
          {
            args: { macAddress: normMac, mac: normMac },
            wrapperCandidates: ["endSystem"],
            preferredScalars: [
              "macAddress", "ipAddress", "username", "userName", "hostName",
              "switchIP", "switchIp", "switchPort", "switchPortId", "authType",
              "profile", "policy", "vlan", "state", "zone", "operatingSystemName", "lastSeenTime",
            ],
            nestedSpecs: [
              {
                candidates: ["endSystem"],
                preferred: [
                  "macAddress", "ipAddress", "username", "userName", "hostName",
                  "switchIP", "switchIp", "switchPort", "switchPortId", "authType",
                  "profile", "policy", "vlan", "state", "zone", "operatingSystemName", "lastSeenTime",
                ],
                includeAllScalars: true,
              },
            ],
            includeAllScalars: true,
          },
          "locator"
        );
        const esObj = directRes.data?.endSystem || (directRes.data?.macAddress ? directRes.data : null);
        if (esObj && esObj.macAddress) {
          matchedEndSystems.push(esObj);
        }
      }

      // 2) If not found directly (or searching IP / Username / Hostname / partial MAC), paginate End-Systems
      if (!matchedEndSystems.length) {
        const dom = SchemaTools.getDomainType(indexed, ["accessControl"], "query");
        const esField = dom
          ? SchemaTools.findFieldByCandidates(indexed, dom.domainType, ["endSystems", "allEndSystemsAsProperties", "allEndSystems"])
          : null;

        if (esField) {
          const argNames = (esField.args || []).map((a) => a.name);
          const maxArg = argNames.find((n) => /^(maxresults|limit|pagesize|count)$/i.test(n));
          const firstArg = argNames.find((n) => /^(firstresult|offset|startindex)$/i.test(n));
          const pageSize = 500;
          let scanned = 0;

          for (let page = 0; page < 60; page++) {
            const pageArgs = {};
            if (maxArg) pageArgs[maxArg] = pageSize;
            if (firstArg) pageArgs[firstArg] = page * pageSize;
            setStatus(`Recherche dans les End-Systems (${scanned} analysés)...`);

            const res = await OpsViews.runAdaptive(
              indexed,
              ["accessControl"],
              [esField.name],
              {
                args: pageArgs,
                wrapperCandidates: ["endSystem", "endSystems", "results", "items"],
                preferredScalars: [
                  "macAddress", "ipAddress", "username", "userName", "hostName",
                  "switchIP", "switchIp", "switchPort", "switchPortId", "authType",
                  "profile", "policy", "vlan", "state", "zone", "operatingSystemName", "lastSeenTime",
                ],
                includeAllScalars: true,
              },
              "mac_audit"
            );
            const batch = Array.isArray(res.data) ? res.data : [];
            scanned += batch.length;

            batch.forEach((es) => {
              const fields = [
                es.macAddress,
                OpsViews.normalizeMac(es.macAddress),
                es.ipAddress,
                es.username,
                es.userName,
                es.hostName,
                es.switchIP,
                es.switchIp,
              ];
              if (fields.some((f) => f && String(f).toLowerCase().includes(lowerTerm))) {
                matchedEndSystems.push(es);
              }
            });

            if (matchedEndSystems.length >= 25 || !maxArg || !firstArg || batch.length < pageSize) {
              break;
            }
          }
        }
      }

      // 3) If searching a MAC not seen in End-Systems, still check NAC groups!
      if (!matchedEndSystems.length && normMac) {
        setStatus(`MAC ${normMac} non vue dans les End-Systems — recherche dans les groupes NAC...`);
        const grpLookup = await findNacGroupsForMac(indexed, normMac);
        if (grpLookup.groups.length) {
          locatorState.results.push({
            es: { macAddress: normMac, state: "Jamais vue (Absente End-Systems)" },
            switchDev: null,
            matchedPort: null,
            nacGroups: grpLookup.groups,
            searchedGroups: true,
          });
        }
      }

      // 4) Enrich top matches (up to 12) with Switch Name (from network.devices), Port / PoE, and NAC Groups!
      const devicesByIp = await getDevicesDirectoryMap(indexed);
      const uniqueSwitches = new Map();
      const topMatches = matchedEndSystems.slice(0, 12);
      const portFieldCandidates = discoverDevicePortFieldNames(indexed);

      for (let i = 0; i < topMatches.length; i++) {
        const es = topMatches[i];
        const swIp = String(es.switchIP || es.switchIp || "").trim();
        let switchDev = swIp ? (devicesByIp.get(swIp) || null) : null;

        if (swIp) {
          if (uniqueSwitches.has(swIp)) {
            switchDev = uniqueSwitches.get(swIp);
          } else {
            const knownName = getSwitchDisplayName(switchDev, es);
            setStatus(`Récupération des ports & PoE (${knownName || swIp})...`);
            const swRes = await OpsViews.runAdaptive(
              indexed,
              ["network"],
              ["device", "deviceByIp"],
              {
                args: { ip: swIp, ipAddress: swIp, deviceIp: swIp },
                preferredScalars: ["ip", "sysName", "deviceName", "nickName", "name", "sitePath", "deviceDisplayFamily", "firmware", "status", "id", "deviceId"],
                nestedSpecs: portFieldCandidates.map((pf) => ({
                  candidates: [pf],
                  preferred: [
                    "name", "ifName", "portName", "displayName", "ifDescr",
                    "ifIndex", "portIndex", "id", "portId", "index", "portNumber",
                    "alias", "ifAlias", "adminStatus", "operStatus", "portStatus", "status",
                    "speed", "portSpeed", "vlan", "pvid", "poePowerWatts", "poePower", "poeStatus",
                  ],
                  includeAllScalars: true,
                })),
                includeAllScalars: false,
              },
              "mac_audit"
            );
            if (swRes.ok && swRes.data) {
              switchDev = { ...(switchDev || {}), ...swRes.data };
            }
            // Fallback: if Device has no inline ports array, try dedicated network port queries (e.g. network.ports / devicePorts)
            if (switchDev && !extractPortsArrayFromDevice(switchDev).length) {
              const portQ = await OpsViews.runAdaptive(
                indexed,
                ["network"],
                ["ports", "devicePorts", "interfaces", "deviceInterfaces", "portsByDevice", "portData"],
                {
                  args: { ip: swIp, ipAddress: swIp, deviceIp: swIp, deviceId: switchDev.id ?? switchDev.deviceId },
                  preferredScalars: [
                    "name", "ifName", "portName", "displayName", "ifDescr",
                    "ifIndex", "portIndex", "id", "portId", "index", "portNumber",
                    "alias", "ifAlias", "adminStatus", "operStatus", "portStatus", "status",
                    "speed", "portSpeed", "vlan", "pvid", "poePowerWatts", "poePower", "poeStatus",
                  ],
                  includeAllScalars: true,
                },
                "mac_audit"
              );
              if (portQ.ok && Array.isArray(portQ.data) && portQ.data.length) {
                switchDev = { ...switchDev, ports: portQ.data };
              }
            }
            uniqueSwitches.set(swIp, switchDev);
          }
        }

        const matchedPort = matchPortOnSwitch(switchDev, es);
        const esMacNorm = OpsViews.normalizeMac(es.macAddress);
        let nacGroups = [];
        let searchedGroups = false;

        if (esMacNorm && i < 5) {
          setStatus(`Recherche des groupes NAC pour ${esMacNorm}...`);
          const gRes = await findNacGroupsForMac(indexed, esMacNorm);
          nacGroups = gRes.groups;
          searchedGroups = true;
        }

        locatorState.results.push({
          es,
          switchDev,
          matchedPort,
          nacGroups,
          searchedGroups,
        });
      }
    } catch (err) {
      XIQApi.toast(`Erreur Localisateur : ${err.message}`, "error");
    } finally {
      locatorState.running = false;
      drawLocator(viewport);
    }
  }

  function drawLocator(viewport) {
    const indexed = SchemaTools.getCachedSchemaInfo().indexed;
    const nacMuts = indexed ? SchemaTools.listDomainMutations(indexed, ["accessControl"]) : [];
    const hasMut = (n) => nacMuts.some((m) => m.field.name === n);

    viewport.innerHTML = `
      <div class="panel">
        <div class="panel-body">
          <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;">
            <input id="loc-input" placeholder="Tapez une adresse MAC, une IP, un utilisateur ou un hostname (ex: 00:1A:2B:3C:4D:01, 10.10.20.41, dupont)..." value="${esc(locatorState.query)}" style="flex:1;min-width:300px;padding:10px 14px;font-size:14px;" />
            <button class="btn btn-primary" id="btn-loc-go" ${locatorState.running ? "disabled" : ""}>⌕ Localiser</button>
          </div>
          <div style="margin-top:8px;font-size:12px;color:var(--text-muted);">
            Donne immédiatement : <strong>Switch</strong>, <strong>Port</strong>, <strong>VLAN</strong>, <strong>Groupes NAC</strong>, <strong>Profil</strong> et <strong>Statut / Puissance PoE</strong>. Astuce : utilisez <kbd>Ctrl+K</kbd> depuis n'importe quel écran !
          </div>
        </div>
      </div>

      ${locatorState.running ? `<div class="panel"><div class="panel-body" id="loc-progress">${esc(locatorState.progressText)}</div></div>` : ""}

      ${!locatorState.running && locatorState.lastQuery && !locatorState.results.length ? `
        <div class="panel"><div class="empty-state">Aucun terminal trouvé pour « <strong>${esc(locatorState.lastQuery)}</strong> ».</div></div>` : ""}

      ${locatorState.results.map((r, idx) => {
        const es = r.es || {};
        const sw = r.switchDev || {};
        const port = r.matchedPort || null;
        const swIp = es.switchIP || es.switchIp || "—";
        const resolvedPort = formatResolvedPort(es, port);
        const swName = getSwitchDisplayName(sw, es) || swIp;
        const swModel = sw.deviceDisplayFamily || sw.family || "";
        const vlan = es.vlan || port?.vlan || port?.pvid || "—";
        const poe = extractPoeDisplay(port);
        const st = es.state || "—";
        const stBadge = /accept/i.test(st) ? "badge-green" : /jamais|quarant|reject/i.test(st) ? "badge-red" : "badge-amber";

        return `
        <div class="panel">
          <div class="panel-header">
            <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
              <strong class="mono inline-val-wrap" style="font-size:15px;color:var(--cyan);" data-right-copy="${esc(es.macAddress || "")}">${esc(es.macAddress || "—")}${XIQApi.copyBtnHtml(es.macAddress)}</strong>
              <span class="badge ${stBadge}">${esc(st)}</span>
              ${es.ipAddress ? `<span class="badge badge-muted mono inline-val-wrap" data-right-copy="${esc(es.ipAddress)}">IP : ${esc(es.ipAddress)}${XIQApi.copyBtnHtml(es.ipAddress)}</span>` : ""}
              ${(es.username || es.userName) ? `<span class="badge badge-purple">👤 ${esc(es.username || es.userName)}</span>` : ""}
              ${es.hostName ? `<span style="font-size:12.5px;color:var(--text-secondary);">${esc(es.hostName)}</span>` : ""}
            </div>
            <div style="display:flex;gap:6px;">
              ${swIp && swIp !== "—" ? `<button class="btn btn-xs btn-secondary" data-open-ip="${esc(swIp)}">🌐 Ouvrir Switch</button>` : ""}
              ${hasMut("reauthenticateEndSystem") && es.macAddress ? `<button class="btn btn-xs btn-secondary" data-loc-reauth="${esc(es.macAddress)}">CoA / Ré-auth</button>` : ""}
              ${hasMut("addMACToBlacklist") && es.macAddress ? `<button class="btn btn-xs btn-danger" data-loc-bl="${esc(es.macAddress)}">Blacklister</button>` : ""}
              <button class="btn btn-xs btn-ghost" data-loc-copy="${idx}">Copier fiche</button>
            </div>
          </div>
          <div class="panel-body">
            <div class="kpi-grid" style="margin-bottom:12px;">
              <div class="kpi-card">
                <div class="kpi-label">Switch d'accès</div>
                <div class="kpi-value" style="font-size:16px;">${esc(swName)}${swName && swName !== "—" ? XIQApi.copyBtnHtml(swName) : ""}</div>
                <div class="kpi-sub mono">${XIQApi.switchIpLink(swIp)}${swModel ? ` · ${esc(swModel)}` : ""}${sw.sitePath ? ` · ${esc(sw.sitePath)}` : ""}</div>
              </div>
              <div class="kpi-card">
                <div class="kpi-label">Port Physique / SSID</div>
                <div class="kpi-value" style="font-size:16px;color:var(--cyan);">${esc(resolvedPort.display)}</div>
                <div class="kpi-sub">${port ? `${esc(port.operStatus || port.portStatus || port.status || "—")} · ${esc(port.speed || port.portSpeed || "—")} · ${esc(port.alias || port.ifAlias || "")}` : resolvedPort.subId ? `ID port : ${esc(resolvedPort.subId)}` : "Détail port non remonté"}${port && resolvedPort.subId ? ` (ID: ${esc(resolvedPort.subId)})` : ""}</div>
              </div>
              <div class="kpi-card">
                <div class="kpi-label">VLAN &amp; Profil NAC</div>
                <div class="kpi-value" style="font-size:16px;">VLAN ${esc(vlan)}</div>
                <div class="kpi-sub">${esc(es.profile || es.policy || "—")} ${es.authType ? `· ${esc(es.authType)}` : ""}</div>
              </div>
              <div class="kpi-card">
                <div class="kpi-label">Statut PoE (Port)</div>
                <div class="kpi-value" style="font-size:15px;color:${/W \(Actif\)|[1-9]\d*(\.\d+)?\s*W/i.test(poe) ? "var(--green)" : "var(--text-secondary)"};">${esc(poe)}</div>
                <div class="kpi-sub">Dernière vue : ${esc((es.lastSeenTime || "Jamais").slice(0, 19).replace("T", " "))}</div>
              </div>
            </div>

            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding-top:6px;border-top:1px solid var(--border);">
              <strong style="font-size:12px;color:var(--text-secondary);">Groupes NAC :</strong>
              ${r.nacGroups.length
                ? r.nacGroups.map((gn) => `<span class="badge badge-purple">${esc(gn)}</span>`).join("")
                : `<span style="font-size:12px;color:var(--text-muted);">${r.searchedGroups ? "Aucun groupe NAC associé" : "Non analysé"}</span>`}
            </div>
            <details style="margin-top:8px;font-size:11.5px;color:var(--text-muted);">
              <summary style="cursor:pointer;">Détails bruts API (End-System &amp; Port)</summary>
              <div style="margin-top:6px;">${OpsViews.renderKeyValueTable({ ...es, ...(port ? { _port_matched: getPortDisplayName(port) || JSON.stringify(port) } : {}) })}</div>
            </details>
          </div>
        </div>`;
      }).join("")}
    `;

    const inp = viewport.querySelector("#loc-input");
    const btn = viewport.querySelector("#btn-loc-go");
    const trigger = () => executeLocate(viewport, inp.value);
    btn.addEventListener("click", trigger);
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter") trigger();
    });
    if (!locatorState.running && !locatorState.results.length) {
      inp.focus();
    }

    viewport.querySelectorAll("[data-loc-copy]").forEach((b) => {
      b.addEventListener("click", () => {
        const r = locatorState.results[Number(b.dataset.locCopy)];
        if (!r) return;
        const es = r.es || {};
        const sw = r.switchDev || {};
        const resolvedPort = formatResolvedPort(es, r.matchedPort);
        const txt = [
          `MAC: ${es.macAddress || "—"}`,
          `IP: ${es.ipAddress || "—"}`,
          `Utilisateur: ${es.username || es.userName || "—"} (${es.hostName || "—"})`,
          `Switch: ${sw.sysName || sw.deviceName || es.switchIP || es.switchIp || "—"} (${es.switchIP || es.switchIp || "—"})`,
          `Port: ${resolvedPort.display}${resolvedPort.subId ? ` (ID: ${resolvedPort.subId})` : ""}`,
          `VLAN: ${es.vlan || r.matchedPort?.vlan || "—"}`,
          `PoE: ${extractPoeDisplay(r.matchedPort)}`,
          `Groupes NAC: ${r.nacGroups.join(", ") || "Aucun"}`,
          `Profil: ${es.profile || es.policy || "—"} | Etat: ${es.state || "—"}`,
        ].join("\n");
        XIQApi.copyText(txt);
      });
    });

    viewport.querySelectorAll("[data-loc-reauth]").forEach((b) => {
      b.addEventListener("click", async () => {
        const mac = b.dataset.locReauth;
        const m = `mutation Reauth($mac: String!) { accessControl { reauthenticateEndSystem(input: { macAddress: $mac }) { status message } } }`;
        const r = await OpsViews.runOp(m, { mac }, "locator");
        XIQApi.toast(r.data?.accessControl?.reauthenticateEndSystem?.message || r.errors?.[0]?.message || "CoA envoyé.", r.ok ? "success" : "error");
      });
    });

    viewport.querySelectorAll("[data-loc-bl]").forEach((b) => {
      b.addEventListener("click", async () => {
        const mac = b.dataset.locBl;
        if (!confirm(`Placer ${mac} en Blacklist / Quarantaine ?`)) return;
        const mut = OpsViews.buildAdaptiveGroupMutation(indexed, "addMACToBlacklist", {
          value: mac,
          description: "Quarantaine via Localisateur Express",
        });
        const r = await OpsViews.runOp(mut.query, mut.variables, "locator");
        XIQApi.toast(r.data?.accessControl?.addMACToBlacklist?.message || r.errors?.[0]?.message || "Blacklisté.", r.ok ? "success" : "error");
      });
    });
  }

  async function renderLocator(viewport, initialQuery = null) {
    viewport.classList.remove("studio-mode");
    await OpsViews.getSchema();
    if (initialQuery && initialQuery.trim()) {
      await executeLocate(viewport, initialQuery.trim());
    } else {
      drawLocator(viewport);
    }
  }

  // =========================================================================
  // 2. IMPORT CSV EN MASSE -> GROUPE NAC CIBLE
  // =========================================================================
  function parseCsvMacLines(rawText) {
    const lines = String(rawText || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const valid = [];
    const invalid = [];
    const seen = new Set();
    let duplicatesSkipped = 0;

    lines.forEach((line, idx) => {
      // Auto-detect delimiter (; , tab)
      const delim = line.includes(";") ? ";" : line.includes("\t") ? "\t" : ",";
      const parts = line.split(delim).map((p) => p.trim().replace(/^"|"$/g, ""));
      const first = parts[0] || "";
      const desc = parts.slice(1).join(" - ").trim();

      // Skip common CSV header row
      if (idx === 0 && /^(mac|adresse|address|entry|value)/i.test(first)) {
        return;
      }

      const norm = OpsViews.normalizeMac(first);
      if (!norm) {
        invalid.push({ lineNum: idx + 1, raw: line, reason: "Format MAC invalide" });
        return;
      }
      if (seen.has(norm)) {
        duplicatesSkipped++;
        return;
      }
      seen.add(norm);
      valid.push({ mac: norm, description: desc });
    });

    return { valid, invalid, duplicatesSkipped };
  }

  function openBulkCsvImportModal(groupNames = [], onComplete = null) {
    let parsed = { valid: [], invalid: [], duplicatesSkipped: 0 };
    let running = false;
    let cancelled = false;
    let reportRows = [];

    XIQApi.showModal({
      title: "Import CSV en masse — Ajouter des MAC dans un groupe NAC",
      bodyHtml: `
        <div class="form-grid" style="margin-bottom:12px;">
          <div class="form-field full">
            <label>Groupe NAC cible *</label>
            <input id="csv-target-group" list="csv-groups-datalist" value="${esc(groupNames[0] || "")}" placeholder="Sélectionnez ou saisissez le nom exact du groupe NAC" />
            <datalist id="csv-groups-datalist">${groupNames.map((n) => `<option value="${esc(n)}"></option>`).join("")}</datalist>
          </div>
          <div class="form-field full">
            <label>Charger un fichier CSV / TXT ou coller vos lignes (<code>MAC;Description</code> ou <code>MAC,Description</code>)</label>
            <div style="display:flex;gap:8px;margin-bottom:6px;">
              <button class="btn btn-xs btn-secondary" id="btn-csv-pick-file">📂 Choisir un fichier .csv / .txt</button>
              <input type="file" id="csv-file-input" accept=".csv,.txt" style="display:none;" />
              <button class="btn btn-xs btn-ghost" id="btn-csv-sample">Insérer exemple</button>
            </div>
            <textarea id="csv-raw-text" rows="7" class="mono" placeholder="AA:BB:CC:11:22:33;Poste Bloc Operatoire 01&#10;AA-BB-CC-44-55-66;Moniteur Cardio Salle 4&#10;aabb.cc77.8899;Imprimante Accueil"></textarea>
          </div>
          <div class="form-field">
            <label class="checkbox-row"><input type="checkbox" id="csv-skip-existing" checked /> <span>Ignorer les MAC déjà présentes dans le groupe</span></label>
          </div>
          <div class="form-field">
            <label class="checkbox-row"><input type="checkbox" id="csv-dry-run" /> <span>Mode Simulation (Dry-Run, sans écriture)</span></label>
          </div>
        </div>
        <div id="csv-preview-box"></div>
        <div id="csv-progress-box" style="display:none;margin-top:10px;">
          <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:5px;">
            <span id="csv-prog-lbl">Import en cours...</span>
            <strong id="csv-prog-pct">0%</strong>
          </div>
          <div class="bar-track" style="height:9px;"><div class="bar-fill" id="csv-prog-bar" style="width:0%;"></div></div>
        </div>
        <div id="csv-log-box" style="margin-top:10px;max-height:170px;overflow-y:auto;"></div>
      `,
      footerHtml: `
        <button class="btn btn-ghost" id="btn-csv-cancel">Fermer</button>
        <button class="btn btn-secondary" id="btn-csv-export-report" style="display:none;">Exporter Rapport CSV</button>
        <button class="btn btn-primary" id="btn-csv-start">↑ Lancer l'import</button>
      `,
      onMount: () => {
        const rawEl = document.getElementById("csv-raw-text");
        const prevBox = document.getElementById("csv-preview-box");
        const fileInp = document.getElementById("csv-file-input");
        const startBtn = document.getElementById("btn-csv-start");
        const cancelBtn = document.getElementById("btn-csv-cancel");
        const expRepBtn = document.getElementById("btn-csv-export-report");

        const refreshPreview = () => {
          parsed = parseCsvMacLines(rawEl.value);
          prevBox.innerHTML = `
            <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;font-size:12px;">
              <span class="badge badge-green">${parsed.valid.length} MAC valide(s)</span>
              ${parsed.duplicatesSkipped ? `<span class="badge badge-amber">${parsed.duplicatesSkipped} doublon(s) CSV ignoré(s)</span>` : ""}
              ${parsed.invalid.length ? `<span class="badge badge-red">${parsed.invalid.length} ligne(s) invalide(s)</span>` : ""}
            </div>
            ${parsed.invalid.length ? `<div style="margin-top:6px;font-size:11.5px;color:var(--red);">Lignes ignorées : ${parsed.invalid.slice(0, 5).map((x) => `L${x.lineNum} (${esc(x.raw)})`).join(", ")}${parsed.invalid.length > 5 ? "…" : ""}</div>` : ""}
          `;
        };

        rawEl.addEventListener("input", refreshPreview);
        document.getElementById("btn-csv-pick-file").addEventListener("click", () => fileInp.click());
        fileInp.addEventListener("change", async (e) => {
          const f = e.target.files?.[0];
          if (!f) return;
          rawEl.value = await f.text();
          refreshPreview();
        });
        document.getElementById("btn-csv-sample").addEventListener("click", () => {
          rawEl.value = "MAC;Description\nAA:BB:CC:11:22:33;Poste Bureau 101\nAA-BB-CC-44-55-66;Terminal Biomed 02\naabb.cc77.8899;Imprimante Accueil";
          refreshPreview();
        });

        cancelBtn.addEventListener("click", () => {
          if (running) {
            cancelled = true;
            XIQApi.toast("Arrêt de l'import demandé...", "warn");
          } else {
            XIQApi.closeModal();
          }
        });

        expRepBtn.addEventListener("click", () => {
          XIQApi.exportFile(`xiqse-rapport-import-csv-${Date.now()}.csv`, XIQApi.rowsToCsv(reportRows));
        });

        startBtn.addEventListener("click", async () => {
          if (running) return;
          const groupName = document.getElementById("csv-target-group").value.trim();
          const skipExisting = document.getElementById("csv-skip-existing").checked;
          const dryRun = document.getElementById("csv-dry-run").checked;
          refreshPreview();
          if (!groupName) return XIQApi.toast("Veuillez indiquer le groupe NAC cible.", "warn");
          if (!parsed.valid.length) return XIQApi.toast("Aucune adresse MAC valide à importer.", "warn");
          if (!dryRun && !confirm(`Importer ${parsed.valid.length} adresse(s) MAC dans le groupe « ${groupName} » sur XIQ-SE ?`)) {
            return;
          }

          running = true;
          cancelled = false;
          reportRows = [];
          startBtn.disabled = true;
          cancelBtn.textContent = "Arrêter";
          document.getElementById("csv-progress-box").style.display = "block";
          const progLbl = document.getElementById("csv-prog-lbl");
          const progPct = document.getElementById("csv-prog-pct");
          const progBar = document.getElementById("csv-prog-bar");
          const logBox = document.getElementById("csv-log-box");
          logBox.innerHTML = "";

          const indexed = await OpsViews.getSchema();
          const existingSet = new Set();

          if (skipExisting) {
            progLbl.textContent = `Vérification des membres existants de « ${groupName} »...`;
            const curRes = await OpsViews.runAdaptive(
              indexed,
              ["accessControl"],
              ["group", "groupByName", "endSystemGroup"],
              {
                args: { name: groupName, groupName, group: groupName },
                preferredScalars: ["name", "values", "entries", "members"],
                nestedSpecs: [{ candidates: ["values", "entries", "members", "groupValues"], includeAllScalars: true }],
                includeAllScalars: true,
              },
              "mac_audit"
            );
            if (curRes.ok && curRes.data) {
              OpsViews.getGroupEntries(curRes.data).forEach((e) => {
                const nm = OpsViews.normalizeMac(e.raw);
                if (nm) existingSet.add(nm);
              });
            }
          }

          let okCnt = 0;
          let skipCnt = 0;
          let errCnt = 0;

          for (let i = 0; i < parsed.valid.length; i++) {
            if (cancelled) break;
            const item = parsed.valid[i];
            const pct = Math.round(((i + 1) / parsed.valid.length) * 100);
            progLbl.textContent = `${dryRun ? "[SIMULATION] " : ""}Traitement ${i + 1} / ${parsed.valid.length} : ${item.mac}`;
            progPct.textContent = `${pct}%`;
            progBar.style.width = `${pct}%`;

            if (skipExisting && existingSet.has(item.mac)) {
              skipCnt++;
              reportRows.push({ MAC: item.mac, Description: item.description, Groupe: groupName, Resultat: "Déjà présent (ignoré)", Message: "" });
              continue;
            }

            if (dryRun) {
              okCnt++;
              reportRows.push({ MAC: item.mac, Description: item.description, Groupe: groupName, Resultat: "Simulation OK", Message: "Serait ajouté" });
              continue;
            }

            const mut = OpsViews.buildAdaptiveGroupMutation(indexed, "addMACToEndSystemGroup", {
              groupName,
              value: item.mac,
              description: item.description,
            });
            try {
              const r = await OpsViews.runOp(mut.query, mut.variables, "mac_audit");
              const resObj = r.data?.accessControl?.addMACToEndSystemGroup;
              const isSuccess = r.ok && (!resObj?.status || !/error|fail/i.test(String(resObj.status)));
              if (isSuccess) {
                okCnt++;
                reportRows.push({ MAC: item.mac, Description: item.description, Groupe: groupName, Resultat: "Ajouté", Message: resObj?.message || "OK" });
              } else {
                errCnt++;
                const msg = resObj?.message || r.errors?.[0]?.message || "Erreur inconnue";
                reportRows.push({ MAC: item.mac, Description: item.description, Groupe: groupName, Resultat: "Erreur", Message: msg });
              }
            } catch (err) {
              errCnt++;
              reportRows.push({ MAC: item.mac, Description: item.description, Groupe: groupName, Resultat: "Erreur", Message: err.message });
            }
          }

          running = false;
          startBtn.disabled = false;
          cancelBtn.textContent = "Fermer";
          expRepBtn.style.display = "inline-flex";

          logBox.innerHTML = `
            <div class="alert-banner ${errCnt ? "error" : ""}">
              <div><strong>Import ${dryRun ? "simulé" : "terminé"} :</strong> ${okCnt} ajouté(s) · ${skipCnt} déjà présent(s) · ${errCnt} erreur(s)</div>
            </div>
            ${OpsViews.renderDynamicTable(reportRows.slice(0, 50))}
          `;
          XIQApi.toast(`Import terminé : ${okCnt} ajouté(s), ${skipCnt} ignoré(s), ${errCnt} erreur(s).`, errCnt ? "warn" : "success");
          if (!dryRun && okCnt > 0 && onComplete) onComplete();
        });
      },
    });
  }

  // =========================================================================
  // 3. EXPORT / RAPPORT D'INVENTAIRE COMPLET (Switches, Séries, Firmwares, Ports Actifs)
  // =========================================================================
  function isPortActive(p) {
    const op = String(p?.operStatus ?? p?.status ?? p?.linkStatus ?? "").toLowerCase();
    return op === "up" || op === "1" || op === "active" || op === "connected" || op === "true";
  }

  function buildPrintableHtmlReport(summaryRows, portRows, serverLabel) {
    const totalDev = summaryRows.length;
    const upDev = summaryRows.filter((r) => r.Statut === "Up").length;
    const totalActivePorts = summaryRows.reduce((s, r) => s + (Number(r.Ports_Actifs) || 0), 0);
    const totalPoe = summaryRows.reduce((s, r) => s + (Number(r.PoE_Total_W) || 0), 0);
    const nowStr = new Date().toLocaleString("fr-FR");

    return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8" />
<title>Rapport Inventaire XIQ-SE — ${esc(serverLabel)}</title>
<style>
  body { font-family: "Segoe UI", Arial, sans-serif; color: #0f172a; margin: 28px; background: #fff; font-size: 12.5px; }
  h1 { margin: 0 0 4px; color: #1e1b4b; font-size: 22px; }
  .meta { color: #475569; margin-bottom: 18px; }
  .kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 22px; }
  .kpi { border: 1px solid #cbd5e1; border-radius: 8px; padding: 12px 14px; background: #f8fafc; }
  .kpi-lbl { font-size: 11px; text-transform: uppercase; color: #64748b; font-weight: 700; }
  .kpi-val { font-size: 24px; font-weight: 800; color: #1e1b4b; margin-top: 4px; }
  h2 { font-size: 15px; margin: 22px 0 8px; border-bottom: 2px solid #7c3aed; padding-bottom: 4px; color: #1e1b4b; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 18px; font-size: 11.5px; }
  th, td { border: 1px solid #e2e8f0; padding: 6px 8px; text-align: left; }
  th { background: #f1f5f9; font-weight: 700; color: #334155; }
  tr:nth-child(even) td { background: #f8fafc; }
  .up { color: #15803d; font-weight: 700; }
  .down { color: #dc2626; font-weight: 700; }
  .mono { font-family: Consolas, monospace; }
  @media print { body { margin: 12px; } .no-print { display: none; } }
</style>
</head>
<body>
  <div style="display:flex;justify-content:space-between;align-items:center;">
    <div>
      <h1>Rapport d'Inventaire Réseau — Extreme Networks XIQ-SE</h1>
      <div class="meta">Serveur : <strong>${esc(serverLabel)}</strong> · Généré le ${esc(nowStr)} par XIQ-SE API Studio</div>
    </div>
    <button class="no-print" onclick="window.print()" style="padding:8px 14px;background:#7c3aed;color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:700;">Imprimer / PDF</button>
  </div>

  <div class="kpis">
    <div class="kpi"><div class="kpi-lbl">Équipements Total</div><div class="kpi-val">${totalDev}</div></div>
    <div class="kpi"><div class="kpi-lbl">Équipements Up</div><div class="kpi-val" style="color:#15803d;">${upDev} / ${totalDev}</div></div>
    <div class="kpi"><div class="kpi-lbl">Ports Actifs</div><div class="kpi-val" style="color:#0284c7;">${totalActivePorts}</div></div>
    <div class="kpi"><div class="kpi-lbl">Puissance PoE Cumulée</div><div class="kpi-val" style="color:#7c3aed;">${totalPoe.toFixed(1)} W</div></div>
  </div>

  <h2>1. Inventaire des Équipements (${summaryRows.length})</h2>
  <table>
    <thead><tr><th>Statut</th><th>Nom</th><th>IP</th><th>Site</th><th>Modèle / Famille</th><th>N° Série</th><th>MAC</th><th>Firmware</th><th>Ports Actifs</th><th>PoE (W)</th></tr></thead>
    <tbody>
      ${summaryRows.map((r) => `<tr>
        <td class="${r.Statut === "Up" ? "up" : "down"}">${esc(r.Statut)}</td>
        <td><strong>${esc(r.Nom)}</strong></td>
        <td class="mono">${esc(r.IP)}</td>
        <td>${esc(r.Site)}</td>
        <td>${esc(r.Modele || r.Famille)}</td>
        <td class="mono">${esc(r.Numero_Serie)}</td>
        <td class="mono">${esc(r.MAC)}</td>
        <td class="mono">${esc(r.Firmware)}</td>
        <td class="mono">${esc(r.Ports_Actifs)} / ${esc(r.Ports_Total)}</td>
        <td class="mono">${esc(r.PoE_Total_W)} W</td>
      </tr>`).join("")}
    </tbody>
  </table>

  ${portRows.length ? `
  <h2>2. Détail des Ports Actifs (${portRows.length})</h2>
  <table>
    <thead><tr><th>Switch</th><th>IP Switch</th><th>Port</th><th>Alias</th><th>Vitesse</th><th>VLAN</th><th>PoE (W)</th></tr></thead>
    <tbody>
      ${portRows.slice(0, 3000).map((p) => `<tr>
        <td><strong>${esc(p.Switch)}</strong></td>
        <td class="mono">${esc(p.IP_Switch)}</td>
        <td class="mono">${esc(p.Port)}</td>
        <td>${esc(p.Alias)}</td>
        <td class="mono">${esc(p.Vitesse)}</td>
        <td class="mono">${esc(p.VLAN)}</td>
        <td class="mono">${esc(p.PoE_W)}</td>
      </tr>`).join("")}
    </tbody>
  </table>` : ""}
</body>
</html>`;
  }

  function openInventoryReportModal(cachedDevices = null) {
    let running = false;
    let cancelled = false;
    let summaryRows = [];
    let portRows = [];

    XIQApi.showModal({
      title: "Rapport d'Inventaire Complet (Switches, Séries, Firmwares & Ports Actifs)",
      bodyHtml: `
        <p style="font-size:12.5px;color:var(--text-secondary);margin-bottom:12px;">
          Collecte l'inventaire complet de tous les équipements (IP, nom, site, modèle, numéro de série, MAC, firmware, uptime) et interroge chaque switch pour recenser ses <strong>ports actifs</strong> et la consommation <strong>PoE</strong>.
        </p>
        <div style="margin-bottom:12px;">
          <label class="checkbox-row">
            <input type="checkbox" id="rep-include-ports" checked />
            <span>Collecter les ports actifs &amp; PoE de chaque équipement (recommandé)</span>
          </label>
        </div>
        <div id="rep-progress-box" style="display:none;margin-bottom:12px;">
          <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:5px;">
            <span id="rep-prog-lbl">Collecte en cours...</span>
            <strong id="rep-prog-pct">0%</strong>
          </div>
          <div class="bar-track" style="height:9px;"><div class="bar-fill" id="rep-prog-bar" style="width:0%;"></div></div>
        </div>
        <div id="rep-summary-box"></div>
      `,
      footerHtml: `
        <button class="btn btn-ghost" id="btn-rep-close">Fermer</button>
        <button class="btn btn-secondary" id="btn-rep-csv" style="display:none;">↓ CSV Équipements</button>
        <button class="btn btn-secondary" id="btn-rep-ports-csv" style="display:none;">↓ CSV Ports Actifs</button>
        <button class="btn btn-success" id="btn-rep-html" style="display:none;">↓ Rapport HTML / PDF</button>
        <button class="btn btn-primary" id="btn-rep-run">📋 Générer le rapport</button>
      `,
      onMount: () => {
        const runBtn = document.getElementById("btn-rep-run");
        const closeBtn = document.getElementById("btn-rep-close");
        const csvBtn = document.getElementById("btn-rep-csv");
        const pCsvBtn = document.getElementById("btn-rep-ports-csv");
        const htmlBtn = document.getElementById("btn-rep-html");
        const sumBox = document.getElementById("rep-summary-box");

        closeBtn.addEventListener("click", () => {
          if (running) cancelled = true;
          else XIQApi.closeModal();
        });

        csvBtn.addEventListener("click", () => {
          XIQApi.exportFile(`xiqse-inventaire-complet-${Date.now()}.csv`, XIQApi.rowsToCsv(summaryRows));
        });
        pCsvBtn.addEventListener("click", () => {
          XIQApi.exportFile(`xiqse-ports-actifs-${Date.now()}.csv`, XIQApi.rowsToCsv(portRows));
        });
        htmlBtn.addEventListener("click", () => {
          const prof = window.XIQApp?.getActiveProfile?.();
          const html = buildPrintableHtmlReport(summaryRows, portRows, prof?.name || "XIQ-SE");
          XIQApi.exportFile(`xiqse-rapport-inventaire-${Date.now()}.html`, html);
        });

        runBtn.addEventListener("click", async () => {
          if (running) return;
          running = true;
          cancelled = false;
          summaryRows = [];
          portRows = [];
          runBtn.disabled = true;
          closeBtn.textContent = "Arrêter";
          document.getElementById("rep-progress-box").style.display = "block";
          const progLbl = document.getElementById("rep-prog-lbl");
          const progPct = document.getElementById("rep-prog-pct");
          const progBar = document.getElementById("rep-prog-bar");
          const includePorts = document.getElementById("rep-include-ports").checked;

          const setProg = (txt, pct) => {
            progLbl.textContent = txt;
            progPct.textContent = `${pct}%`;
            progBar.style.width = `${pct}%`;
          };

          try {
            const indexed = await OpsViews.getSchema();
            let devices = Array.isArray(cachedDevices) && cachedDevices.length ? cachedDevices : [];
            if (!devices.length) {
              setProg("Récupération de la liste des équipements...", 8);
              const devRes = await OpsViews.runAdaptive(
                indexed,
                ["network"],
                ["devices", "allDevices"],
                {
                  preferredScalars: [
                    "ip", "sysName", "deviceName", "name", "baseMac", "macAddress",
                    "status", "up", "deviceDisplayFamily", "family", "firmware", "sitePath", "sysUpTime",
                  ],
                  nestedSpecs: [{ candidates: ["deviceData"], preferred: ["vendor", "serialNumber", "family", "subFamily"], includeAllScalars: true }],
                  includeAllScalars: false,
                },
                "mac_audit"
              );
              devices = Array.isArray(devRes.data) ? devRes.data : [];
            }

            const portsByIp = new Map();
            const extraByIp = new Map();

            if (includePorts && devices.length) {
              const netDom = SchemaTools.getDomainType(indexed, ["network"], "query");
              const devField = netDom ? SchemaTools.findFieldByCandidates(indexed, netDom.domainType, ["device", "deviceByIp"]) : null;
              const argName = devField?.args?.find((a) => /^(ip|ipaddress|deviceip)$/i.test(a.name))?.name || "ip";
              const retBase = devField ? SchemaTools.unwrapType(devField.type) : null;
              const portFields = discoverDevicePortFieldNames(indexed);
              const devSel = retBase
                ? SchemaTools.buildSafeSelection(
                    indexed,
                    retBase.name,
                    ["ip", "sysName", "firmware", "baseMac", "sysUpTime"],
                    [
                      { candidates: ["deviceData"], preferred: ["vendor", "serialNumber", "family", "subFamily"], includeAllScalars: true },
                      ...portFields.map((pf) => ({
                        candidates: [pf],
                        preferred: ["name", "ifName", "portName", "displayName", "ifIndex", "portIndex", "alias", "adminStatus", "operStatus", "portStatus", "status", "speed", "vlan", "poePowerWatts", "poePower"],
                        includeAllScalars: true,
                      })),
                    ],
                    false
                  )
                : "";

              const batchSize = 8;
              for (let i = 0; i < devices.length; i += batchSize) {
                if (cancelled) break;
                const chunk = devices.slice(i, i + batchSize);
                const pct = 15 + Math.round(((i + chunk.length) / devices.length) * 80);
                setProg(`Analyse des ports & numéros de série : ${i + chunk.length} / ${devices.length} équipements...`, Math.min(96, pct));

                if (devField && devSel) {
                  const lines = chunk
                    .map((d, idx) => `d${idx}: ${devField.name}(${argName}: ${JSON.stringify(d.ip)}) { ${devSel} }`)
                    .join("\n    ");
                  const q = `query BatchDeviceReport {\n  ${netDom.domainFieldName} {\n    ${lines}\n  }\n}`;
                  try {
                    const br = await OpsViews.runOp(q, {}, "mac_audit");
                    const nd = br?.data?.[netDom.domainFieldName];
                    if (br?.ok && nd) {
                      chunk.forEach((d, idx) => {
                        const det = nd[`d${idx}`];
                        if (!det) return;
                        extraByIp.set(d.ip, det);
                        portsByIp.set(d.ip, extractPortsArrayFromDevice(det));
                      });
                    }
                  } catch {
                    // non-fatal
                  }
                }
              }
            }

            setProg("Consolidation du rapport...", 99);
            devices.forEach((d) => {
              const det = extraByIp.get(d.ip) || {};
              const dd = det.deviceData || d.deviceData || {};
              const ports = portsByIp.get(d.ip) || d.interfaces || d.ports || [];
              const activePorts = Array.isArray(ports) ? ports.filter(isPortActive) : [];
              const poeTotal = activePorts.reduce((acc, p) => acc + (Number(p.poePowerWatts ?? p.poePower ?? 0) || 0), 0);
              const name = d.sysName || d.deviceName || d.name || d.ip;

              summaryRows.push({
                Statut: OpsViews.isDeviceUp(d) ? "Up" : "Down",
                Nom: name,
                IP: d.ip || "",
                Site: d.sitePath || "",
                Famille: d.deviceDisplayFamily || d.family || dd.family || "",
                Modele: dd.subFamily || d.deviceDisplayFamily || "",
                Numero_Serie: dd.serialNumber || d.serialNumber || "",
                MAC: d.baseMac || d.macAddress || det.baseMac || "",
                Firmware: d.firmware || det.firmware || "",
                Uptime: d.sysUpTime || det.sysUpTime || "",
                Ports_Actifs: activePorts.length,
                Ports_Total: Array.isArray(ports) ? ports.length : 0,
                PoE_Total_W: Number(poeTotal.toFixed(1)),
                Liste_Ports_Actifs: activePorts.map((p) => p.name || p.ifName || p.portName).filter(Boolean).slice(0, 48).join(", "),
              });

              activePorts.forEach((p) => {
                portRows.push({
                  Switch: name,
                  IP_Switch: d.ip || "",
                  Site: d.sitePath || "",
                  Port: p.name || p.ifName || p.portName || "",
                  Alias: p.alias || p.ifAlias || "",
                  Statut: p.operStatus || p.status || "Up",
                  Vitesse: p.speed || "",
                  VLAN: p.vlan || "",
                  PoE_W: p.poePowerWatts ?? p.poePower ?? "",
                });
              });
            });

            setProg("Rapport prêt !", 100);
            const totalActive = summaryRows.reduce((s, r) => s + r.Ports_Actifs, 0);
            const totalPoe = summaryRows.reduce((s, r) => s + r.PoE_Total_W, 0);
            sumBox.innerHTML = `
              <div class="alert-banner">
                <div><strong>Rapport généré :</strong> ${summaryRows.length} équipement(s) · <strong>${totalActive}</strong> port(s) actif(s) · <strong>${totalPoe.toFixed(1)} W</strong> PoE cumulés</div>
              </div>
              <div style="max-height:220px;overflow-y:auto;">
                ${OpsViews.renderDynamicTable(summaryRows.slice(0, 20).map((r) => ({
                  Nom: r.Nom, IP: r.IP, Statut: r.Statut, Serie: r.Numero_Serie, Firmware: r.Firmware, Ports: `${r.Ports_Actifs}/${r.Ports_Total}`, PoE: `${r.PoE_Total_W} W`,
                })))}
              </div>
            `;
            csvBtn.style.display = "inline-flex";
            if (portRows.length) pCsvBtn.style.display = "inline-flex";
            htmlBtn.style.display = "inline-flex";
          } catch (err) {
            XIQApi.toast(`Erreur rapport : ${err.message}`, "error");
          } finally {
            running = false;
            runBtn.disabled = false;
            closeBtn.textContent = "Fermer";
          }
        });
      },
    });
  }

  async function buildSwitchPortLookupMap(indexed, endSystemsList, onProgress = null) {
    const switchByIp = new Map();
    if (!indexed || !Array.isArray(endSystemsList) || !endSystemsList.length) return switchByIp;

    // Seed with known switch names/metadata from network.devices so sysName is ALWAYS resolved!
    const dirMap = await getDevicesDirectoryMap(indexed);
    dirMap.forEach((dev, ip) => switchByIp.set(ip, { ...dev }));

    // Collect unique switch IPs where End-System only has a numeric port ID (or no readable port name)
    const ipsSet = new Set();
    endSystemsList.forEach((es) => {
      if (!es) return;
      const swIp = es.switchIP || es.switchIp || "";
      if (!swIp) return;
      const { readable, rawId } = extractEndSystemPortCandidates(es);
      if (!readable && rawId) {
        ipsSet.add(swIp);
      }
    });

    const uniqueIps = Array.from(ipsSet);
    if (!uniqueIps.length) return switchByIp;

    const netDom = SchemaTools.getDomainType(indexed, ["network"], "query");
    const devField = netDom ? SchemaTools.findFieldByCandidates(indexed, netDom.domainType, ["device", "deviceByIp"]) : null;
    const argName = devField?.args?.find((a) => /^(ip|ipaddress|deviceip)$/i.test(a.name))?.name || "ip";
    const retBase = devField ? SchemaTools.unwrapType(devField.type) : null;
    const portFields = discoverDevicePortFieldNames(indexed);
    const devSel = retBase
      ? SchemaTools.buildSafeSelection(
          indexed,
          retBase.name,
          ["ip", "sysName", "deviceName", "id", "deviceId"],
          portFields.map((pf) => ({
            candidates: [pf],
            preferred: ["name", "ifName", "portName", "displayName", "ifDescr", "ifIndex", "portIndex", "id", "portId", "index", "portNumber"],
            includeAllScalars: false,
          })),
          false
        )
      : "";

    if (devField && devSel) {
      const batchSize = 10;
      for (let i = 0; i < uniqueIps.length; i += batchSize) {
        const chunk = uniqueIps.slice(i, i + batchSize);
        if (onProgress) onProgress(i + chunk.length, uniqueIps.length);
        const lines = chunk
          .map((ip, idx) => `d${idx}: ${devField.name}(${argName}: ${JSON.stringify(ip)}) { ${devSel} }`)
          .join("\n    ");
        const q = `query ResolveSwitchPorts {\n  ${netDom.domainFieldName} {\n    ${lines}\n  }\n}`;
        try {
          const br = await OpsViews.runOp(q, {}, "mac_audit");
          const nd = br?.data?.[netDom.domainFieldName];
          if (br?.ok && nd) {
            chunk.forEach((ip, idx) => {
              if (nd[`d${idx}`]) {
                switchByIp.set(ip, { ...(switchByIp.get(ip) || {}), ...nd[`d${idx}`] });
              }
            });
          }
        } catch {
          // non-fatal
        }
      }
    }

    // Fallback: if Device had no inline ports, check dedicated network.ports / devicePorts query
    const missingPortsIps = uniqueIps.filter((ip) => !extractPortsArrayFromDevice(switchByIp.get(ip)).length);
    if (missingPortsIps.length && netDom) {
      const pField = SchemaTools.findFieldByCandidates(indexed, netDom.domainType, [
        "ports", "devicePorts", "interfaces", "deviceInterfaces", "portsByDevice", "portData",
      ]);
      if (pField) {
        const pArg = pField.args?.find((a) => /^(ip|ipaddress|deviceip)$/i.test(a.name))?.name;
        const pBase = SchemaTools.unwrapType(pField.type);
        const pSel = pBase
          ? SchemaTools.buildSafeSelection(
              indexed,
              pBase.name,
              ["name", "ifName", "portName", "displayName", "ifDescr", "ifIndex", "portIndex", "id", "portId", "index", "portNumber"],
              [],
              false
            )
          : "";
        if (pArg && pSel) {
          const batchSize = 10;
          for (let i = 0; i < missingPortsIps.length; i += batchSize) {
            const chunk = missingPortsIps.slice(i, i + batchSize);
            const lines = chunk
              .map((ip, idx) => `p${idx}: ${pField.name}(${pArg}: ${JSON.stringify(ip)}) { ${pSel} }`)
              .join("\n    ");
            const q = `query ResolveSwitchPortsAlt {\n  ${netDom.domainFieldName} {\n    ${lines}\n  }\n}`;
            try {
              const br = await OpsViews.runOp(q, {}, "mac_audit");
              const nd = br?.data?.[netDom.domainFieldName];
              if (br?.ok && nd) {
                chunk.forEach((ip, idx) => {
                  const arr = nd[`p${idx}`];
                  if (Array.isArray(arr) && arr.length) {
                    const prev = switchByIp.get(ip) || { ip };
                    switchByIp.set(ip, { ...prev, ports: arr });
                  }
                });
              }
            } catch {
              // non-fatal
            }
          }
        }
      }
    }

    return switchByIp;
  }

  function resolveEndSystemPortDisplay(es, switchByIp) {
    if (!es) return "";
    const swIp = es.switchIP || es.switchIp || "";
    const swDev = swIp && switchByIp ? switchByIp.get(swIp) : null;
    const matched = swDev ? matchPortOnSwitch(swDev, es) : null;
    const resolved = formatResolvedPort(es, matched);
    return resolved.display === "—" ? "" : resolved.display;
  }

  return {
    renderLocator,
    openBulkCsvImportModal,
    openInventoryReportModal,
    buildSwitchPortLookupMap,
    resolveEndSystemPortDisplay,
    getDevicesDirectoryMap,
    getSwitchDisplayName,
    matchPortOnSwitch,
    formatResolvedPort,
  };
})();
