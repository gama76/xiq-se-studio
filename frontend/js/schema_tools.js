/* GraphQL Introspection Schema Parser, Adaptive Query Builder & Result Flattener */

window.SchemaTools = (() => {
  let cachedIndexedSchema = null;
  let cachedProfileId = null;
  let cachedSourceLabel = "Non chargé";

  function unwrapType(typeRef) {
    let cur = typeRef;
    while (cur && cur.ofType) {
      cur = cur.ofType;
    }
    return cur || { name: "String", kind: "SCALAR" };
  }

  function isListType(typeRef) {
    let cur = typeRef;
    while (cur) {
      if (cur.kind === "LIST") return true;
      cur = cur.ofType;
    }
    return false;
  }

  function isNonNull(typeRef) {
    return Boolean(typeRef && typeRef.kind === "NON_NULL");
  }

  function formatTypeRef(typeRef) {
    if (!typeRef) return "Unknown";
    if (typeRef.kind === "NON_NULL") return `${formatTypeRef(typeRef.ofType)}!`;
    if (typeRef.kind === "LIST") return `[${formatTypeRef(typeRef.ofType)}]`;
    return typeRef.name || "Unknown";
  }

  function indexSchema(schema) {
    if (!schema || !Array.isArray(schema.types)) return null;
    const typeMap = {};
    schema.types.forEach((t) => {
      if (t && t.name) typeMap[t.name] = t;
    });

    const queryRootName = schema.queryType?.name || "Query";
    const mutationRootName = schema.mutationType?.name || "Mutation";
    const queryRoot = typeMap[queryRootName] || null;
    const mutationRoot = typeMap[mutationRootName] || null;

    function collectOperations(rootType, opType) {
      if (!rootType || !Array.isArray(rootType.fields)) return [];
      const groups = [];
      for (const topField of rootType.fields) {
        if (topField.name.startsWith("__")) continue;
        const unwrapped = unwrapType(topField.type);
        const childType = typeMap[unwrapped.name];
        if (
          childType &&
          childType.kind === "OBJECT" &&
          Array.isArray(childType.fields) &&
          (!topField.args || topField.args.length === 0)
        ) {
          groups.push({
            domain: topField.name,
            description: topField.description || childType.description || "",
            opType,
            fields: childType.fields.map((f) => ({
              ...f,
              path: [topField.name, f.name],
              opType,
            })),
          });
        } else {
          let rootGrp = groups.find((g) => g.domain === "(Racine)");
          if (!rootGrp) {
            rootGrp = { domain: "(Racine)", description: "Champs racines directs", opType, fields: [] };
            groups.unshift(rootGrp);
          }
          rootGrp.fields.push({
            ...topField,
            path: [topField.name],
            opType,
          });
        }
      }
      return groups;
    }

    const queryGroups = collectOperations(queryRoot, "query");
    const mutationGroups = collectOperations(mutationRoot, "mutation");
    const userTypes = schema.types
      .filter((t) => t.name && !t.name.startsWith("__"))
      .sort((a, b) => a.name.localeCompare(b.name));

    return {
      raw: schema,
      typeMap,
      queryRoot,
      mutationRoot,
      queryGroups,
      mutationGroups,
      userTypes,
      counts: {
        queries: queryGroups.reduce((acc, g) => acc + g.fields.length, 0),
        mutations: mutationGroups.reduce((acc, g) => acc + g.fields.length, 0),
        types: userTypes.length,
      },
    };
  }

  // ---- Shared Live Schema Cache ----

  function clearSchemaCache() {
    cachedIndexedSchema = null;
    cachedProfileId = null;
    cachedSourceLabel = "Non chargé";
  }

  function setCachedSchema(schemaObj, profileId, sourceLabel) {
    cachedIndexedSchema = indexSchema(schemaObj);
    cachedProfileId = profileId || null;
    cachedSourceLabel = sourceLabel || "Schéma chargé";
    return cachedIndexedSchema;
  }

  function getCachedSchemaInfo() {
    return {
      indexed: cachedIndexedSchema,
      profileId: cachedProfileId,
      sourceLabel: cachedSourceLabel,
    };
  }

  async function ensureLiveSchema(profileId, forceRefresh = false) {
    if (!forceRefresh && cachedIndexedSchema && cachedProfileId === profileId) {
      return { indexed: cachedIndexedSchema, sourceLabel: cachedSourceLabel, ok: true };
    }
    try {
      const res = await XIQApi.introspectSchema();
      if (res.ok && res.schema) {
        const label =
          res.source === "demo-introspection"
            ? "Simulateur XIQ-SE (Démo)"
            : `Introspection Live (${res.duration_ms} ms)`;
        setCachedSchema(res.schema, profileId, label);
        return { indexed: cachedIndexedSchema, sourceLabel: label, ok: true };
      }
      if (res.cached_schema) {
        setCachedSchema(res.cached_schema, profileId, "Schéma importé (cache local)");
        return { indexed: cachedIndexedSchema, sourceLabel: cachedSourceLabel, ok: true };
      }
      const imp = await XIQApi.getImportedSchema().catch(() => ({ schema: null }));
      if (imp.schema) {
        setCachedSchema(imp.schema, profileId, "Schéma NBI JSON importé");
        return { indexed: cachedIndexedSchema, sourceLabel: cachedSourceLabel, ok: true };
      }
      return {
        indexed: null,
        sourceLabel: "Indisponible",
        ok: false,
        error: res.errors?.[0]?.message || "Introspection impossible",
      };
    } catch (err) {
      return { indexed: null, sourceLabel: "Erreur", ok: false, error: err.message };
    }
  }

  // ---- Schema Introspection Helpers for Adaptive Queries ----

  function getType(indexed, typeName) {
    return indexed?.typeMap?.[typeName] || null;
  }

  function getFieldDef(indexed, typeObjOrName, fieldName) {
    const t = typeof typeObjOrName === "string" ? getType(indexed, typeObjOrName) : typeObjOrName;
    if (!t || !Array.isArray(t.fields)) return null;
    return t.fields.find((f) => f.name === fieldName) || null;
  }

  function findFieldByCandidates(indexed, typeObjOrName, candidates) {
    const t = typeof typeObjOrName === "string" ? getType(indexed, typeObjOrName) : typeObjOrName;
    if (!t || !Array.isArray(t.fields)) return null;
    // Exact match in preference order
    for (const c of candidates) {
      const exact = t.fields.find((f) => f.name === c);
      if (exact) return exact;
    }
    // Case-insensitive match
    for (const c of candidates) {
      const ci = t.fields.find((f) => f.name.toLowerCase() === c.toLowerCase());
      if (ci) return ci;
    }
    return null;
  }

  function getDomainType(indexed, domainCandidates, opType = "query") {
    if (!indexed) return null;
    const root = opType === "mutation" ? indexed.mutationRoot : indexed.queryRoot;
    if (!root) return null;
    const domainField = findFieldByCandidates(indexed, root, domainCandidates);
    if (!domainField) return null;
    const base = unwrapType(domainField.type);
    const domainType = getType(indexed, base.name);
    return { domainFieldName: domainField.name, domainField, domainType };
  }

  function isScalarOrEnum(indexed, typeRef) {
    const base = unwrapType(typeRef);
    const t = getType(indexed, base.name);
    return !t || t.kind === "SCALAR" || t.kind === "ENUM";
  }

  /**
   * Build safe selection block for an object type, ONLY choosing fields that actually exist!
   * preferredScalars: scalar field names to prioritize
   * nestedSpecs: [{ candidates: [...], preferred: [...] }] optional nested object selections
   */
  function buildSafeSelection(indexed, typeName, preferredScalars = [], nestedSpecs = [], includeAllScalars = false) {
    const t = getType(indexed, typeName);
    if (!t || !Array.isArray(t.fields)) return "";
    const chosen = new Set();
    const lines = [];

    const addScalar = (f) => {
      if (!f || chosen.has(f.name)) return;
      if (f.name.startsWith("__")) return;
      // Avoid fields with required args in simple selections
      if ((f.args || []).some((a) => isNonNull(a.type))) return;
      if (isScalarOrEnum(indexed, f.type)) {
        chosen.add(f.name);
        lines.push(f.name);
      }
    };

    preferredScalars.forEach((name) => {
      const f = findFieldByCandidates(indexed, t, [name]);
      if (f) addScalar(f);
    });

    if (includeAllScalars || lines.length === 0) {
      t.fields.forEach((f) => {
        if (lines.length < 22) addScalar(f);
      });
    }

    for (const spec of nestedSpecs) {
      const nf = findFieldByCandidates(indexed, t, spec.candidates || []);
      if (!nf || chosen.has(nf.name)) continue;
      if ((nf.args || []).some((a) => isNonNull(a.type))) continue;
      const nBase = unwrapType(nf.type);
      const nType = getType(indexed, nBase.name);
      if (nType && nType.kind === "OBJECT") {
        const subSel = buildSafeSelection(
          indexed,
          nType.name,
          spec.preferred || [],
          [],
          Boolean(spec.includeAllScalars)
        );
        if (subSel) {
          chosen.add(nf.name);
          lines.push(`${nf.name} { ${subSel} }`);
        }
      } else if (isScalarOrEnum(indexed, nf.type)) {
        addScalar(nf);
      }
    }

    return lines.join(" ");
  }

  function toGraphQLValue(val) {
    if (val === null || val === undefined) return "null";
    if (Array.isArray(val)) return `[${val.map(toGraphQLValue).join(", ")}]`;
    if (typeof val === "object") {
      const entries = Object.entries(val)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `${k}: ${toGraphQLValue(v)}`);
      return `{ ${entries.join(", ")} }`;
    }
    return JSON.stringify(val);
  }

  /**
   * Build safe argument string for a field that may take optional pagination args (maxResults/firstResult/pageNumber/etc.)
   * or specific provided args. Returns null if field has unsatisfied NON_NULL arguments!
   */
  function buildSafeArgs(fieldDef, providedArgs = {}, timeWindowDays = 7) {
    const args = fieldDef?.args || [];
    if (!args.length) return "";
    const parts = [];
    const nowMs = Date.now();
    const startMs = nowMs - timeWindowDays * 86400 * 1000;

    for (const arg of args) {
      const aname = arg.name;
      const lower = aname.toLowerCase();
      if (providedArgs[aname] !== undefined) {
        parts.push(`${aname}: ${toGraphQLValue(providedArgs[aname])}`);
        continue;
      }
      // Common XIQ-SE pagination arguments
      if (lower === "maxresults" || lower === "limit" || lower === "pagesize" || lower === "count" || lower === "maxcount" || lower === "numresults") {
        parts.push(`${aname}: 250`);
        continue;
      }
      if (lower === "pagenumber" || lower === "pageno") {
        parts.push(`${aname}: 1`);
        continue;
      }
      if (lower === "firstresult" || lower === "offset" || lower === "startindex" || lower === "page" || lower === "pageindex" || lower === "skip") {
        parts.push(`${aname}: 0`);
        continue;
      }
      // Common XIQ-SE time-range arguments for alarms/events/logs
      const baseType = unwrapType(arg.type)?.name || "String";
      const isNumType = /^(int|long|float|number|biginteger)$/i.test(baseType);
      if (/^(starttime|begintime|fromtime|startdate|from|since|start)$/i.test(lower)) {
        parts.push(`${aname}: ${isNumType ? startMs : JSON.stringify(new Date(startMs).toISOString())}`);
        continue;
      }
      if (/^(endtime|totime|enddate|to|until|end)$/i.test(lower)) {
        parts.push(`${aname}: ${isNumType ? nowMs : JSON.stringify(new Date(nowMs).toISOString())}`);
        continue;
      }
      if (isNonNull(arg.type)) {
        // Cannot call this field safely without an explicit argument
        return null;
      }
    }

    return parts.length ? `(${parts.join(", ")})` : "";
  }

  function findAllFieldsMatching(indexed, regex, opType = "query") {
    if (!indexed) return [];
    const groups = opType === "mutation" ? (indexed.mutationGroups || []) : (indexed.queryGroups || []);
    const matches = [];
    for (const g of groups) {
      const domMatch = regex.test(g.domain);
      for (const f of g.fields || []) {
        if (domMatch || regex.test(f.name) || regex.test(f.description || "")) {
          matches.push({
            domainName: g.domain,
            field: f,
            callable: buildSafeArgs(f, {}) !== null,
            opItem: { ...f, path: g.domain === "(Racine)" ? [f.name] : [g.domain, f.name], opType },
          });
        }
      }
    }
    return matches;
  }

  /**
   * Smart adaptive query builder for a domain + candidate field names.
   * Automatically handles wrapper types like WsEndSystemListResult -> { endSystem { ... } }!
   */
  function buildAdaptiveDomainQuery(indexed, domainCandidates, fieldCandidates, opts = {}) {
    const dom = getDomainType(indexed, domainCandidates, "query");
    if (!dom || !dom.domainType) return null;

    const fieldDef = findFieldByCandidates(indexed, dom.domainType, fieldCandidates);
    if (!fieldDef) return null;

    const argsStr = buildSafeArgs(fieldDef, opts.args || {}, opts.timeWindowDays || 7);
    if (argsStr === null) return null;

    const retBase = unwrapType(fieldDef.type);
    const retType = getType(indexed, retBase.name);

    // Scalar or list of scalars
    if (!retType || retType.kind === "SCALAR" || retType.kind === "ENUM") {
      return {
        domainName: dom.domainFieldName,
        fieldName: fieldDef.name,
        wrapperListField: null,
        query: `query { ${dom.domainFieldName} { ${fieldDef.name}${argsStr} } }`,
      };
    }

    // Check if return type is a wrapper object (like WsEndSystemListResult) containing a list field
    let wrapperListField = null;
    let selection = "";

    if (!isListType(fieldDef.type) && retType.kind === "OBJECT" && Array.isArray(retType.fields)) {
      const listCandidate =
        (opts.wrapperCandidates && findFieldByCandidates(indexed, retType, opts.wrapperCandidates)) ||
        retType.fields.find((f) => isListType(f.type) && !isScalarOrEnum(indexed, f.type) && !(f.args || []).some((a) => isNonNull(a.type)));

      if (listCandidate) {
        wrapperListField = listCandidate.name;
        const itemBase = unwrapType(listCandidate.type);
        const itemSel = buildSafeSelection(
          indexed,
          itemBase.name,
          opts.preferredScalars || [],
          opts.nestedSpecs || [],
          opts.includeAllScalars !== false
        );
        const metaScalars = buildSafeSelection(indexed, retType.name, ["success", "status", "errorMessage", "message", "totalCount", "count"], [], false);
        selection = [metaScalars, itemSel ? `${listCandidate.name} { ${itemSel} }` : ""].filter(Boolean).join(" ");
      }
    }

    if (!selection) {
      selection = buildSafeSelection(
        indexed,
        retType.name,
        opts.preferredScalars || [],
        opts.nestedSpecs || [],
        opts.includeAllScalars !== false
      );
    }

    if (!selection) return null;

    return {
      domainName: dom.domainFieldName,
      fieldName: fieldDef.name,
      wrapperListField,
      query: `query {\n  ${dom.domainFieldName} {\n    ${fieldDef.name}${argsStr} {\n      ${selection}\n    }\n  }\n}`,
    };
  }

  /**
   * Extract list or object payload returned by buildAdaptiveDomainQuery.
   */
  function extractAdaptiveData(res, meta) {
    if (!res || !res.data || !meta) return null;
    const domObj = res.data[meta.domainName];
    if (!domObj) return null;
    const val = domObj[meta.fieldName];
    if (val === null || val === undefined) return null;
    if (meta.wrapperListField && typeof val === "object" && !Array.isArray(val)) {
      return val[meta.wrapperListField] ?? [];
    }
    return val;
  }

  /**
   * Discover all zero-required-arg query fields inside a given domain (for auto-populating any domain screen).
   */
  function listCallableDomainQueries(indexed, domainCandidates) {
    const dom = getDomainType(indexed, domainCandidates, "query");
    if (!dom || !dom.domainType || !Array.isArray(dom.domainType.fields)) return [];
    return dom.domainType.fields
      .filter((f) => !f.name.startsWith("__"))
      .map((f) => ({
        domainName: dom.domainFieldName,
        field: f,
        callableWithoutRequiredArgs: buildSafeArgs(f, {}) !== null,
        opItem: { ...f, path: [dom.domainFieldName, f.name], opType: "query" },
      }));
  }

  function listDomainMutations(indexed, domainCandidates) {
    const dom = getDomainType(indexed, domainCandidates, "mutation");
    if (!dom || !dom.domainType || !Array.isArray(dom.domainType.fields)) return [];
    return dom.domainType.fields
      .filter((f) => !f.name.startsWith("__"))
      .map((f) => ({
        domainName: dom.domainFieldName,
        field: f,
        opItem: { ...f, path: [dom.domainFieldName, f.name], opType: "mutation" },
      }));
  }

  // ---- Studio Query Snippet Auto-Generator ----

  function defaultValueForType(typeRef, typeMap, depth = 0) {
    if (!typeRef || depth > 3) return "";
    if (typeRef.kind === "NON_NULL") return defaultValueForType(typeRef.ofType, typeMap, depth);
    if (typeRef.kind === "LIST") return [defaultValueForType(typeRef.ofType, typeMap, depth + 1)];
    const t = typeMap[typeRef.name];
    if (t && t.kind === "INPUT_OBJECT" && Array.isArray(t.inputFields)) {
      const obj = {};
      t.inputFields.forEach((f) => {
        obj[f.name] = defaultValueForType(f.type, typeMap, depth + 1);
      });
      return obj;
    }
    if (t && t.kind === "ENUM" && Array.isArray(t.enumValues) && t.enumValues.length) {
      return t.enumValues[0].name;
    }
    switch (typeRef.name) {
      case "Int":
        return 10;
      case "Float":
        return 1.0;
      case "Boolean":
        return true;
      default:
        return "";
    }
  }

  function buildSelectionLines(typeRef, typeMap, indent = "      ", depth = 0) {
    const base = unwrapType(typeRef);
    const t = typeMap[base.name];
    if (!t || (t.kind !== "OBJECT" && t.kind !== "INTERFACE") || !Array.isArray(t.fields)) {
      return "";
    }
    const lines = [];
    for (const f of t.fields) {
      if (f.name.startsWith("__")) continue;
      if ((f.args || []).some((a) => isNonNull(a.type))) continue;
      const fBase = unwrapType(f.type);
      const fType = typeMap[fBase.name];
      if (!fType || fType.kind === "SCALAR" || fType.kind === "ENUM") {
        lines.push(`${indent}${f.name}`);
      } else if (depth < 1 && fType.kind === "OBJECT" && Array.isArray(fType.fields)) {
        const subLines = fType.fields
          .filter((sf) => {
            if ((sf.args || []).some((a) => isNonNull(a.type))) return false;
            const sb = unwrapType(sf.type);
            const st = typeMap[sb.name];
            return !st || st.kind === "SCALAR" || st.kind === "ENUM";
          })
          .slice(0, 10)
          .map((sf) => `${indent}  ${sf.name}`);
        if (subLines.length) {
          lines.push(`${indent}${f.name} {\n${subLines.join("\n")}\n${indent}}`);
        }
      }
      if (lines.length >= 18) break;
    }
    return lines.join("\n");
  }

  function buildOperationSnippet(indexedSchema, fieldItem) {
    const { typeMap } = indexedSchema;
    const opType = fieldItem.opType || "query";
    const path = fieldItem.path || [fieldItem.name];
    const args = fieldItem.args || [];

    const varDecls = [];
    const argBindings = [];
    const sampleVars = {};

    args.forEach((arg) => {
      const formatted = formatTypeRef(arg.type);
      varDecls.push(`$${arg.name}: ${formatted}`);
      argBindings.push(`${arg.name}: $${arg.name}`);
      sampleVars[arg.name] = defaultValueForType(arg.type, typeMap, 0);
    });

    const opName = `${opType === "mutation" ? "Mut" : "Get"}_${fieldItem.name}`;
    const header = varDecls.length
      ? `${opType} ${opName}(${varDecls.join(", ")})`
      : `${opType} ${opName}`;

    const leafCall = argBindings.length
      ? `${fieldItem.name}(${argBindings.join(", ")})`
      : fieldItem.name;

    const indentStep = path.length === 2 ? "      " : "    ";
    const selLines = buildSelectionLines(fieldItem.type, typeMap, indentStep, 0);
    const leafBlock = selLines ? `${leafCall} {\n${selLines}\n${indentStep.slice(2)}}` : leafCall;

    let body;
    if (path.length === 2) {
      body = `  ${path[0]} {\n    ${leafBlock}\n  }`;
    } else {
      body = `  ${leafBlock}`;
    }

    return {
      query: `${header} {\n${body}\n}`,
      variables: sampleVars,
    };
  }

  function flattenObject(obj, prefix = "") {
    const out = {};
    if (!obj || typeof obj !== "object") return { value: obj };
    for (const [k, v] of Object.entries(obj)) {
      const key = prefix ? `${prefix}.${k}` : k;
      if (v === null || v === undefined) {
        out[key] = "";
      } else if (Array.isArray(v)) {
        out[key] = v.length && typeof v[0] === "object" ? `[${v.length} éléments]` : v.join(", ");
      } else if (typeof v === "object") {
        Object.assign(out, flattenObject(v, key));
      } else {
        out[key] = v;
      }
    }
    return out;
  }

  function extractTableRows(data) {
    if (!data || typeof data !== "object") return [];
    const queue = [data];
    while (queue.length) {
      const cur = queue.shift();
      if (Array.isArray(cur)) {
        if (cur.length && typeof cur[0] === "object" && cur[0] !== null) {
          return cur.map((item) => flattenObject(item));
        }
        if (cur.length) {
          return cur.map((v, idx) => ({ index: idx + 1, valeur: v }));
        }
      } else if (cur && typeof cur === "object") {
        for (const val of Object.values(cur)) {
          if (val && typeof val === "object") queue.push(val);
        }
      }
    }
    return [flattenObject(data)];
  }

  return {
    unwrapType,
    isListType,
    isNonNull,
    formatTypeRef,
    indexSchema,
    clearSchemaCache,
    setCachedSchema,
    getCachedSchemaInfo,
    ensureLiveSchema,
    getType,
    getFieldDef,
    findFieldByCandidates,
    getDomainType,
    buildSafeSelection,
    buildSafeArgs,
    buildAdaptiveDomainQuery,
    extractAdaptiveData,
    listCallableDomainQueries,
    listDomainMutations,
    findAllFieldsMatching,
    buildOperationSnippet,
    extractTableRows,
  };
})();
