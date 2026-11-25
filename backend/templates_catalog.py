"""Curated library of XIQ-SE NBI GraphQL Queries and Mutations across all domains."""

from typing import Any, Dict, List


GRAPHQL_TEMPLATES: List[Dict[str, Any]] = [
    # ---- NETWORK & INVENTORY ----
    {
        "id": "tpl-net-devices",
        "domain": "network",
        "type": "query",
        "name": "Lister tous les équipements réseau",
        "description": "Récupère l'inventaire complet des switches, routeurs et AP gérés par XIQ-SE.",
        "query": """query GetAllDevices {
  network {
    devices {
      ip
      sysName
      deviceName
      baseMac
      status
      deviceDisplayFamily
      firmware
      sitePath
      sysUpTime
      deviceData {
        vendor
        serialNumber
        family
        subFamily
      }
    }
  }
}""",
        "variables": {},
    },
    {
        "id": "tpl-net-device-detail",
        "domain": "network",
        "type": "query",
        "name": "Détails & Ports d'un équipement par IP",
        "description": "Récupère les informations détaillées et la liste des interfaces/ports d'un équipement.",
        "query": """query GetDeviceDetails($ip: String!) {
  network {
    device(ip: $ip) {
      ip
      sysName
      baseMac
      firmware
      status
      sitePath
      sysDescr
      interfaces {
        name
        alias
        adminStatus
        operStatus
        speed
        vlan
        poePowerWatts
      }
    }
  }
}""",
        "variables": {"ip": "10.10.1.11"},
    },
    {
        "id": "tpl-net-devices-by-site",
        "domain": "network",
        "type": "query",
        "name": "Équipements par emplacement de site",
        "description": "Filtre les équipements appartenant à un chemin de site XIQ-SE spécifique.",
        "query": """query GetDevicesBySite($location: String!) {
  network {
    devicesBySiteLocation(location: $location) {
      ip
      sysName
      deviceDisplayFamily
      firmware
      status
      sitePath
    }
  }
}""",
        "variables": {"location": "/World/France/Paris-HQ"},
    },
    {
        "id": "tpl-net-site-vlans",
        "domain": "network",
        "type": "query",
        "name": "Détails d'un site & ses VLANs",
        "description": "Interroge un site par son chemin hiérarchique avec ses équipements et VLANs associés.",
        "query": """query GetSiteVlans($location: String!) {
  network {
    siteByLocation(location: $location) {
      name
      location
      devList
      vlans {
        vid
        name
        subnet
        isManagement
      }
    }
  }
}""",
        "variables": {"location": "/World/France/Paris-HQ"},
    },
    {
        "id": "tpl-net-create-site",
        "domain": "network",
        "type": "mutation",
        "name": "Créer un nouveau site (createSite)",
        "description": "Crée un conteneur de site dans l'arborescence topologique XIQ-SE.",
        "query": """mutation CreateSite($name: String!, $parentLocation: String!) {
  network {
    createSite(input: { name: $name, parentLocation: $parentLocation }) {
      status
      message
      siteLocation
    }
  }
}""",
        "variables": {"name": "Agence-Bordeaux", "parentLocation": "/World/France"},
    },
    {
        "id": "tpl-net-create-device",
        "domain": "network",
        "type": "mutation",
        "name": "Ajouter un équipement (createDevices)",
        "description": "Enrôle un nouvel équipement réseau dans XIQ-SE et l'assigne à un site.",
        "query": """mutation CreateDevice($ip: String!, $sysName: String!, $siteLocation: String!, $profileName: String!) {
  network {
    createDevices(
      input: {
        devices: [
          {
            ipAddress: $ip
            sysName: $sysName
            siteLocation: $siteLocation
            profileName: $profileName
          }
        ]
      }
    ) {
      status
      message
    }
  }
}""",
        "variables": {
            "ip": "10.10.5.21",
            "sysName": "SW-BDX-ACC-01",
            "siteLocation": "/World/France/Paris-HQ",
            "profileName": "SNMPv3-Prod",
        },
    },
    {
        "id": "tpl-net-delete-device",
        "domain": "network",
        "type": "mutation",
        "name": "Supprimer un équipement (deleteDevices)",
        "description": "Décommissionne un ou plusieurs équipements de l'inventaire XIQ-SE.",
        "query": """mutation DeleteDevice($ip: String!) {
  network {
    deleteDevices(input: { ipAddresses: [$ip] }) {
      status
      message
    }
  }
}""",
        "variables": {"ip": "10.10.5.21"},
    },
    # ---- ACCESS CONTROL / NAC ----
    {
        "id": "tpl-nac-appliances",
        "domain": "accessControl",
        "type": "query",
        "name": "Engines / Appliances ExtremeControl (NAC)",
        "description": "Liste tous les moteurs NAC ExtremeControl et leur état de santé.",
        "query": """query GetNacAppliances {
  accessControl {
    appliances {
      ipAddress
      displayName
      status
      version
      activeEndSystems
      engineGroup
    }
  }
}""",
        "variables": {},
    },
    {
        "id": "tpl-nac-endsystems",
        "domain": "accessControl",
        "type": "query",
        "name": "Lister les End-Systems connectés",
        "description": "Récupère les postes, téléphones IP, IoT et terminaux authentifiés sur le réseau.",
        "query": """query GetEndSystems {
  accessControl {
    endSystems {
      macAddress
      ipAddress
      username
      hostName
      switchIp
      switchPort
      authType
      profile
      vlan
      state
      lastSeenTime
    }
  }
}""",
        "variables": {},
    },
    {
        "id": "tpl-nac-endsystem-mac",
        "domain": "accessControl",
        "type": "query",
        "name": "Rechercher un End-System par MAC",
        "description": "Interroge l'état détaillé d'un terminal précis via son adresse MAC.",
        "query": """query GetEndSystemByMac($mac: String!) {
  accessControl {
    endSystemByMac(macAddress: $mac) {
      endSystem {
        macAddress
        ipAddress
        username
        hostName
        switchIp
        switchPort
        authType
        profile
        vlan
        state
        lastSeenTime
      }
    }
  }
}""",
        "variables": {"mac": "00:1A:2B:3C:4D:01"},
    },
    {
        "id": "tpl-nac-add-mac-group",
        "domain": "accessControl",
        "type": "mutation",
        "name": "Ajouter une MAC à un groupe End-System",
        "description": "Ajoute dynamiquement une adresse MAC dans un groupe ExtremeControl.",
        "query": """mutation AddMacToGroup($groupName: String!, $mac: String!, $description: String) {
  accessControl {
    addMACToEndSystemGroup(
      input: {
        groupName: $groupName
        entry: $mac
        description: $description
      }
    ) {
      status
      message
    }
  }
}""",
        "variables": {
            "groupName": "Corporate-Laptops",
            "mac": "AA:BB:CC:DD:EE:01",
            "description": "Ajout via XIQ-SE API Studio",
        },
    },
    {
        "id": "tpl-nac-add-ip-group",
        "domain": "accessControl",
        "type": "mutation",
        "name": "Ajouter une IP à un groupe End-System",
        "description": "Ajoute une adresse IP à un groupe d'End-Systems NAC.",
        "query": """mutation AddIpToGroup($groupName: String!, $ip: String!) {
  accessControl {
    addIPToEndSystemGroup(
      input: { groupName: $groupName, entry: $ip }
    ) {
      status
      message
    }
  }
}""",
        "variables": {"groupName": "IoT-Cameras", "ip": "10.20.30.55"},
    },
    {
        "id": "tpl-nac-blacklist",
        "domain": "accessControl",
        "type": "mutation",
        "name": "Blacklister une adresse MAC (Quarantaine)",
        "description": "Place immédiatement une adresse MAC dans le groupe système Blacklist.",
        "query": """mutation BlacklistMac($mac: String!, $description: String) {
  accessControl {
    addMACToBlacklist(
      input: { entry: $mac, description: $description }
    ) {
      status
      message
    }
  }
}""",
        "variables": {
            "mac": "DE:AD:BE:EF:99:01",
            "description": "Poste compromis isolé via API",
        },
    },
    {
        "id": "tpl-nac-maclock",
        "domain": "accessControl",
        "type": "mutation",
        "name": "Verrouiller une MAC sur un port (createMacLock)",
        "description": "Verrouille statiquement une adresse MAC sur un switch et un port précis.",
        "query": """mutation CreateMacLock($mac: String!, $switchIp: String!, $port: String!) {
  accessControl {
    createMacLock(
      input: {
        macAddress: $mac
        switchIp: $switchIp
        portName: $port
      }
    ) {
      status
      message
    }
  }
}""",
        "variables": {
            "mac": "00:1A:2B:3C:4D:01",
            "switchIp": "10.10.1.11",
            "port": "1:5",
        },
    },
    {
        "id": "tpl-nac-radius",
        "domain": "accessControl",
        "type": "mutation",
        "name": "Créer un serveur RADIUS (createRadiusServer)",
        "description": "Configure un nouveau serveur RADIUS externe dans ExtremeControl.",
        "query": """mutation CreateRadiusServer($name: String!, $ip: String!, $port: Int!, $secret: String!) {
  accessControl {
    createRadiusServer(
      input: {
        name: $name
        ipAddress: $ip
        authPort: $port
        sharedSecret: $secret
      }
    ) {
      status
      message
    }
  }
}""",
        "variables": {
            "name": "RADIUS-AD-Backup",
            "ip": "10.10.0.22",
            "port": 1812,
            "secret": "ChangeMeSecret!",
        },
    },
    # ---- WORKFLOWS ----
    {
        "id": "tpl-wf-list",
        "domain": "workflows",
        "type": "query",
        "name": "Lister les Workflows XIQ-SE",
        "description": "Récupère la liste des workflows d'automatisation disponibles et leurs paramètres.",
        "query": """query ListWorkflows {
  workflows {
    workflows {
      id
      name
      category
      description
      isSystem
      variables {
        name
        type
        defaultValue
        required
      }
    }
  }
}""",
        "variables": {},
    },
    {
        "id": "tpl-wf-start",
        "domain": "workflows",
        "type": "mutation",
        "name": "Exécuter un Workflow (startWorkflow)",
        "description": "Déclenche l'exécution d'un workflow XIQ-SE en passant ses variables d'entrée.",
        "query": """mutation StartWorkflow($id: String!, $variables: String) {
  workflows {
    startWorkflow(input: { id: $id, variables: $variables }) {
      executionId
      success
      statusmessage
    }
  }
}""",
        "variables": {
            "id": "wf-backup-configs",
            "variables": "[{\"name\": \"siteLocation\", \"value\": \"/World/France/Paris-HQ\"}]",
        },
    },
    # ---- POLICY ----
    {
        "id": "tpl-policy-domains",
        "domain": "policy",
        "type": "query",
        "name": "Domaines, Rôles & Règles Policy",
        "description": "Consulte la configuration Extreme Policy (domaines, rôles, VLANs et services).",
        "query": """query GetPolicyDomains {
  policy {
    domains {
      name
      description
      deviceCount
      lastEnforced
      roles {
        name
        defaultVlan
        cos
        rulesCount
      }
    }
  }
}""",
        "variables": {},
    },
    {
        "id": "tpl-policy-enforce",
        "domain": "policy",
        "type": "mutation",
        "name": "Appliquer la politique (enforcePolicy)",
        "description": "Déclenche un Enforce Policy sur un domaine donné.",
        "query": """mutation EnforcePolicy($domainName: String!) {
  policy {
    enforcePolicy(input: { domainName: $domainName }) {
      status
      message
    }
  }
}""",
        "variables": {"domainName": "Enterprise-Campus"},
    },
    # ---- ALARMS & EVENTS ----
    {
        "id": "tpl-alarms-active",
        "domain": "alarms",
        "type": "query",
        "name": "Alarmes actives du réseau",
        "description": "Récupère toutes les alarmes actives (Critique, Erreur, Avertissement, Info).",
        "query": """query GetActiveAlarms {
  alarms {
    activeAlarms {
      id
      severity
      sourceIp
      sourceName
      category
      message
      timestamp
      acknowledged
    }
  }
}""",
        "variables": {},
    },
    {
        "id": "tpl-alarms-ack",
        "domain": "alarms",
        "type": "mutation",
        "name": "Acquitter une alarme (acknowledgeAlarm)",
        "description": "Marque une alarme active comme acquittée par l'opérateur.",
        "query": """mutation AcknowledgeAlarm($id: String!) {
  alarms {
    acknowledgeAlarm(input: { id: $id }) {
      status
      message
    }
  }
}""",
        "variables": {"id": "ALM-1001"},
    },
    # ---- ANALYTICS ----
    {
        "id": "tpl-analytics-apps",
        "domain": "analytics",
        "type": "query",
        "name": "Top Applications (ExtremeAnalytics)",
        "description": "Consulte la visibilité applicative, bande passante et temps de réponse.",
        "query": """query GetTopApplications {
  analytics {
    topApplications {
      name
      category
      flows
      bytesTotalMB
      avgNetworkResponseMs
      avgAppResponseMs
      riskLevel
    }
  }
}""",
        "variables": {},
    },
    # ---- ADMINISTRATION ----
    {
        "id": "tpl-admin-server",
        "domain": "administration",
        "type": "query",
        "name": "Informations Serveur & Licences XIQ-SE",
        "description": "Vérifie la version XIQ-SE, la santé système, les licences et les clients API.",
        "query": """query GetServerInfo {
  administration {
    serverInfo {
      version
      hostName
      ipAddress
      upTime
      cpuPercent
      memoryPercent
      diskPercent
      licenseTier
      managedDevicesCount
      licensedDevicesMax
    }
    authorizationGroups {
      name
      capabilities
      memberCount
    }
    apiClients {
      clientId
      name
      authorizationGroup
      enabled
      lastUsed
    }
  }
}""",
        "variables": {},
    },
    # ---- INTROSPECTION ----
    {
        "id": "tpl-introspection-roots",
        "domain": "introspection",
        "type": "query",
        "name": "Découvrir toutes les Queries & Mutations du serveur",
        "description": "Introspection GraphQL rapide des domaines racines exposés par votre version de XIQ-SE.",
        "query": """query DiscoverRootFields {
  __schema {
    queryType {
      name
      fields {
        name
        description
      }
    }
    mutationType {
      name
      fields {
        name
        description
      }
    }
  }
}""",
        "variables": {},
    },
]
