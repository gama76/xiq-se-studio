"""Stateful XIQ-SE GraphQL NBI Simulator (Demo Mode) with full __schema introspection."""

import copy
import json
import re
import time
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple


# ---- Lightweight GraphQL Parser for Demo Mode ----

TOKEN_RE = re.compile(
    r"""
    (?P<WS>\s+|,+)
    |(?P<COMMENT>\#[^\n]*)
    |(?P<STRING>"(?:\\.|[^"\\])*")
    |(?P<FLOAT>-?\d+\.\d+)
    |(?P<INT>-?\d+)
    |(?P<PUNCT>[{}\(\)\[\]:!\$@\.=])
    |(?P<NAME>[_A-Za-z][_0-9A-Za-z]*)
    """,
    re.VERBOSE,
)


def _tokenize(src: str) -> List[Tuple[str, str]]:
    tokens: List[Tuple[str, str]] = []
    pos = 0
    while pos < len(src):
        m = TOKEN_RE.match(src, pos)
        if not m:
            pos += 1
            continue
        kind = m.lastgroup
        val = m.group()
        pos = m.end()
        if kind in ("WS", "COMMENT"):
            continue
        tokens.append((kind or "UNKNOWN", val))
    return tokens


class _GQLParser:
    def __init__(self, src: str, variables: Optional[Dict[str, Any]] = None) -> None:
        self.tokens = _tokenize(src)
        self.pos = 0
        self.variables = variables or {}

    def peek(self, offset: int = 0) -> Optional[Tuple[str, str]]:
        idx = self.pos + offset
        return self.tokens[idx] if 0 <= idx < len(self.tokens) else None

    def next(self) -> Optional[Tuple[str, str]]:
        tok = self.peek()
        if tok is not None:
            self.pos += 1
        return tok

    def match(self, val: str) -> bool:
        tok = self.peek()
        if tok and tok[1] == val:
            self.pos += 1
            return True
        return False

    def parse_document(self) -> Tuple[str, List[Dict[str, Any]]]:
        op_type = "query"
        tok = self.peek()
        if tok and tok[0] == "NAME" and tok[1] in ("query", "mutation", "subscription"):
            op_type = tok[1]
            self.next()
            # Optional operation name
            if self.peek() and self.peek()[0] == "NAME":
                self.next()
            # Optional variable definitions (...)
            if self.match("("):
                depth = 1
                while depth > 0 and self.peek():
                    t = self.next()
                    if t[1] == "(":
                        depth += 1
                    elif t[1] == ")":
                        depth -= 1
        selections = self.parse_selection_set()
        return op_type, selections

    def parse_selection_set(self) -> List[Dict[str, Any]]:
        if not self.match("{"):
            return []
        fields: List[Dict[str, Any]] = []
        while self.peek() and self.peek()[1] != "}":
            # Skip inline/named fragment spreads gracefully
            if self.peek()[1] == ".":
                while self.peek() and self.peek()[1] == ".":
                    self.next()
                if self.peek() and self.peek()[0] == "NAME":
                    if self.peek()[1] == "on":
                        self.next()
                        if self.peek():
                            self.next()
                        fields.extend(self.parse_selection_set())
                    else:
                        self.next()
                continue
            tok = self.next()
            if not tok or tok[0] != "NAME":
                break
            alias = tok[1]
            name = tok[1]
            if self.match(":"):
                name_tok = self.next()
                name = name_tok[1] if name_tok else name
            args: Dict[str, Any] = {}
            if self.match("("):
                while self.peek() and self.peek()[1] != ")":
                    k_tok = self.next()
                    if not k_tok:
                        break
                    self.match(":")
                    args[k_tok[1]] = self.parse_value()
                self.match(")")
            sub_sel: List[Dict[str, Any]] = []
            if self.peek() and self.peek()[1] == "{":
                sub_sel = self.parse_selection_set()
            fields.append({"alias": alias, "name": name, "args": args, "selections": sub_sel})
        self.match("}")
        return fields

    def parse_value(self) -> Any:
        tok = self.peek()
        if not tok:
            return None
        kind, val = tok
        if val == "$":
            self.next()
            vname = self.next()
            return self.variables.get(vname[1]) if vname else None
        if kind == "STRING":
            self.next()
            try:
                return json.loads(val)
            except Exception:
                return val.strip('"')
        if kind == "INT":
            self.next()
            return int(val)
        if kind == "FLOAT":
            self.next()
            return float(val)
        if kind == "NAME":
            self.next()
            if val == "true":
                return True
            if val == "false":
                return False
            if val == "null":
                return None
            return val
        if val == "[":
            self.next()
            arr = []
            while self.peek() and self.peek()[1] != "]":
                arr.append(self.parse_value())
            self.match("]")
            return arr
        if val == "{":
            self.next()
            obj: Dict[str, Any] = {}
            while self.peek() and self.peek()[1] != "}":
                k = self.next()
                if not k:
                    break
                self.match(":")
                obj[k[1]] = self.parse_value()
            self.match("}")
            return obj
        self.next()
        return val


def _project(obj: Any, selections: List[Dict[str, Any]]) -> Any:
    """Recursively project a Python dict/list according to a GraphQL selection set."""
    if not selections:
        return obj
    if isinstance(obj, list):
        return [_project(item, selections) for item in obj]
    if isinstance(obj, dict):
        out: Dict[str, Any] = {}
        for sel in selections:
            fname = sel["name"]
            alias = sel["alias"]
            if fname == "__typename":
                out[alias] = obj.get("__typename", "Object")
                continue
            val = obj.get(fname)
            out[alias] = _project(val, sel["selections"]) if sel["selections"] else val
        return out
    return obj


# ---- Schema Builder Helpers for __schema Introspection ----

def _tref(name: str, kind: str = "SCALAR") -> Dict[str, Any]:
    return {"kind": kind, "name": name, "ofType": None}


def _non_null(inner: Dict[str, Any]) -> Dict[str, Any]:
    return {"kind": "NON_NULL", "name": None, "ofType": inner}


def _list_of(inner: Dict[str, Any]) -> Dict[str, Any]:
    return {"kind": "LIST", "name": None, "ofType": inner}


def _field(
    name: str,
    ftype: Dict[str, Any],
    desc: str = "",
    args: Optional[List[Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    return {
        "name": name,
        "description": desc,
        "args": args or [],
        "type": ftype,
        "isDeprecated": False,
        "deprecationReason": None,
    }


def _arg(name: str, atype: Dict[str, Any], desc: str = "", default: Any = None) -> Dict[str, Any]:
    return {"name": name, "description": desc, "type": atype, "defaultValue": default}


def _obj_type(name: str, desc: str, fields: List[Dict[str, Any]]) -> Dict[str, Any]:
    return {
        "kind": "OBJECT",
        "name": name,
        "description": desc,
        "fields": fields,
        "inputFields": None,
        "interfaces": [],
        "enumValues": None,
        "possibleTypes": None,
    }


def _input_type(name: str, desc: str, input_fields: List[Dict[str, Any]]) -> Dict[str, Any]:
    return {
        "kind": "INPUT_OBJECT",
        "name": name,
        "description": desc,
        "fields": None,
        "inputFields": input_fields,
        "interfaces": None,
        "enumValues": None,
        "possibleTypes": None,
    }


def _scalar_type(name: str, desc: str = "") -> Dict[str, Any]:
    return {
        "kind": "SCALAR",
        "name": name,
        "description": desc,
        "fields": None,
        "inputFields": None,
        "interfaces": None,
        "enumValues": None,
        "possibleTypes": None,
    }


def build_demo_schema() -> Dict[str, Any]:
    """Return a rich GraphQL Introspection __schema representing XIQ-SE NBI."""
    S = _tref("String")
    I = _tref("Int")
    F = _tref("Float")
    B = _tref("Boolean")

    types = [
        _scalar_type("String", "Chaîne de caractères UTF-8"),
        _scalar_type("Int", "Entier signé 32-bit"),
        _scalar_type("Float", "Nombre décimal double précision"),
        _scalar_type("Boolean", "Valeur booléenne true / false"),
        _scalar_type("ID", "Identifiant unique"),
        # Root Query & Mutation
        _obj_type(
            "Query",
            "Point d'entrée racine des requêtes de lecture de l'API NBI GraphQL XIQ-SE.",
            [
                _field("network", _tref("NetworkQuery", "OBJECT"), "Inventaire équipements, ports, sites, VLANs et topologie."),
                _field("accessControl", _tref("AccessControlQuery", "OBJECT"), "ExtremeControl (NAC) : engines, end-systems, groupes, MAC Lock, RADIUS."),
                _field("workflows", _tref("WorkflowsQuery", "OBJECT"), "Moteur d'automatisation Workflows XIQ-SE et historique."),
                _field("policy", _tref("PolicyQuery", "OBJECT"), "Domaines Extreme Policy, rôles, règles et services."),
                _field("alarms", _tref("AlarmsQuery", "OBJECT"), "Alarmes actives, traps SNMP et journal des événements."),
                _field("analytics", _tref("AnalyticsQuery", "OBJECT"), "Visibilité applicative et télémétrie ExtremeAnalytics."),
                _field("administration", _tref("AdministrationQuery", "OBJECT"), "État du serveur XIQ-SE, licences, groupes d'autorisation et clients API."),
            ],
        ),
        _obj_type(
            "Mutation",
            "Point d'entrée racine des mutations (modifications / actions) de l'API NBI GraphQL XIQ-SE.",
            [
                _field("network", _tref("NetworkMutations", "OBJECT"), "Provisioning sites, équipements, services et topologie."),
                _field("accessControl", _tref("AccessControlMutations", "OBJECT"), "Gestion des groupes End-System, Blacklist, MAC Lock et RADIUS."),
                _field("workflows", _tref("WorkflowsMutations", "OBJECT"), "Lancement et contrôle d'exécution des workflows XIQ-SE."),
                _field("policy", _tref("PolicyMutations", "OBJECT"), "Application (Enforce) et mise à jour des domaines Policy."),
                _field("alarms", _tref("AlarmsMutations", "OBJECT"), "Acquittement et acquittement/effacement d'alarmes."),
            ],
        ),
        # ---- NETWORK ----
        _obj_type(
            "NetworkQuery",
            "Requêtes d'inventaire et de topologie réseau.",
            [
                _field("devices", _list_of(_tref("Device", "OBJECT")), "Liste complète de tous les équipements réseau gérés."),
                _field("device", _tref("Device", "OBJECT"), "Détails complets et ports d'un équipement par son IP.", [_arg("ip", _non_null(S), "Adresse IP de gestion")]),
                _field("devicesBySiteLocation", _list_of(_tref("Device", "OBJECT")), "Équipements appartenant à un site donné.", [_arg("location", _non_null(S), "Chemin du site (ex: /World/France/Paris-HQ)")]),
                _field("sites", _list_of(_tref("Site", "OBJECT")), "Liste de tous les sites configurés dans l'arborescence."),
                _field("siteByLocation", _tref("Site", "OBJECT"), "Détails d'un site, liste d'équipements et VLANs.", [_arg("location", _non_null(S), "Chemin complet du site")]),
            ],
        ),
        _obj_type(
            "NetworkMutations",
            "Mutations réseau : création de sites et gestion du cycle de vie des équipements.",
            [
                _field("createSite", _tref("SiteMutationResult", "OBJECT"), "Crée un nouveau site dans l'arborescence XIQ-SE.", [_arg("input", _non_null(_tref("SiteConfigMutationInput", "INPUT_OBJECT")), "Paramètres du site")]),
                _field("createDevices", _tref("MutationResult", "OBJECT"), "Ajoute un ou plusieurs équipements réseau à XIQ-SE.", [_arg("input", _non_null(_tref("CreateDeviceInput", "INPUT_OBJECT")), "Liste des équipements à créer")]),
                _field("deleteDevices", _tref("MutationResult", "OBJECT"), "Supprime des équipements de XIQ-SE par adresse IP.", [_arg("input", _non_null(_tref("DeleteDeviceInput", "INPUT_OBJECT")), "IPs à supprimer")]),
            ],
        ),
        _obj_type(
            "Device",
            "Équipement réseau géré par XIQ-SE (Switch, Routeur, AP, Fabric).",
            [
                _field("ip", S, "Adresse IP de gestion"),
                _field("sysName", S, "Nom système (SNMP sysName)"),
                _field("deviceName", S, "Nom d'affichage dans Site Engine"),
                _field("baseMac", S, "Adresse MAC de base du châssis"),
                _field("status", I, "Statut opérationnel (1 = Up, 0 = Down)"),
                _field("deviceDisplayFamily", S, "Famille matérielle Extreme Networks"),
                _field("firmware", S, "Version du firmware (EXOS / Switch Engine / Fabric Engine)"),
                _field("sitePath", S, "Chemin hiérarchique du site"),
                _field("sysUpTime", S, "Durée de fonctionnement"),
                _field("sysDescr", S, "Description système complète"),
                _field("cpuPercent", I, "Utilisation CPU (%)"),
                _field("memoryPercent", I, "Utilisation Mémoire (%)"),
                _field("deviceData", _tref("DeviceData", "OBJECT"), "Métadonnées constructeur et numéro de série"),
                _field("siteData", _tref("SiteData", "OBJECT"), "Informations de localisation du site"),
                _field("interfaces", _list_of(_tref("DeviceInterface", "OBJECT")), "Ports et interfaces physiques/logiques"),
            ],
        ),
        _obj_type(
            "DeviceData",
            "Métadonnées matérielles de l'équipement.",
            [
                _field("vendor", S, "Constructeur"),
                _field("serialNumber", S, "Numéro de série"),
                _field("family", S, "Famille produit"),
                _field("subFamily", S, "Modèle exact"),
            ],
        ),
        _obj_type(
            "SiteData",
            "Référence de site attachée à un équipement.",
            [
                _field("siteId", S, "Identifiant interne du site"),
                _field("siteName", S, "Nom du site"),
                _field("location", S, "Chemin complet du site"),
            ],
        ),
        _obj_type(
            "DeviceInterface",
            "Port / interface réseau d'un switch ou routeur.",
            [
                _field("name", S, "Nom du port (ex: 1:1)"),
                _field("alias", S, "Description / alias du port"),
                _field("adminStatus", S, "État administratif (Up / Down)"),
                _field("operStatus", S, "État opérationnel (Up / Down)"),
                _field("speed", S, "Vitesse négociée (1G, 2.5G, 10G, 25G...)"),
                _field("vlan", S, "VLAN principal / PVID"),
                _field("poePowerWatts", F, "Puissance PoE consommée (Watts)"),
            ],
        ),
        _obj_type(
            "Site",
            "Site topologique XIQ-SE.",
            [
                _field("siteId", S, "ID du site"),
                _field("name", S, "Nom du site"),
                _field("location", S, "Chemin hiérarchique complet"),
                _field("parentLocation", S, "Chemin parent"),
                _field("devList", _list_of(S), "Liste des IP des équipements du site"),
                _field("vlans", _list_of(_tref("Vlan", "OBJECT")), "VLANs configurés sur ce site"),
            ],
        ),
        _obj_type(
            "Vlan",
            "Configuration VLAN sur un site.",
            [
                _field("vid", I, "VLAN ID (1-4094)"),
                _field("name", S, "Nom du VLAN"),
                _field("subnet", S, "Sous-réseau IP associé"),
                _field("isManagement", B, "Indique s'il s'agit du VLAN de management"),
            ],
        ),
        # ---- ACCESS CONTROL / NAC ----
        _obj_type(
            "AccessControlQuery",
            "Requêtes ExtremeControl (NAC).",
            [
                _field("appliances", _list_of(_tref("NacAppliance", "OBJECT")), "Liste des moteurs NAC ExtremeControl."),
                _field("endSystems", _list_of(_tref("EndSystem", "OBJECT")), "Liste des terminaux authentifiés/observés."),
                _field("allEndSystemMacs", _list_of(S), "Liste complète de toutes les adresses MAC vues dans ExtremeControl."),
                _field("endSystemByMac", _tref("EndSystemLookup", "OBJECT"), "Recherche d'un terminal par adresse MAC.", [_arg("macAddress", _non_null(S), "Adresse MAC (AA:BB:CC:DD:EE:FF)")]),
                _field("endSystemGroups", _list_of(_tref("EndSystemGroup", "OBJECT")), "Groupes d'End-Systems et leurs membres."),
                _field("group", _tref("EndSystemGroup", "OBJECT"), "Détails et membres d'un groupe NAC par son nom.", [_arg("name", _non_null(S), "Nom du groupe")]),
                _field("macLocks", _list_of(_tref("MacLock", "OBJECT")), "Verrouillages MAC par port configurés."),
                _field("radiusServers", _list_of(_tref("RadiusServer", "OBJECT")), "Serveurs RADIUS configurés."),
            ],
        ),
        _obj_type(
            "AccessControlMutations",
            "Mutations ExtremeControl (NAC) : groupes, quarantaine/blacklist, MAC Lock et RADIUS.",
            [
                _field("addMACToEndSystemGroup", _tref("MutationResult", "OBJECT"), "Ajoute une MAC dans un groupe d'End-Systems.", [_arg("input", _non_null(_tref("GroupAddEntryInput", "INPUT_OBJECT")))]),
                _field("addIPToEndSystemGroup", _tref("MutationResult", "OBJECT"), "Ajoute une IP dans un groupe d'End-Systems.", [_arg("input", _non_null(_tref("GroupAddEntryInput", "INPUT_OBJECT")))]),
                _field("addHostnameToEndSystemGroup", _tref("MutationResult", "OBJECT"), "Ajoute un hostname dans un groupe d'End-Systems.", [_arg("input", _non_null(_tref("GroupAddEntryInput", "INPUT_OBJECT")))]),
                _field("addEntryToGroup", _tref("MutationResult", "OBJECT"), "Ajoute une entrée générique à un groupe.", [_arg("input", _non_null(_tref("GroupAddEntryInput", "INPUT_OBJECT")))]),
                _field("removeEntryFromGroup", _tref("MutationResult", "OBJECT"), "Retire une entrée d'un groupe d'End-Systems.", [_arg("input", _non_null(_tref("GroupAddEntryInput", "INPUT_OBJECT")))]),
                _field("addMACToBlacklist", _tref("MutationResult", "OBJECT"), "Place une adresse MAC dans la Blacklist système.", [_arg("input", _non_null(_tref("BlacklistAddEntryInput", "INPUT_OBJECT")))]),
                _field("createMacLock", _tref("MutationResult", "OBJECT"), "Verrouille une MAC sur un switch et un port précis.", [_arg("input", _non_null(_tref("MacLockInput", "INPUT_OBJECT")))]),
                _field("deleteMacLock", _tref("MutationResult", "OBJECT"), "Supprime un verrouillage MAC.", [_arg("input", _non_null(_tref("MacLockInput", "INPUT_OBJECT")))]),
                _field("createRadiusServer", _tref("MutationResult", "OBJECT"), "Ajoute un serveur RADIUS externe.", [_arg("input", _non_null(_tref("RadiusServerInput", "INPUT_OBJECT")))]),
                _field("reauthenticateEndSystem", _tref("MutationResult", "OBJECT"), "Force la ré-authentification (CoA / Bounce) d'un terminal.", [_arg("input", _non_null(_tref("ReauthInput", "INPUT_OBJECT")))]),
            ],
        ),
        _obj_type(
            "NacAppliance",
            "Moteur ExtremeControl (NAC Engine).",
            [
                _field("ipAddress", S, "IP du moteur NAC"),
                _field("displayName", S, "Nom d'affichage"),
                _field("status", S, "Statut (Running / Degraded / Down)"),
                _field("version", S, "Version logicielle"),
                _field("activeEndSystems", I, "Nombre de sessions actives"),
                _field("engineGroup", S, "Groupe de moteurs NAC"),
            ],
        ),
        _obj_type(
            "EndSystem",
            "Terminal client connecté au réseau (PC, IP Phone, IoT, Wi-Fi).",
            [
                _field("macAddress", S, "Adresse MAC"),
                _field("ipAddress", S, "Adresse IP"),
                _field("username", S, "Identifiant utilisateur / machine"),
                _field("hostName", S, "Nom d'hôte"),
                _field("switchIp", S, "IP du switch ou AP d'accès"),
                _field("switchPort", S, "Port ou SSID d'attachement"),
                _field("authType", S, "Méthode d'authentification (802.1X, MAB, Captive Portal)"),
                _field("profile", S, "Profil NAC attribué"),
                _field("vlan", S, "VLAN attribué"),
                _field("state", S, "Décision NAC (Accept, Reject, Quarantine)"),
                _field("lastSeenTime", S, "Dernière activité horodatée"),
            ],
        ),
        _obj_type(
            "EndSystemLookup",
            "Enveloppe de réponse pour endSystemByMac.",
            [_field("endSystem", _tref("EndSystem", "OBJECT"), "Détails du terminal trouvé")],
        ),
        _obj_type(
            "EndSystemGroup",
            "Groupe logique d'End-Systems ExtremeControl.",
            [
                _field("name", S, "Nom du groupe"),
                _field("type", S, "Type de groupe (MAC, IP, Hostname, System)"),
                _field("description", S, "Description"),
                _field("entries", _list_of(S), "Liste des entrées membres"),
            ],
        ),
        _obj_type(
            "MacLock",
            "Règle de verrouillage MAC statique sur un port de switch.",
            [
                _field("id", S, "ID du MAC Lock"),
                _field("macAddress", S, "Adresse MAC verrouillée"),
                _field("switchIp", S, "IP du switch"),
                _field("portName", S, "Port du switch"),
                _field("createdAt", S, "Date de création"),
            ],
        ),
        _obj_type(
            "RadiusServer",
            "Serveur RADIUS configuré dans ExtremeControl.",
            [
                _field("name", S, "Nom du serveur RADIUS"),
                _field("ipAddress", S, "Adresse IP"),
                _field("authPort", I, "Port d'authentification (1812)"),
                _field("status", S, "Statut de joignabilité"),
            ],
        ),
        # ---- WORKFLOWS ----
        _obj_type(
            "WorkflowsQuery",
            "Requêtes du moteur d'automatisation Workflows.",
            [
                _field("workflows", _list_of(_tref("Workflow", "OBJECT")), "Liste des workflows disponibles."),
                _field("executions", _list_of(_tref("WorkflowExecution", "OBJECT")), "Historique récent des exécutions."),
            ],
        ),
        _obj_type(
            "WorkflowsMutations",
            "Mutations d'exécution de Workflows.",
            [
                _field("startWorkflow", _tref("WorkflowStartResult", "OBJECT"), "Démarre un workflow avec des variables d'entrée.", [_arg("input", _non_null(_tref("StartWorkflowInput", "INPUT_OBJECT")))]),
            ],
        ),
        _obj_type(
            "Workflow",
            "Définition d'un Workflow XIQ-SE.",
            [
                _field("id", S, "Identifiant unique du workflow"),
                _field("name", S, "Nom du workflow"),
                _field("category", S, "Catégorie (Provisioning, Security, Backup, ITSM...)"),
                _field("description", S, "Description fonctionnelle"),
                _field("isSystem", B, "Workflow système intégré"),
                _field("variables", _list_of(_tref("WorkflowVariable", "OBJECT")), "Paramètres d'entrée attendus"),
            ],
        ),
        _obj_type(
            "WorkflowVariable",
            "Paramètre d'entrée d'un workflow.",
            [
                _field("name", S, "Nom de la variable"),
                _field("type", S, "Type (String, IP, MAC, Int, Boolean)"),
                _field("defaultValue", S, "Valeur par défaut"),
                _field("required", B, "Obligatoire ou optionnel"),
            ],
        ),
        _obj_type(
            "WorkflowExecution",
            "Exécution d'un workflow.",
            [
                _field("executionId", S, "ID d'exécution"),
                _field("workflowId", S, "ID du workflow"),
                _field("workflowName", S, "Nom du workflow"),
                _field("status", S, "Statut (Completed, Running, Failed)"),
                _field("startedAt", S, "Horodatage de début"),
                _field("durationMs", I, "Durée (ms)"),
                _field("variablesJson", S, "Variables transmises (JSON)"),
                _field("outputMessage", S, "Message de résultat"),
            ],
        ),
        _obj_type(
            "WorkflowStartResult",
            "Résultat du déclenchement d'un workflow.",
            [
                _field("executionId", S, "Identifiant de l'exécution lancée"),
                _field("success", B, "Succès du démarrage"),
                _field("statusmessage", S, "Message de statut XIQ-SE"),
            ],
        ),
        # ---- POLICY ----
        _obj_type(
            "PolicyQuery",
            "Requêtes Extreme Policy.",
            [
                _field("domains", _list_of(_tref("PolicyDomain", "OBJECT")), "Domaines de politiques réseau, rôles et règles."),
            ],
        ),
        _obj_type(
            "PolicyMutations",
            "Mutations Extreme Policy.",
            [
                _field("enforcePolicy", _tref("MutationResult", "OBJECT"), "Déploie (Enforce) un domaine Policy vers ses équipements.", [_arg("input", _non_null(_tref("EnforcePolicyInput", "INPUT_OBJECT")))]),
            ],
        ),
        _obj_type(
            "PolicyDomain",
            "Domaine Extreme Policy.",
            [
                _field("name", S, "Nom du domaine"),
                _field("description", S, "Description"),
                _field("deviceCount", I, "Nombre d'équipements assignés"),
                _field("lastEnforced", S, "Dernier déploiement réussi"),
                _field("roles", _list_of(_tref("PolicyRole", "OBJECT")), "Rôles définis dans le domaine"),
            ],
        ),
        _obj_type(
            "PolicyRole",
            "Rôle d'accès Extreme Policy.",
            [
                _field("name", S, "Nom du rôle"),
                _field("defaultVlan", S, "VLAN par défaut"),
                _field("cos", S, "Classe de service (CoS / QoS)"),
                _field("rulesCount", I, "Nombre de règles L2/L3/L4"),
            ],
        ),
        # ---- ALARMS ----
        _obj_type(
            "AlarmsQuery",
            "Requêtes Alarmes & Événements.",
            [
                _field("activeAlarms", _list_of(_tref("Alarm", "OBJECT")), "Liste des alarmes actives sur l'infrastructure."),
                _field("recentEvents", _list_of(_tref("NetworkEvent", "OBJECT")), "Événements réseau et traps SNMP récents."),
            ],
        ),
        _obj_type(
            "AlarmsMutations",
            "Mutations Alarmes.",
            [
                _field("acknowledgeAlarm", _tref("MutationResult", "OBJECT"), "Acquitte une alarme active.", [_arg("input", _non_null(_tref("AlarmActionInput", "INPUT_OBJECT")))]),
                _field("clearAlarm", _tref("MutationResult", "OBJECT"), "Efface/clôture une alarme active.", [_arg("input", _non_null(_tref("AlarmActionInput", "INPUT_OBJECT")))]),
            ],
        ),
        _obj_type(
            "Alarm",
            "Alarme réseau XIQ-SE.",
            [
                _field("id", S, "Identifiant de l'alarme"),
                _field("severity", S, "Sévérité (Critical, Error, Warning, Info)"),
                _field("sourceIp", S, "IP de la source"),
                _field("sourceName", S, "Nom de l'équipement source"),
                _field("category", S, "Catégorie"),
                _field("message", S, "Message détaillé"),
                _field("timestamp", S, "Horodatage"),
                _field("acknowledged", B, "Acquittée ou non"),
            ],
        ),
        _obj_type(
            "NetworkEvent",
            "Événement / Trap SNMP / Syslog.",
            [
                _field("id", S, "ID événement"),
                _field("timestamp", S, "Horodatage"),
                _field("severity", S, "Sévérité"),
                _field("source", S, "Source"),
                _field("type", S, "Type (SNMP Trap, Syslog, NAC, Audit)"),
                _field("summary", S, "Résumé"),
            ],
        ),
        # ---- ANALYTICS ----
        _obj_type(
            "AnalyticsQuery",
            "Télémétrie et visibilité applicative ExtremeAnalytics.",
            [
                _field("topApplications", _list_of(_tref("AppMetric", "OBJECT")), "Top applications réseau par volume et latence."),
            ],
        ),
        _obj_type(
            "AppMetric",
            "Métrique applicative ExtremeAnalytics.",
            [
                _field("name", S, "Nom de l'application"),
                _field("category", S, "Catégorie applicative"),
                _field("flows", I, "Nombre de flux observés"),
                _field("bytesTotalMB", F, "Volume total (Mo)"),
                _field("avgNetworkResponseMs", F, "Temps de réponse réseau moyen (ms)"),
                _field("avgAppResponseMs", F, "Temps de réponse applicatif moyen (ms)"),
                _field("riskLevel", S, "Niveau de risque (Low, Medium, High)"),
            ],
        ),
        # ---- ADMINISTRATION ----
        _obj_type(
            "AdministrationQuery",
            "Administration système XIQ-SE, licences et contrôle d'accès API.",
            [
                _field("serverInfo", _tref("ServerInfo", "OBJECT"), "Version, santé système et capacité de licences."),
                _field("authorizationGroups", _list_of(_tref("AuthGroup", "OBJECT")), "Groupes d'autorisation NBI."),
                _field("apiClients", _list_of(_tref("ApiClient", "OBJECT")), "Clients API OAuth2 enregistrés."),
            ],
        ),
        _obj_type(
            "ServerInfo",
            "Informations système du serveur XIQ-SE.",
            [
                _field("version", S, "Version logicielle XIQ-SE"),
                _field("hostName", S, "Nom d'hôte du serveur"),
                _field("ipAddress", S, "Adresse IP du serveur"),
                _field("upTime", S, "Uptime serveur"),
                _field("cpuPercent", I, "Charge CPU (%)"),
                _field("memoryPercent", I, "Utilisation RAM (%)"),
                _field("diskPercent", I, "Utilisation Disque (%)"),
                _field("licenseTier", S, "Niveau de licence"),
                _field("managedDevicesCount", I, "Nombre d'équipements gérés"),
                _field("licensedDevicesMax", I, "Capacité maximale de licence"),
            ],
        ),
        _obj_type(
            "AuthGroup",
            "Groupe d'autorisation XIQ-SE.",
            [
                _field("name", S, "Nom du groupe"),
                _field("capabilities", _list_of(S), "Capacités NBI accordées"),
                _field("memberCount", I, "Nombre de membres/clients"),
            ],
        ),
        _obj_type(
            "ApiClient",
            "Client API OAuth2 configuré dans Administration > Client API Access.",
            [
                _field("clientId", S, "Client ID OAuth2"),
                _field("name", S, "Nom descriptif"),
                _field("authorizationGroup", S, "Groupe d'autorisation lié"),
                _field("enabled", B, "Actif ou désactivé"),
                _field("lastUsed", S, "Dernière utilisation"),
            ],
        ),
        # ---- COMMON OUTPUTS & INPUTS ----
        _obj_type(
            "MutationResult",
            "Réponse générique d'une mutation NBI.",
            [
                _field("status", S, "Statut (SUCCESS / ERROR)"),
                _field("message", S, "Message descriptif"),
            ],
        ),
        _obj_type(
            "SiteMutationResult",
            "Réponse d'une mutation de site.",
            [
                _field("status", S, "Statut (SUCCESS / ERROR)"),
                _field("message", S, "Message descriptif"),
                _field("siteLocation", S, "Chemin complet du site créé"),
            ],
        ),
        _input_type(
            "SiteConfigMutationInput",
            "Paramètres de création d'un site.",
            [
                _arg("name", _non_null(S), "Nom du nouveau site"),
                _arg("parentLocation", _non_null(S), "Chemin parent (ex: /World/France)"),
            ],
        ),
        _input_type(
            "DeviceItemInput",
            "Définition d'un équipement à ajouter.",
            [
                _arg("ipAddress", _non_null(S), "Adresse IP"),
                _arg("sysName", S, "Nom système"),
                _arg("siteLocation", S, "Chemin du site"),
                _arg("profileName", S, "Profil SNMP/CLI"),
            ],
        ),
        _input_type(
            "CreateDeviceInput",
            "Liste d'équipements à provisionner.",
            [_arg("devices", _non_null(_list_of(_tref("DeviceItemInput", "INPUT_OBJECT"))), "Équipements")],
        ),
        _input_type(
            "DeleteDeviceInput",
            "Liste d'IPs d'équipements à supprimer.",
            [_arg("ipAddresses", _non_null(_list_of(S)), "Adresses IP")],
        ),
        _input_type(
            "GroupAddEntryInput",
            "Entrée à ajouter ou retirer d'un groupe End-System.",
            [
                _arg("groupName", _non_null(S), "Nom du groupe cible"),
                _arg("entry", _non_null(S), "Adresse MAC, IP ou Hostname"),
                _arg("description", S, "Commentaire optionnel"),
            ],
        ),
        _input_type(
            "BlacklistAddEntryInput",
            "Adresse MAC à ajouter à la Blacklist.",
            [
                _arg("entry", _non_null(S), "Adresse MAC"),
                _arg("description", S, "Raison de la mise en quarantaine"),
            ],
        ),
        _input_type(
            "MacLockInput",
            "Paramètres de verrouillage MAC.",
            [
                _arg("macAddress", _non_null(S), "Adresse MAC"),
                _arg("switchIp", _non_null(S), "IP du switch"),
                _arg("portName", _non_null(S), "Nom du port (ex: 1:5)"),
            ],
        ),
        _input_type(
            "RadiusServerInput",
            "Paramètres d'un serveur RADIUS.",
            [
                _arg("name", _non_null(S), "Nom"),
                _arg("ipAddress", _non_null(S), "Adresse IP"),
                _arg("authPort", I, "Port d'authentification (1812)"),
                _arg("sharedSecret", _non_null(S), "Secret partagé RADIUS"),
            ],
        ),
        _input_type(
            "ReauthInput",
            "Paramètres de ré-authentification d'un terminal.",
            [_arg("macAddress", _non_null(S), "Adresse MAC du terminal")],
        ),
        _input_type(
            "StartWorkflowInput",
            "Paramètres de lancement d'un workflow XIQ-SE.",
            [
                _arg("id", _non_null(S), "ID du workflow"),
                _arg("variables", S, "Tableau JSON des variables [{\"name\":\"...\",\"value\":\"...\"}]"),
            ],
        ),
        _input_type(
            "EnforcePolicyInput",
            "Paramètres de déploiement Policy.",
            [_arg("domainName", _non_null(S), "Nom du domaine Policy")],
        ),
        _input_type(
            "AlarmActionInput",
            "Identifiant de l'alarme cible.",
            [_arg("id", _non_null(S), "ID de l'alarme")],
        ),
    ]

    return {
        "queryType": {"name": "Query"},
        "mutationType": {"name": "Mutation"},
        "subscriptionType": None,
        "types": types,
    }


# ---- Stateful Mock Engine ----

class MockXIQSEEngine:
    """In-memory ExtremeCloud IQ - Site Engine GraphQL simulator."""

    def __init__(self) -> None:
        self.schema = build_demo_schema()
        self.reset()

    def reset(self) -> None:
        self.sites: List[Dict[str, Any]] = [
            {
                "siteId": "site-paris",
                "name": "Paris-HQ",
                "location": "/World/France/Paris-HQ",
                "parentLocation": "/World/France",
                "vlans": [
                    {"vid": 10, "name": "MGMT-INFRA", "subnet": "10.10.1.0/24", "isManagement": True},
                    {"vid": 20, "name": "CORP-DATA", "subnet": "10.10.20.0/23", "isManagement": False},
                    {"vid": 30, "name": "VOIP-VOICE", "subnet": "10.10.30.0/24", "isManagement": False},
                    {"vid": 40, "name": "WIFI-CORP", "subnet": "10.10.40.0/23", "isManagement": False},
                    {"vid": 99, "name": "GUEST-ISOLATED", "subnet": "172.16.99.0/24", "isManagement": False},
                ],
            },
            {
                "siteId": "site-dc1",
                "name": "DataCenter-DC1",
                "location": "/World/France/DataCenter-DC1",
                "parentLocation": "/World/France",
                "vlans": [
                    {"vid": 10, "name": "MGMT-DC", "subnet": "10.10.2.0/24", "isManagement": True},
                    {"vid": 100, "name": "PROD-SERVERS", "subnet": "10.100.0.0/22", "isManagement": False},
                    {"vid": 110, "name": "STORAGE-ISCSI", "subnet": "10.110.0.0/24", "isManagement": False},
                    {"vid": 120, "name": "DMZ-EXT", "subnet": "192.168.120.0/24", "isManagement": False},
                ],
            },
            {
                "siteId": "site-lyon",
                "name": "Lyon-Campus",
                "location": "/World/France/Lyon-Campus",
                "parentLocation": "/World/France",
                "vlans": [
                    {"vid": 10, "name": "MGMT-LYON", "subnet": "10.20.1.0/24", "isManagement": True},
                    {"vid": 20, "name": "CORP-LYON", "subnet": "10.20.20.0/24", "isManagement": False},
                    {"vid": 50, "name": "IOT-CAMERAS", "subnet": "10.20.50.0/24", "isManagement": False},
                ],
            },
            {
                "siteId": "site-mrs",
                "name": "Marseille-Branch",
                "location": "/World/France/Marseille-Branch",
                "parentLocation": "/World/France",
                "vlans": [
                    {"vid": 10, "name": "MGMT-MRS", "subnet": "10.30.1.0/24", "isManagement": True},
                    {"vid": 20, "name": "CORP-MRS", "subnet": "10.30.20.0/24", "isManagement": False},
                ],
            },
        ]

        def _make_ports(prefix: str, count: int, poe: bool = True) -> List[Dict[str, Any]]:
            ports = []
            for i in range(1, count + 1):
                up = i <= count - 2
                speed = "10G" if i >= count - 1 else ("2.5G" if i % 4 == 0 else "1G")
                vlan = "10" if i >= count - 1 else ("30" if i % 3 == 0 else "20")
                watts = round(12.4 + (i % 5) * 3.1, 1) if (poe and up and i < count - 1) else 0.0
                alias = "UPLINK-CORE" if i >= count - 1 else (f"AP-FLOOR-{(i % 4) + 1}" if i % 4 == 0 else f"ACCESS-PORT-{i}")
                ports.append({
                    "name": f"{prefix}:{i}",
                    "alias": alias,
                    "adminStatus": "Up" if up or i == count else "Down",
                    "operStatus": "Up" if up else "Down",
                    "speed": speed if up else "0",
                    "vlan": f"VLAN-{vlan}",
                    "poePowerWatts": watts,
                })
            return ports

        self.devices: List[Dict[str, Any]] = [
            {
                "ip": "10.10.1.1",
                "sysName": "CORE-PAR-5720-01",
                "deviceName": "CORE-PAR-5720-01",
                "baseMac": "00:04:96:A1:10:01",
                "status": 1,
                "deviceDisplayFamily": "5720 Series",
                "firmware": "Switch Engine 33.1.1.14",
                "sitePath": "/World/France/Paris-HQ",
                "sysUpTime": "142d 08h 34m",
                "sysDescr": "Extreme Networks 5720-24MW-4Y Universal Switch - Fabric Engine / Switch Engine",
                "cpuPercent": 18,
                "memoryPercent": 41,
                "deviceData": {"vendor": "Extreme Networks", "serialNumber": "2318W-57201", "family": "Universal", "subFamily": "5720-24MW"},
                "siteData": {"siteId": "site-paris", "siteName": "Paris-HQ", "location": "/World/France/Paris-HQ"},
                "interfaces": _make_ports("1", 12, poe=False),
            },
            {
                "ip": "10.10.1.11",
                "sysName": "ACC-PAR-5520-F1",
                "deviceName": "ACC-PAR-5520-F1",
                "baseMac": "00:04:96:A1:10:11",
                "status": 1,
                "deviceDisplayFamily": "5520 Series",
                "firmware": "Switch Engine 32.7.1.9",
                "sitePath": "/World/France/Paris-HQ",
                "sysUpTime": "89d 14h 12m",
                "sysDescr": "Extreme Networks 5520-48W Universal Switch PoE+",
                "cpuPercent": 24,
                "memoryPercent": 52,
                "deviceData": {"vendor": "Extreme Networks", "serialNumber": "2241W-55211", "family": "Universal", "subFamily": "5520-48W"},
                "siteData": {"siteId": "site-paris", "siteName": "Paris-HQ", "location": "/World/France/Paris-HQ"},
                "interfaces": _make_ports("1", 16, poe=True),
            },
            {
                "ip": "10.10.1.12",
                "sysName": "ACC-PAR-5420-F2",
                "deviceName": "ACC-PAR-5420-F2",
                "baseMac": "00:04:96:A1:10:12",
                "status": 1,
                "deviceDisplayFamily": "5420 Series",
                "firmware": "Switch Engine 32.7.1.9",
                "sitePath": "/World/France/Paris-HQ",
                "sysUpTime": "64d 03h 49m",
                "sysDescr": "Extreme Networks 5420F-48P-4XE Universal Switch",
                "cpuPercent": 19,
                "memoryPercent": 46,
                "deviceData": {"vendor": "Extreme Networks", "serialNumber": "2302W-54212", "family": "Universal", "subFamily": "5420F-48P-4XE"},
                "siteData": {"siteId": "site-paris", "siteName": "Paris-HQ", "location": "/World/France/Paris-HQ"},
                "interfaces": _make_ports("1", 12, poe=True),
            },
            {
                "ip": "10.10.1.51",
                "sysName": "AP-PAR-5010-OPENSPACE",
                "deviceName": "AP-PAR-5010-OPENSPACE",
                "baseMac": "B4:C7:99:22:50:51",
                "status": 1,
                "deviceDisplayFamily": "Universal AP Wi-Fi 6E",
                "firmware": "IQ Engine 10.7.3.0",
                "sitePath": "/World/France/Paris-HQ",
                "sysUpTime": "51d 19h 02m",
                "sysDescr": "Extreme Networks AP5010 Tri-Radio Wi-Fi 6E Access Point",
                "cpuPercent": 14,
                "memoryPercent": 38,
                "deviceData": {"vendor": "Extreme Networks", "serialNumber": "AP5010-99101", "family": "Wireless", "subFamily": "AP5010"},
                "siteData": {"siteId": "site-paris", "siteName": "Paris-HQ", "location": "/World/France/Paris-HQ"},
                "interfaces": _make_ports("eth", 2, poe=False),
            },
            {
                "ip": "10.10.2.1",
                "sysName": "DC1-FABRIC-VSP7400-A",
                "deviceName": "DC1-FABRIC-VSP7400-A",
                "baseMac": "00:04:96:DC:74:01",
                "status": 1,
                "deviceDisplayFamily": "VSP 7400 Series",
                "firmware": "Fabric Engine 9.1.2.0",
                "sitePath": "/World/France/DataCenter-DC1",
                "sysUpTime": "312d 22h 15m",
                "sysDescr": "Extreme Networks VSP 7400-48Y-8C Fabric Connect Spine",
                "cpuPercent": 21,
                "memoryPercent": 49,
                "deviceData": {"vendor": "Extreme Networks", "serialNumber": "2150V-74001", "family": "Fabric", "subFamily": "VSP7400-48Y"},
                "siteData": {"siteId": "site-dc1", "siteName": "DataCenter-DC1", "location": "/World/France/DataCenter-DC1"},
                "interfaces": _make_ports("1", 10, poe=False),
            },
            {
                "ip": "10.10.2.2",
                "sysName": "DC1-FABRIC-VSP7400-B",
                "deviceName": "DC1-FABRIC-VSP7400-B",
                "baseMac": "00:04:96:DC:74:02",
                "status": 1,
                "deviceDisplayFamily": "VSP 7400 Series",
                "firmware": "Fabric Engine 9.1.2.0",
                "sitePath": "/World/France/DataCenter-DC1",
                "sysUpTime": "312d 22h 09m",
                "sysDescr": "Extreme Networks VSP 7400-48Y-8C Fabric Connect Spine",
                "cpuPercent": 20,
                "memoryPercent": 48,
                "deviceData": {"vendor": "Extreme Networks", "serialNumber": "2150V-74002", "family": "Fabric", "subFamily": "VSP7400-48Y"},
                "siteData": {"siteId": "site-dc1", "siteName": "DataCenter-DC1", "location": "/World/France/DataCenter-DC1"},
                "interfaces": _make_ports("1", 10, poe=False),
            },
            {
                "ip": "10.20.1.1",
                "sysName": "CORE-LYN-X465-01",
                "deviceName": "CORE-LYN-X465-01",
                "baseMac": "00:04:96:LY:46:01",
                "status": 1,
                "deviceDisplayFamily": "ExtremeSwitching X465",
                "firmware": "EXOS 32.6.2.12",
                "sitePath": "/World/France/Lyon-Campus",
                "sysUpTime": "118d 05h 40m",
                "sysDescr": "ExtremeSwitching X465-24MU-24W Aggregation Switch",
                "cpuPercent": 31,
                "memoryPercent": 58,
                "deviceData": {"vendor": "Extreme Networks", "serialNumber": "2214X-46501", "family": "ExtremeSwitching", "subFamily": "X465-24MU"},
                "siteData": {"siteId": "site-lyon", "siteName": "Lyon-Campus", "location": "/World/France/Lyon-Campus"},
                "interfaces": _make_ports("1", 12, poe=True),
            },
            {
                "ip": "10.20.1.15",
                "sysName": "ACC-LYN-5420-B2",
                "deviceName": "ACC-LYN-5420-B2",
                "baseMac": "00:04:96:LY:54:15",
                "status": 0,
                "deviceDisplayFamily": "5420 Series",
                "firmware": "Switch Engine 32.7.1.9",
                "sitePath": "/World/France/Lyon-Campus",
                "sysUpTime": "0d 00h 00m",
                "sysDescr": "Extreme Networks 5420M-24W-4YE Switch (Unreachable)",
                "cpuPercent": 0,
                "memoryPercent": 0,
                "deviceData": {"vendor": "Extreme Networks", "serialNumber": "2309W-54215", "family": "Universal", "subFamily": "5420M-24W"},
                "siteData": {"siteId": "site-lyon", "siteName": "Lyon-Campus", "location": "/World/France/Lyon-Campus"},
                "interfaces": _make_ports("1", 8, poe=True),
            },
            {
                "ip": "10.30.1.10",
                "sysName": "EDGE-MRS-5320-01",
                "deviceName": "EDGE-MRS-5320-01",
                "baseMac": "00:04:96:MR:53:10",
                "status": 1,
                "deviceDisplayFamily": "5320 Series",
                "firmware": "Switch Engine 32.7.1.9",
                "sitePath": "/World/France/Marseille-Branch",
                "sysUpTime": "44d 11h 27m",
                "sysDescr": "Extreme Networks 5320-24P-8XE Branch Switch",
                "cpuPercent": 15,
                "memoryPercent": 39,
                "deviceData": {"vendor": "Extreme Networks", "serialNumber": "2401W-53210", "family": "Universal", "subFamily": "5320-24P"},
                "siteData": {"siteId": "site-mrs", "siteName": "Marseille-Branch", "location": "/World/France/Marseille-Branch"},
                "interfaces": _make_ports("1", 8, poe=True),
            },
        ]

        self.nac_appliances: List[Dict[str, Any]] = [
            {"ipAddress": "10.10.0.41", "displayName": "NAC-PARIS-ENGINE-01", "status": "Running", "version": "25.2.10.14", "activeEndSystems": 842, "engineGroup": "FR-Primary"},
            {"ipAddress": "10.10.0.42", "displayName": "NAC-PARIS-ENGINE-02", "status": "Running", "version": "25.2.10.14", "activeEndSystems": 619, "engineGroup": "FR-Primary"},
            {"ipAddress": "10.20.0.41", "displayName": "NAC-LYON-ENGINE-01", "status": "Running", "version": "25.2.10.14", "activeEndSystems": 315, "engineGroup": "FR-Regional"},
        ]

        self.end_systems: List[Dict[str, Any]] = [
            {"macAddress": "00:1A:2B:3C:4D:01", "ipAddress": "10.10.20.41", "username": "CORP\\m.dupont", "hostName": "LT-PAR-DUPONT", "switchIp": "10.10.1.11", "switchPort": "1:5", "authType": "802.1X (EAP-TLS)", "profile": "Employee-Corp", "vlan": "20", "state": "Accept", "lastSeenTime": "2026-11-23T11:58:12Z"},
            {"macAddress": "00:1A:2B:3C:4D:02", "ipAddress": "10.10.20.42", "username": "CORP\\s.martin", "hostName": "LT-PAR-MARTIN", "switchIp": "10.10.1.11", "switchPort": "1:6", "authType": "802.1X (PEAP)", "profile": "Employee-Corp", "vlan": "20", "state": "Accept", "lastSeenTime": "2026-11-23T11:59:01Z"},
            {"macAddress": "00:1A:2B:3C:4D:03", "ipAddress": "10.10.30.18", "username": "voip-poly-104", "hostName": "POLYCOM-104", "switchIp": "10.10.1.11", "switchPort": "1:3", "authType": "MAB (LLDP-MED)", "profile": "VoIP-Phone", "vlan": "30", "state": "Accept", "lastSeenTime": "2026-11-23T11:57:45Z"},
            {"macAddress": "00:1A:2B:3C:4D:04", "ipAddress": "10.10.40.88", "username": "CORP\\a.bernard", "hostName": "MBP-BERNARD", "switchIp": "10.10.1.51", "switchPort": "SSID:Corp-WiFi", "authType": "802.1X (EAP-TLS)", "profile": "Employee-Corp", "vlan": "40", "state": "Accept", "lastSeenTime": "2026-11-23T11:59:50Z"},
            {"macAddress": "00:1A:2B:3C:4D:05", "ipAddress": "10.20.50.12", "username": "axis-cam-entree", "hostName": "CAM-LYON-01", "switchIp": "10.20.1.1", "switchPort": "1:9", "authType": "MAB", "profile": "IoT-Restricted", "vlan": "50", "state": "Accept", "lastSeenTime": "2026-11-23T11:55:20Z"},
            {"macAddress": "DE:AD:BE:EF:99:01", "ipAddress": "172.16.99.204", "username": "unknown", "hostName": "UNKNOWN-PC", "switchIp": "10.10.1.12", "switchPort": "1:11", "authType": "MAB", "profile": "Quarantine-Deny", "vlan": "99", "state": "Quarantine", "lastSeenTime": "2026-11-23T11:52:10Z"},
            {"macAddress": "00:1A:2B:3C:4D:07", "ipAddress": "10.30.20.15", "username": "CORP\\l.roussel", "hostName": "WS-MRS-ROUSSEL", "switchIp": "10.30.1.10", "switchPort": "1:2", "authType": "802.1X (EAP-TLS)", "profile": "Employee-Corp", "vlan": "20", "state": "Accept", "lastSeenTime": "2026-11-23T11:58:33Z"},
            {"macAddress": "00:1A:2B:3C:4D:08", "ipAddress": "10.10.20.105", "username": "CORP\\admin.net", "hostName": "ADM-NETOPS-01", "switchIp": "10.10.1.1", "switchPort": "1:4", "authType": "802.1X (EAP-TLS)", "profile": "Admin-IT", "vlan": "10", "state": "Accept", "lastSeenTime": "2026-11-23T12:00:02Z"},
            {"macAddress": "00:1A:2B:3C:4D:09", "ipAddress": "10.10.20.199", "username": "old-printer-01", "hostName": "PRN-ARCHIVE-OLD", "switchIp": "10.10.1.12", "switchPort": "1:7", "authType": "MAB", "profile": "Employee-Corp", "vlan": "20", "state": "Accept", "lastSeenTime": "2024-06-15T09:12:00Z"},
        ]

        self.end_system_groups: List[Dict[str, Any]] = [
            {"name": "Corporate-Laptops", "type": "MAC", "description": "Postes de travail d'entreprise approuvés", "entries": ["00:1A:2B:3C:4D:01", "00:1A:2B:3C:4D:02", "00:1A:2B:3C:4D:03", "00:1A:2B:3C:4D:04", "00:1A:2B:3C:4D:09", "DE:AD:BE:EF:99:01", "AA:BB:CC:00:11:22"]},
            {"name": "VoIP-Phones", "type": "MAC", "description": "Téléphones IP Polycom / Cisco", "entries": ["00:1A:2B:3C:4D:03", "AA:BB:CC:00:33:44"]},
            {"name": "IoT-Cameras", "type": "MAC", "description": "Caméras IP Axis et capteurs bâtiment", "entries": ["00:1A:2B:3C:4D:05", "AA:BB:CC:00:55:66", "AA:BB:CC:00:11:22"]},
            {"name": "Blacklist", "type": "System", "description": "Terminaux bloqués / quarantaine sécurité", "entries": ["DE:AD:BE:EF:99:01"]},
            {"name": "Loc-Siege-Paris", "type": "Location", "description": "Switches et ports d'accès du Siège Paris", "entries": ["10.10.1.10", "10.10.2.11", "10.10.2.12"]},
            {"name": "Loc-Lyon-Agences", "type": "Location", "description": "Équipements réseau Agence Lyon", "entries": ["10.20.1.10"]},
            {"name": "LDAP-Admins-Reseau", "type": "User", "description": "Groupe annuaire administrateurs réseau", "entries": ["CN=NetOps,OU=IT,DC=corp,DC=local"]},
        ]

        self.mac_locks: List[Dict[str, Any]] = [
            {"id": "ml-01", "macAddress": "00:1A:2B:3C:4D:08", "switchIp": "10.10.1.1", "portName": "1:4", "createdAt": "2026-10-12T09:15:00Z"},
            {"id": "ml-02", "macAddress": "00:1A:2B:3C:4D:05", "switchIp": "10.20.1.1", "portName": "1:9", "createdAt": "2026-11-01T14:22:00Z"},
        ]

        self.radius_servers: List[Dict[str, Any]] = [
            {"name": "RADIUS-AD-PAR-01", "ipAddress": "10.10.0.21", "authPort": 1812, "status": "Reachable"},
            {"name": "RADIUS-AD-DC1-02", "ipAddress": "10.10.2.21", "authPort": 1812, "status": "Reachable"},
        ]

        self.workflows: List[Dict[str, Any]] = [
            {
                "id": "wf-backup-configs",
                "name": "Sauvegarde Configurations Switches (Site)",
                "category": "Backup & Archive",
                "description": "Lance une sauvegarde immédiate des configurations running-config de tous les équipements d'un site.",
                "isSystem": True,
                "variables": [
                    {"name": "siteLocation", "type": "String", "defaultValue": "/World/France/Paris-HQ", "required": True},
                    {"name": "includeVlanTable", "type": "Boolean", "defaultValue": "true", "required": False},
                ],
            },
            {
                "id": "wf-port-provision",
                "name": "Provisioning Port d'Accès (VLAN + PoE + NAC)",
                "category": "Provisioning",
                "description": "Configure un port switch : alias, VLAN, PoE, et active l'authentification 802.1X/MAB.",
                "isSystem": False,
                "variables": [
                    {"name": "switchIp", "type": "IP", "defaultValue": "10.10.1.11", "required": True},
                    {"name": "portName", "type": "String", "defaultValue": "1:8", "required": True},
                    {"name": "vlanId", "type": "Int", "defaultValue": "20", "required": True},
                    {"name": "portAlias", "type": "String", "defaultValue": "USER-WORKSTATION", "required": False},
                ],
            },
            {
                "id": "wf-quarantine-mac",
                "name": "Isolation Sécurité d'un Terminal Compromis",
                "category": "Security",
                "description": "Ajoute la MAC à la Blacklist, déclenche un CoA Disconnect et ouvre un ticket ITSM.",
                "isSystem": False,
                "variables": [
                    {"name": "macAddress", "type": "MAC", "defaultValue": "DE:AD:BE:EF:99:01", "required": True},
                    {"name": "incidentTicket", "type": "String", "defaultValue": "INC-2026-4412", "required": False},
                ],
            },
            {
                "id": "wf-poe-bounce",
                "name": "Redémarrage PoE d'un Port (AP / Téléphone)",
                "category": "Operations",
                "description": "Coupe puis réactive l'alimentation PoE pendant 5 secondes sur un port donné.",
                "isSystem": True,
                "variables": [
                    {"name": "switchIp", "type": "IP", "defaultValue": "10.10.1.11", "required": True},
                    {"name": "portName", "type": "String", "defaultValue": "1:4", "required": True},
                ],
            },
            {
                "id": "wf-netbox-sync",
                "name": "Synchronisation Inventaire vers NetBox / CMDB",
                "category": "Integration",
                "description": "Exporte l'inventaire XIQ-SE (modèles, séries, IP, interfaces) vers une CMDB externe.",
                "isSystem": False,
                "variables": [
                    {"name": "targetUrl", "type": "String", "defaultValue": "https://netbox.corp.local/api/", "required": True},
                    {"name": "dryRun", "type": "Boolean", "defaultValue": "false", "required": False},
                ],
            },
            {
                "id": "wf-vlan-deploy",
                "name": "Déploiement VLAN sur un Site Fabric",
                "category": "Fabric & VLAN",
                "description": "Crée un nouveau VLAN et son I-SID Fabric Connect sur l'ensemble d'un site.",
                "isSystem": False,
                "variables": [
                    {"name": "siteLocation", "type": "String", "defaultValue": "/World/France/DataCenter-DC1", "required": True},
                    {"name": "vlanId", "type": "Int", "defaultValue": "250", "required": True},
                    {"name": "vlanName", "type": "String", "defaultValue": "APP-MICROSERVICES", "required": True},
                ],
            },
        ]

        self.workflow_executions: List[Dict[str, Any]] = [
            {
                "executionId": "exec-9001",
                "workflowId": "wf-backup-configs",
                "workflowName": "Sauvegarde Configurations Switches (Site)",
                "status": "Completed",
                "startedAt": "2026-11-23T06:00:00Z",
                "durationMs": 4280,
                "variablesJson": '[{"name": "siteLocation", "value": "/World/France/Paris-HQ"}]',
                "outputMessage": "4 équipements sauvegardés avec succès dans l'archive XIQ-SE.",
            },
            {
                "executionId": "exec-9002",
                "workflowId": "wf-netbox-sync",
                "workflowName": "Synchronisation Inventaire vers NetBox / CMDB",
                "status": "Completed",
                "startedAt": "2026-11-23T08:30:00Z",
                "durationMs": 1950,
                "variablesJson": '[{"name": "dryRun", "value": "false"}]',
                "outputMessage": "9 équipements et 90 interfaces synchronisés.",
            },
        ]

        self.policy_domains: List[Dict[str, Any]] = [
            {
                "name": "Enterprise-Campus",
                "description": "Politique principale des campus Paris, Lyon et Marseille",
                "deviceCount": 7,
                "lastEnforced": "2026-11-22T22:15:00Z",
                "roles": [
                    {"name": "Admin-IT", "defaultVlan": "10 (MGMT-INFRA)", "cos": "CoS-5 (High)", "rulesCount": 14},
                    {"name": "Employee-Corp", "defaultVlan": "20 (CORP-DATA)", "cos": "CoS-3 (Standard)", "rulesCount": 22},
                    {"name": "VoIP-Phone", "defaultVlan": "30 (VOIP-VOICE)", "cos": "CoS-6 (EF Voice)", "rulesCount": 9},
                    {"name": "IoT-Restricted", "defaultVlan": "50 (IOT-CAMERAS)", "cos": "CoS-2 (Low)", "rulesCount": 18},
                    {"name": "Quarantine-Deny", "defaultVlan": "99 (GUEST-ISOLATED)", "cos": "CoS-0 (Drop)", "rulesCount": 6},
                ],
            },
            {
                "name": "DataCenter-Fabric",
                "description": "Segmentation East-West sur les switches Fabric Connect VSP 7400",
                "deviceCount": 2,
                "lastEnforced": "2026-11-21T03:00:00Z",
                "roles": [
                    {"name": "Prod-Compute", "defaultVlan": "100 (PROD-SERVERS)", "cos": "CoS-4", "rulesCount": 16},
                    {"name": "Storage-SAN", "defaultVlan": "110 (STORAGE-ISCSI)", "cos": "CoS-6", "rulesCount": 8},
                    {"name": "DMZ-Public", "defaultVlan": "120 (DMZ-EXT)", "cos": "CoS-2", "rulesCount": 25},
                ],
            },
        ]

        self.alarms: List[Dict[str, Any]] = [
            {"id": "ALM-1001", "severity": "Critical", "sourceIp": "10.20.1.15", "sourceName": "ACC-LYN-5420-B2", "category": "Availability", "message": "Device Contact Lost : l'équipement ne répond plus en SNMP/ICMP depuis 14 minutes.", "timestamp": "2026-11-23T11:46:12Z", "acknowledged": False},
            {"id": "ALM-1002", "severity": "Error", "sourceIp": "10.10.1.12", "sourceName": "ACC-PAR-5420-F2", "category": "Security / NAC", "message": "Terminal non autorisé DE:AD:BE:EF:99:01 placé en quarantaine sur le port 1:11.", "timestamp": "2026-11-23T11:52:10Z", "acknowledged": False},
            {"id": "ALM-1003", "severity": "Warning", "sourceIp": "10.10.1.11", "sourceName": "ACC-PAR-5520-F1", "category": "PoE Budget", "message": "Budget PoE supérieur à 80% sur le slot 1 (298W / 370W).", "timestamp": "2026-11-23T10:18:04Z", "acknowledged": False},
            {"id": "ALM-1004", "severity": "Warning", "sourceIp": "10.20.1.1", "sourceName": "CORE-LYN-X465-01", "category": "Optical DOM", "message": "Puissance optique Rx faible (-13.8 dBm) sur l'uplink fibre 1:12.", "timestamp": "2026-11-23T09:05:41Z", "acknowledged": True},
            {"id": "ALM-1005", "severity": "Info", "sourceIp": "10.10.1.1", "sourceName": "CORE-PAR-5720-01", "category": "Configuration", "message": "Sauvegarde de configuration terminée (différence détectée : +2 lignes ACL).", "timestamp": "2026-11-23T06:00:05Z", "acknowledged": True},
        ]

        self.events: List[Dict[str, Any]] = [
            {"id": "EVT-501", "timestamp": "2026-11-23T11:59:50Z", "severity": "Info", "source": "NAC-PARIS-ENGINE-01", "type": "NAC Auth", "summary": "802.1X Accept : CORP\\a.bernard (00:1A:2B:3C:4D:04) -> VLAN 40"},
            {"id": "EVT-502", "timestamp": "2026-11-23T11:52:10Z", "severity": "Error", "source": "ACC-PAR-5420-F2", "type": "SNMP Trap", "summary": "macAuthFailure sur port 1:11 (DE:AD:BE:EF:99:01) -> Quarantine"},
            {"id": "EVT-503", "timestamp": "2026-11-23T11:46:12Z", "severity": "Critical", "source": "XIQ-SE Poller", "type": "Availability", "summary": "Perte de contact ICMP/SNMP avec ACC-LYN-5420-B2 (10.20.1.15)"},
            {"id": "EVT-504", "timestamp": "2026-11-23T10:30:00Z", "severity": "Info", "source": "XIQ-SE Audit", "type": "Audit", "summary": "Token OAuth 2.0 émis pour le client API 'netops-automation'"},
        ]

        self.analytics_apps: List[Dict[str, Any]] = [
            {"name": "Microsoft 365 / Teams", "category": "Collaboration", "flows": 14820, "bytesTotalMB": 48210.5, "avgNetworkResponseMs": 11.4, "avgAppResponseMs": 38.2, "riskLevel": "Low"},
            {"name": "HTTPS / TLS Enterprise", "category": "Web", "flows": 32410, "bytesTotalMB": 39104.2, "avgNetworkResponseMs": 8.9, "avgAppResponseMs": 44.1, "riskLevel": "Low"},
            {"name": "Veeam Backup & Replication", "category": "Backup / Storage", "flows": 640, "bytesTotalMB": 128450.0, "avgNetworkResponseMs": 2.1, "avgAppResponseMs": 14.6, "riskLevel": "Low"},
            {"name": "SAP S/4HANA ERP", "category": "Business Critical", "flows": 5120, "bytesTotalMB": 12940.8, "avgNetworkResponseMs": 4.3, "avgAppResponseMs": 89.5, "riskLevel": "Low"},
            {"name": "SIP / RTP VoIP", "category": "Voice", "flows": 4380, "bytesTotalMB": 6840.2, "avgNetworkResponseMs": 3.2, "avgAppResponseMs": 12.0, "riskLevel": "Low"},
            {"name": "SMB / CIFS File Share", "category": "File Transfer", "flows": 8190, "bytesTotalMB": 24310.7, "avgNetworkResponseMs": 1.8, "avgAppResponseMs": 19.4, "riskLevel": "Medium"},
            {"name": "SSH / SNMP Management", "category": "Infrastructure", "flows": 2910, "bytesTotalMB": 1420.1, "avgNetworkResponseMs": 1.2, "avgAppResponseMs": 6.5, "riskLevel": "Low"},
            {"name": "BitTorrent / P2P (Blocked)", "category": "Shadow IT", "flows": 42, "bytesTotalMB": 18.4, "avgNetworkResponseMs": 22.0, "avgAppResponseMs": 0.0, "riskLevel": "High"},
        ]

        self.auth_groups: List[Dict[str, Any]] = [
            {"name": "NetOps-Full-NBI", "capabilities": ["Northbound API Read/Write", "Access Control NBI", "Policy NBI", "Workflows Execute", "Inventory Write"], "memberCount": 4},
            {"name": "SIEM-ReadOnly-NBI", "capabilities": ["Northbound API Read", "Access Control NBI Read", "Alarms Read"], "memberCount": 2},
            {"name": "Helpdesk-NAC-Ops", "capabilities": ["Northbound API Read", "Access Control EndSystem Write"], "memberCount": 6},
        ]

        self.api_clients: List[Dict[str, Any]] = [
            {"clientId": "demo-client-id", "name": "XIQ-SE API Studio (Desktop)", "authorizationGroup": "NetOps-Full-NBI", "enabled": True, "lastUsed": "2026-11-23T12:00:00Z"},
            {"clientId": "servicenow-cmdb-sync", "name": "ServiceNow ITSM Connector", "authorizationGroup": "NetOps-Full-NBI", "enabled": True, "lastUsed": "2026-11-23T11:30:00Z"},
            {"clientId": "splunk-siem-collector", "name": "Splunk / Forescout Collector", "authorizationGroup": "SIEM-ReadOnly-NBI", "enabled": True, "lastUsed": "2026-11-23T11:55:00Z"},
        ]

    def _enriched_sites(self) -> List[Dict[str, Any]]:
        out = []
        for s in self.sites:
            item = copy.deepcopy(s)
            item["devList"] = [d["ip"] for d in self.devices if d["sitePath"] == s["location"]]
            out.append(item)
        return out

    def _server_info(self) -> Dict[str, Any]:
        return {
            "version": "25.2.10.14 (Simulateur Démo)",
            "hostName": "xiqse-demo.corp.local",
            "ipAddress": "10.10.0.10",
            "upTime": "68d 12h 44m",
            "cpuPercent": 22,
            "memoryPercent": 54,
            "diskPercent": 37,
            "licenseTier": "XIQ-SE Pilot + ExtremeControl + Analytics",
            "managedDevicesCount": len(self.devices),
            "licensedDevicesMax": 500,
        }

    # ---- Execution Entrypoint ----

    def execute_graphql(
        self,
        query: str,
        variables: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        start = time.perf_counter()
        try:
            parser = _GQLParser(query, variables)
            op_type, selections = parser.parse_document()
            if not selections:
                raise ValueError("Requête GraphQL vide ou syntaxe invalide.")
            if op_type == "mutation":
                data = self._resolve_mutation_root(selections)
            else:
                data = self._resolve_query_root(selections)
            elapsed = max(4, int((time.perf_counter() - start) * 1000))
            return {
                "ok": True,
                "status_code": 200,
                "duration_ms": elapsed,
                "data": data,
                "errors": [],
                "url": "demo://xiqse-demo.corp.local:8443/nbi/graphql",
            }
        except Exception as exc:
            elapsed = max(2, int((time.perf_counter() - start) * 1000))
            return {
                "ok": False,
                "status_code": 200,
                "duration_ms": elapsed,
                "data": None,
                "errors": [{"message": str(exc)}],
                "url": "demo://xiqse-demo.corp.local:8443/nbi/graphql",
            }

    def _resolve_query_root(self, selections: List[Dict[str, Any]]) -> Dict[str, Any]:
        out: Dict[str, Any] = {}
        for sel in selections:
            name = sel["name"]
            alias = sel["alias"]
            if name == "__typename":
                out[alias] = "Query"
            elif name == "__schema":
                out[alias] = _project(self.schema, sel["selections"])
            elif name == "ExtremeApi":
                out[alias] = self._resolve_query_root(sel["selections"])
            elif name == "network":
                out[alias] = self._resolve_network_query(sel["selections"])
            elif name == "accessControl":
                out[alias] = self._resolve_nac_query(sel["selections"])
            elif name == "workflows":
                out[alias] = self._resolve_workflows_query(sel["selections"])
            elif name == "policy":
                out[alias] = self._resolve_policy_query(sel["selections"])
            elif name == "alarms":
                out[alias] = self._resolve_alarms_query(sel["selections"])
            elif name == "analytics":
                out[alias] = self._resolve_analytics_query(sel["selections"])
            elif name == "administration":
                out[alias] = self._resolve_admin_query(sel["selections"])
            elif name == "serverInfo":
                out[alias] = _project(self._server_info(), sel["selections"])
            else:
                out[alias] = None
        return out

    def _resolve_network_query(self, selections: List[Dict[str, Any]]) -> Dict[str, Any]:
        out: Dict[str, Any] = {}
        for sel in selections:
            name, alias, args, sub = sel["name"], sel["alias"], sel["args"], sel["selections"]
            if name == "devices":
                out[alias] = _project(self.devices, sub)
            elif name == "device":
                ip = args.get("ip")
                found = next((d for d in self.devices if d["ip"] == ip), None)
                out[alias] = _project(found, sub)
            elif name == "devicesBySiteLocation":
                loc = args.get("location", "")
                matched = [d for d in self.devices if d["sitePath"].startswith(loc)]
                out[alias] = _project(matched, sub)
            elif name == "sites":
                out[alias] = _project(self._enriched_sites(), sub)
            elif name == "siteByLocation":
                loc = args.get("location", "")
                found = next((s for s in self._enriched_sites() if s["location"] == loc), None)
                out[alias] = _project(found, sub)
            else:
                out[alias] = None
        return out

    def _resolve_nac_query(self, selections: List[Dict[str, Any]]) -> Dict[str, Any]:
        out: Dict[str, Any] = {}
        for sel in selections:
            name, alias, args, sub = sel["name"], sel["alias"], sel["args"], sel["selections"]
            if name == "appliances":
                out[alias] = _project(self.nac_appliances, sub)
            elif name == "endSystems":
                out[alias] = _project(self.end_systems, sub)
            elif name == "allEndSystemMacs":
                out[alias] = [e["macAddress"] for e in self.end_systems]
            elif name == "endSystemByMac":
                mac = (args.get("macAddress") or "").upper()
                found = next((e for e in self.end_systems if e["macAddress"].upper() == mac), None)
                out[alias] = _project({"endSystem": found}, sub)
            elif name == "endSystemGroups":
                out[alias] = _project(self.end_system_groups, sub)
            elif name == "group":
                gname = args.get("name") or ""
                found = next((g for g in self.end_system_groups if g["name"] == gname), None)
                out[alias] = _project(found, sub)
            elif name == "macLocks":
                out[alias] = _project(self.mac_locks, sub)
            elif name == "radiusServers":
                out[alias] = _project(self.radius_servers, sub)
            else:
                out[alias] = None
        return out

    def _resolve_workflows_query(self, selections: List[Dict[str, Any]]) -> Dict[str, Any]:
        out: Dict[str, Any] = {}
        for sel in selections:
            name, alias, sub = sel["name"], sel["alias"], sel["selections"]
            if name == "workflows":
                out[alias] = _project(self.workflows, sub)
            elif name == "executions":
                out[alias] = _project(self.workflow_executions, sub)
            else:
                out[alias] = None
        return out

    def _resolve_policy_query(self, selections: List[Dict[str, Any]]) -> Dict[str, Any]:
        out: Dict[str, Any] = {}
        for sel in selections:
            if sel["name"] == "domains":
                out[sel["alias"]] = _project(self.policy_domains, sel["selections"])
        return out

    def _resolve_alarms_query(self, selections: List[Dict[str, Any]]) -> Dict[str, Any]:
        out: Dict[str, Any] = {}
        for sel in selections:
            if sel["name"] == "activeAlarms":
                out[sel["alias"]] = _project(self.alarms, sel["selections"])
            elif sel["name"] == "recentEvents":
                out[sel["alias"]] = _project(self.events, sel["selections"])
        return out

    def _resolve_analytics_query(self, selections: List[Dict[str, Any]]) -> Dict[str, Any]:
        out: Dict[str, Any] = {}
        for sel in selections:
            if sel["name"] == "topApplications":
                out[sel["alias"]] = _project(self.analytics_apps, sel["selections"])
        return out

    def _resolve_admin_query(self, selections: List[Dict[str, Any]]) -> Dict[str, Any]:
        out: Dict[str, Any] = {}
        for sel in selections:
            if sel["name"] == "serverInfo":
                out[sel["alias"]] = _project(self._server_info(), sel["selections"])
            elif sel["name"] == "authorizationGroups":
                out[sel["alias"]] = _project(self.auth_groups, sel["selections"])
            elif sel["name"] == "apiClients":
                out[sel["alias"]] = _project(self.api_clients, sel["selections"])
        return out

    # ---- Mutations ----

    def _resolve_mutation_root(self, selections: List[Dict[str, Any]]) -> Dict[str, Any]:
        out: Dict[str, Any] = {}
        for sel in selections:
            name, alias, sub = sel["name"], sel["alias"], sel["selections"]
            if name == "network":
                out[alias] = self._resolve_network_mutations(sub)
            elif name == "accessControl":
                out[alias] = self._resolve_nac_mutations(sub)
            elif name == "workflows":
                out[alias] = self._resolve_workflow_mutations(sub)
            elif name == "policy":
                out[alias] = self._resolve_policy_mutations(sub)
            elif name == "alarms":
                out[alias] = self._resolve_alarm_mutations(sub)
            else:
                out[alias] = None
        return out

    def _resolve_network_mutations(self, selections: List[Dict[str, Any]]) -> Dict[str, Any]:
        out: Dict[str, Any] = {}
        for sel in selections:
            name, alias, args, sub = sel["name"], sel["alias"], sel["args"], sel["selections"]
            inp = args.get("input") or {}
            if name == "createSite":
                sname = (inp.get("name") or "Nouveau-Site").strip()
                parent = (inp.get("parentLocation") or "/World/France").rstrip("/")
                full_loc = f"{parent}/{sname}"
                if any(s["location"] == full_loc for s in self.sites):
                    res = {"status": "ERROR", "message": f"Le site {full_loc} existe déjà.", "siteLocation": full_loc}
                else:
                    self.sites.append({
                        "siteId": f"site-{uuid.uuid4().hex[:6]}",
                        "name": sname,
                        "location": full_loc,
                        "parentLocation": parent,
                        "vlans": [{"vid": 10, "name": f"MGMT-{sname.upper()[:8]}", "subnet": "10.99.1.0/24", "isManagement": True}],
                    })
                    res = {"status": "SUCCESS", "message": f"Site '{full_loc}' créé avec succès.", "siteLocation": full_loc}
                out[alias] = _project(res, sub)
            elif name == "createDevices":
                items = inp.get("devices") or []
                added = 0
                for item in items:
                    ip = (item.get("ipAddress") or "").strip()
                    if not ip or any(d["ip"] == ip for d in self.devices):
                        continue
                    loc = item.get("siteLocation") or "/World/France/Paris-HQ"
                    sname = loc.split("/")[-1]
                    sys_name = item.get("sysName") or f"SW-{ip.replace('.', '-')}"
                    self.devices.append({
                        "ip": ip,
                        "sysName": sys_name,
                        "deviceName": sys_name,
                        "baseMac": f"00:04:96:{uuid.uuid4().hex[:2].upper()}:{uuid.uuid4().hex[:2].upper()}:{uuid.uuid4().hex[:2].upper()}",
                        "status": 1,
                        "deviceDisplayFamily": "5420 Series",
                        "firmware": "Switch Engine 32.7.1.9",
                        "sitePath": loc,
                        "sysUpTime": "0d 00h 01m",
                        "sysDescr": f"Extreme Networks Switch provisionné via API ({item.get('profileName') or 'Default'})",
                        "cpuPercent": 12,
                        "memoryPercent": 34,
                        "deviceData": {"vendor": "Extreme Networks", "serialNumber": f"API-{uuid.uuid4().hex[:6].upper()}", "family": "Universal", "subFamily": "5420F-24P"},
                        "siteData": {"siteId": "site-api", "siteName": sname, "location": loc},
                        "interfaces": [
                            {"name": "1:1", "alias": "UPLINK", "adminStatus": "Up", "operStatus": "Up", "speed": "10G", "vlan": "VLAN-10", "poePowerWatts": 0.0},
                            {"name": "1:2", "alias": "ACCESS", "adminStatus": "Up", "operStatus": "Up", "speed": "1G", "vlan": "VLAN-20", "poePowerWatts": 8.2},
                        ],
                    })
                    added += 1
                res = {"status": "SUCCESS" if added else "ERROR", "message": f"{added} équipement(s) ajouté(s) à l'inventaire XIQ-SE." if added else "Aucun nouvel équipement ajouté (IP vide ou doublon)."}
                out[alias] = _project(res, sub)
            elif name == "deleteDevices":
                ips = set(inp.get("ipAddresses") or [])
                before = len(self.devices)
                self.devices = [d for d in self.devices if d["ip"] not in ips]
                removed = before - len(self.devices)
                res = {"status": "SUCCESS" if removed else "ERROR", "message": f"{removed} équipement(s) supprimé(s)." if removed else "Aucun équipement correspondant trouvé."}
                out[alias] = _project(res, sub)
        return out

    def _resolve_nac_mutations(self, selections: List[Dict[str, Any]]) -> Dict[str, Any]:
        out: Dict[str, Any] = {}
        for sel in selections:
            name, alias, args, sub = sel["name"], sel["alias"], sel["args"], sel["selections"]
            inp = args.get("input") or {}
            if name in ("addMACToEndSystemGroup", "addIPToEndSystemGroup", "addHostnameToEndSystemGroup", "addEntryToGroup"):
                gname = (inp.get("groupName") or "").strip()
                entry = (inp.get("entry") or "").strip()
                grp = next((g for g in self.end_system_groups if g["name"] == gname), None)
                if not grp:
                    grp = {"name": gname, "type": "MAC", "description": inp.get("description") or "Créé via API", "entries": []}
                    self.end_system_groups.append(grp)
                if entry and entry not in grp["entries"]:
                    grp["entries"].append(entry)
                res = {"status": "SUCCESS", "message": f"Entrée '{entry}' ajoutée au groupe '{gname}'."}
                out[alias] = _project(res, sub)
            elif name == "removeEntryFromGroup":
                gname = (inp.get("groupName") or "").strip()
                entry = (inp.get("entry") or "").strip()
                grp = next((g for g in self.end_system_groups if g["name"] == gname), None)
                if grp and entry in grp["entries"]:
                    grp["entries"].remove(entry)
                    res = {"status": "SUCCESS", "message": f"Entrée '{entry}' retirée du groupe '{gname}'."}
                else:
                    res = {"status": "ERROR", "message": f"Entrée '{entry}' introuvable dans '{gname}'."}
                out[alias] = _project(res, sub)
            elif name == "addMACToBlacklist":
                entry = (inp.get("entry") or "").strip().upper()
                bl = next((g for g in self.end_system_groups if g["name"] == "Blacklist"), None)
                if bl and entry and entry not in bl["entries"]:
                    bl["entries"].append(entry)
                for es in self.end_systems:
                    if es["macAddress"].upper() == entry:
                        es["state"] = "Quarantine"
                        es["profile"] = "Quarantine-Deny"
                        es["vlan"] = "99"
                res = {"status": "SUCCESS", "message": f"Adresse MAC '{entry}' ajoutée à la Blacklist ExtremeControl."}
                out[alias] = _project(res, sub)
            elif name == "createMacLock":
                mac = (inp.get("macAddress") or "").strip().upper()
                sw = (inp.get("switchIp") or "").strip()
                port = (inp.get("portName") or "").strip()
                self.mac_locks.append({
                    "id": f"ml-{uuid.uuid4().hex[:5]}",
                    "macAddress": mac,
                    "switchIp": sw,
                    "portName": port,
                    "createdAt": datetime.now(timezone.utc).isoformat(),
                })
                res = {"status": "SUCCESS", "message": f"MAC Lock activé : {mac} verrouillé sur {sw} port {port}."}
                out[alias] = _project(res, sub)
            elif name == "deleteMacLock":
                mac = (inp.get("macAddress") or "").strip().upper()
                before = len(self.mac_locks)
                self.mac_locks = [m for m in self.mac_locks if m["macAddress"].upper() != mac]
                res = {"status": "SUCCESS" if len(self.mac_locks) < before else "ERROR", "message": f"MAC Lock supprimé pour {mac}."}
                out[alias] = _project(res, sub)
            elif name == "createRadiusServer":
                rname = (inp.get("name") or "RADIUS-NEW").strip()
                rip = (inp.get("ipAddress") or "").strip()
                rport = int(inp.get("authPort") or 1812)
                self.radius_servers.append({"name": rname, "ipAddress": rip, "authPort": rport, "status": "Reachable"})
                res = {"status": "SUCCESS", "message": f"Serveur RADIUS '{rname}' ({rip}:{rport}) enregistré."}
                out[alias] = _project(res, sub)
            elif name == "reauthenticateEndSystem":
                mac = (inp.get("macAddress") or "").strip().upper()
                res = {"status": "SUCCESS", "message": f"Signal CoA / Ré-authentification envoyé pour {mac}."}
                out[alias] = _project(res, sub)
        return out

    def _resolve_workflow_mutations(self, selections: List[Dict[str, Any]]) -> Dict[str, Any]:
        out: Dict[str, Any] = {}
        for sel in selections:
            if sel["name"] == "startWorkflow":
                inp = sel["args"].get("input") or {}
                wf_id = inp.get("id") or ""
                vars_raw = inp.get("variables") or "[]"
                wf = next((w for w in self.workflows if w["id"] == wf_id), None)
                wf_name = wf["name"] if wf else f"Workflow {wf_id}"
                exec_id = f"exec-{uuid.uuid4().hex[:6]}"
                self.workflow_executions.insert(0, {
                    "executionId": exec_id,
                    "workflowId": wf_id,
                    "workflowName": wf_name,
                    "status": "Completed",
                    "startedAt": datetime.now(timezone.utc).isoformat(),
                    "durationMs": 840,
                    "variablesJson": vars_raw if isinstance(vars_raw, str) else json.dumps(vars_raw),
                    "outputMessage": f"Workflow '{wf_name}' exécuté avec succès (simulation).",
                })
                res = {
                    "executionId": exec_id,
                    "success": True,
                    "statusmessage": f"Workflow '{wf_name}' démarré et terminé (ID: {exec_id}).",
                }
                out[sel["alias"]] = _project(res, sel["selections"])
        return out

    def _resolve_policy_mutations(self, selections: List[Dict[str, Any]]) -> Dict[str, Any]:
        out: Dict[str, Any] = {}
        for sel in selections:
            if sel["name"] == "enforcePolicy":
                inp = sel["args"].get("input") or {}
                dname = inp.get("domainName") or ""
                dom = next((d for d in self.policy_domains if d["name"] == dname), None)
                if dom:
                    dom["lastEnforced"] = datetime.now(timezone.utc).isoformat()
                    res = {"status": "SUCCESS", "message": f"Enforce Policy terminé sur le domaine '{dname}' ({dom['deviceCount']} équipements synchronisés)."}
                else:
                    res = {"status": "ERROR", "message": f"Domaine Policy '{dname}' introuvable."}
                out[sel["alias"]] = _project(res, sel["selections"])
        return out

    def _resolve_alarm_mutations(self, selections: List[Dict[str, Any]]) -> Dict[str, Any]:
        out: Dict[str, Any] = {}
        for sel in selections:
            name, alias, args, sub = sel["name"], sel["alias"], sel["args"], sel["selections"]
            inp = args.get("input") or {}
            aid = inp.get("id") or ""
            if name == "acknowledgeAlarm":
                alm = next((a for a in self.alarms if a["id"] == aid), None)
                if alm:
                    alm["acknowledged"] = True
                    res = {"status": "SUCCESS", "message": f"Alarme {aid} acquittée."}
                else:
                    res = {"status": "ERROR", "message": f"Alarme {aid} introuvable."}
                out[alias] = _project(res, sub)
            elif name == "clearAlarm":
                before = len(self.alarms)
                self.alarms = [a for a in self.alarms if a["id"] != aid]
                res = {"status": "SUCCESS" if len(self.alarms) < before else "ERROR", "message": f"Alarme {aid} clôturée et supprimée."}
                out[alias] = _project(res, sub)
        return out
