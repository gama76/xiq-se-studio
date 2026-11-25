# XIQ-SE API Studio (Extreme Networks)

Application Windows autonome (`.exe`) permettant d'exploiter **100 % des possibilités de l'API NBI GraphQL d'ExtremeCloud IQ - Site Engine (XIQ-SE)** (anciennement XMC / NetSight).

## Lancer l'application

### Option 1 — Exécutable Windows autonome (sans Python)
Téléchargez `XIQ-SE-Studio.exe` depuis la section **Releases** du dépôt GitHub (ou compilez-le localement via `.\build_exe.ps1`), puis double-cliquez simplement sur :
- `XIQ-SE-Studio.exe`

### Option 2 — Depuis les sources (Python 3.11+)
```powershell
git clone <URL_DU_DEPOT>
cd xiq-se-studio
python -m venv .venv
.\.venv\Scripts\pip.exe install -r requirements.txt
.\.venv\Scripts\python.exe app.py
```

Au premier lancement, l'application démarre en **Mode Démo (Simulateur XIQ-SE)** afin que vous puissiez explorer tous les modules immédiatement sans connexion réseau. Cliquez sur **« Gérer les connexions »** (en bas à gauche) pour ajouter votre serveur XIQ-SE réel.

Options de lancement en ligne de commande (via Python ou l'exécutable) :
- `--browser` : ouvre l'interface dans le navigateur par défaut au lieu de la fenêtre native WebView2.
- `--headless` : démarre uniquement le serveur HTTP local.
- `--port <N>` : choisit un port TCP fixe (`0` = automatique).

## Fonctionnalités incluses

1. **Tableau de bord** : vue globale des équipements Up/Down, sites, santé du serveur XIQ-SE et **panneau Statistiques NAC** (moteurs ExtremeControl, répartition Acceptés / Quarantaine-Rejetés / Autres, vus < 24h, Top Profils, méthodes d'authentification, Top VLANs NAC et raccourcis Hygiène NAC).
2. **Localisateur Express (`Ctrl+K`)** : recherche instantanée par adresse MAC, IP, utilisateur ou nom d'hôte, avec résolution du **nom + IP cliquable du switch**, nom physique lisible du port, PoE, VLAN et groupes NAC (copie rapide `⧉` / clic droit sur toutes les IP et MAC).
3. **Réseau & Inventaire (`network`)** : inventaire complet des switches/AP/routeurs avec **sélecteur de portée paginé** (`250`, `1 000`, `2 500`, `5 000`, `Toute la base`, compatible `pageNumber`/`pageSize` et `firstResult`/`maxResults`), IP de switch cliquables, inspection des ports/interfaces (statut, vitesse, VLAN, PoE), rapport d'inventaire complet et export CSV.
4. **Contrôle d'accès / NAC (`accessControl`)** :
   - **End-Systems** avec portée paginée, recherche rapide sur toute la base chargée, résolution des noms de ports switch et ré-authentification CoA.
   - **Groupes & Blacklist** avec **dissociation automatique par type de groupe** (*Blacklist / Quarantaine*, *Endpoint / MAC*, *Location / Emplacement*, *IP / Hostname*, *Utilisateurs / LDAP*, *Plages Horaires*, etc.), filtres rapides, consultation des membres, ajout manuel et **Import CSV en masse**.
   - **Engines ExtremeControl**, **MAC Locks** et **Serveurs RADIUS**.
5. **Audit MAC & Doublons** : détection automatique des adresses MAC présentes dans les groupes NAC mais jamais vues sur le réseau ainsi que des MAC en doublon dans plusieurs groupes, fiche endpoint cliquable, sauvegarde CSV et nettoyage assisté.
6. **Suggestions Nettoyage** : recommandations ciblées d'hygiène NAC (**Doublons identifiés**, **Conflits Sécurité** Blacklist/Quarantaine + groupe autorisé, et **MAC inactives > 1 an**) avec validation humaine obligatoire et export CSV automatique avant suppression.
7. **Alarmes & Événements (`alarms`)** : auto-découverte du schéma, filtrage par sévérité, acquittement (`acknowledgeAlarm`), clôture (`clearAlarm`), alertes de disponibilité équipements Down et historique des événements.
8. **Studio GraphQL — 100 % de l'API** :
   - **Introspection Live (`__schema`)** sur votre serveur XIQ-SE connecté (y compris `workflows`, `policy`, `analytics` et tout champ spécifique à votre version).
   - **Import de fichier `NBI Schema (JSON)`** (exporté depuis *Diagnostics > Server > Server Utilities > NBI Schema (JSON)* dans XIQ-SE).
   - **Génération automatique** de requêtes et mutations valides en cliquant sur n'importe quel champ du schéma.
   - **24 modèles GraphQL** prêts à l'emploi, Favoris, Historique, Vue JSON & Vue Tableau exportable en CSV.
   - **Générateur de code** instantané vers **Python (`requests`)**, **cURL** et **PowerShell (`Invoke-RestMethod`)**.
9. **Administration & Guide** : informations serveur XIQ-SE, groupes d'autorisation, clients API et guide rapide de configuration.

## Connexion à un serveur XIQ-SE réel

1. Dans XIQ-SE, ouvrez **Administration > Users > Authorization Groups** et créez un groupe avec les droits **Northbound API** (Read/Write, Access Control NBI, Policy NBI).
2. Ouvrez **Administration > Client API Access** pour créer un client OAuth 2.0 (**Client ID** & **Client Secret**) lié à ce groupe.
3. Dans **XIQ-SE API Studio**, cliquez sur **Gérer les connexions > + Nouveau serveur** et renseignez :
   - IP/FQDN du serveur XIQ-SE (port `8443` par défaut, chemin `/nbi/graphql`)
   - Authentification **OAuth 2.0** (ou **Basic Auth** / **Bearer Token**)
   - Laissez **Vérifier le certificat SSL** décoché si votre appliance utilise un certificat auto-signé.

## Développement, tests & compilation

Les données locales (profils, favoris, historique, schémas importés) sont stockées dans `%APPDATA%\XIQ-SE-Studio`.

Exécuter la suite de tests automatisés :
```powershell
.\.venv\Scripts\python.exe tests\test_app.py
```

Recompiler l'exécutable autonome (`dist\XIQ-SE-Studio.exe`) :
```powershell
.\build_exe.ps1
```

> Pour distribuer `XIQ-SE-Studio.exe` sur GitHub, publiez le binaire dans **GitHub Releases** (le dossier `dist/` est ignoré par Git).

## Licence

Distribué sous licence [MIT](LICENSE).
