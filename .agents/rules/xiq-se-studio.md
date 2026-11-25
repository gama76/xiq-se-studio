---
trigger: always_on
---

# XIQ-SE API Studio — Contexte & Règles Projet

## 1. Identité du projet & préférences utilisateur
- **Objectif** : Application desktop Windows autonome (`dist/XIQ-SE-Studio.exe`) permettant d'exploiter l'API Northbound Interface (NBI) GraphQL d'**ExtremeCloud IQ - Site Engine (XIQ-SE)** (ex-XMC / NetSight), avec un **Mode Démo (simulateur intégré)** et la connexion à de vrais serveurs XIQ-SE (OAuth 2.0, Basic Auth, Bearer Token).
- **Langue** : Toujours répondre en **français**. Tous les libellés d'interface, notifications (toasts), exports et messages d'erreur doivent être en français.
- **Livrable final attendu** : Après toute modification de code, exécuter la suite de tests automatisés puis **recompiler `dist/XIQ-SE-Studio.exe`** (et rappeler à l'utilisateur de fermer l'ancienne fenêtre avant de relancer l'exécutable).

## 2. Architecture & fichiers clés
- **Runtime** : Python 3.11 dans `.venv` (Node.js n'est pas installé sur cette machine). Le frontend est en **HTML / CSS / JavaScript vanilla** (sans étape de build JS).
- **Point d'entrée** : `app.py` (serveur HTTP local embarqué + fenêtre native `pywebview` / WebView2 avec repli navigateur automatique via `--browser`, ou `--headless`).
- **Backend (`backend/`)** :
  - `server.py` : serveur HTTP local threadé + API REST interne (`/api/graphql`, `/api/profiles`, `/api/schema`, `/api/history`, `/api/favorites`, `/api/audit-summary`, `/api/codegen`, etc.).
  - `xiqse_client.py` : client HTTP/OAuth2/GraphQL vers XIQ-SE réel (certificats auto-signés tolérés quand `verify_ssl=False`, cache de tokens OAuth2, introspection `__schema`).
  - `mock_engine.py` : moteur GraphQL simulé avec schéma complet (57+ types), mutations persistantes en mémoire et données réalistes Extreme Networks.
  - `storage.py` : persistance locale dans `%APPDATA%\XIQ-SE-Studio` (`profiles.json`, `history.json`, `favorites.json`, `audit_summaries.json`, `schemas/`). Toujours utiliser `self._lock` (`RLock`) et écritures atomiques par fichier temporaire unique (requêtes parallèles depuis le frontend).
  - `templates_catalog.py` : catalogue de 24+ modèles GraphQL prêts à l'emploi.
  - `code_generator.py` : génération d'extraits Python (`requests`), cURL et PowerShell (`Invoke-RestMethod`).
- **Frontend (`frontend/`)** :
  - `index.html`, `styles.css` : shell applicatif (thème sombre/clair, recherche globale `Ctrl+K`, modales, toasts).
  - `js/api.js` : wrapper HTTP vers le backend local, exports CSV/JSON, liens cliquables MAC / IP switch.
  - `js/schema_tools.js` : indexation du schéma GraphQL introspecté ou importé, génération dynamique de requêtes/mutations (`buildAdaptiveDomainQuery`, `buildSafeArgs`, `toGraphQLValue`).
  - `js/views_ops.js` : vues opérationnelles adaptatives au schéma (`dashboard`, `network`, `nac`, `mac_audit`, `suggestions`, `alarms`, `admin` + helpers `runAdaptive` et `runAdaptivePaginated`).
  - `js/views_tools.js` : outils NetOps (`Localisateur Express`, import CSV en masse dans les groupes NAC, rapport d'inventaire complet, résolution des noms de ports switch).
  - `js/views_studio.js` : Studio GraphQL (introspection 100 %, import `NBI Schema (JSON)`, éditeur, modèles, favoris, historique, vue JSON/Tableau, générateur de code).
  - `js/app.js` : contrôleur principal, navigation et gestionnaire des profils de connexion.

## 3. Modules visibles & préférences UI
- **Sidebar active** (`frontend/index.html`) :
  - *Vue d'ensemble* : Tableau de bord, Localisateur Express.
  - *Domaines API NBI* : Réseau & Inventaire, Contrôle d'accès (NAC), Audit MAC & Doublons, Suggestions Nettoyage, Alarmes & Événements.
  - *Exploitation 100% API* : Studio GraphQL, Administration & Guide.
- Les entrées **Workflows** et **Policy** ont été volontairement retirées de la barre latérale à la demande de l'utilisateur (tout en restant exploitables via le Studio GraphQL) — ne pas les ré-ajouter au menu sans demande explicite.
- **Sécurité des opérations NAC** : Toujours proposer une **sauvegarde / export CSV** avant toute suppression en masse de MAC dans les groupes NAC (Audit MAC & Doublons, Suggestions de Nettoyage).

## 4. Spécificités réelles XIQ-SE NBI GraphQL à respecter
- **Toujours rester adaptatif au schéma** : Les noms de champs/arguments varient selon les versions de XIQ-SE. Utiliser `SchemaTools` + `runAdaptive` / `runAdaptivePaginated` plutôt que des requêtes figées dans les vues opérationnelles.
- **Pagination universelle** :
  - `network.devices` pagine généralement par **numéro de page** (`pageNumber` / `pageSize`, base 1 ou 0), tandis que `accessControl.endSystems` pagine par **offset** (`firstResult` / `maxResults`).
  - `runAdaptivePaginated` gère automatiquement offset, numéro de page, `INPUT_OBJECT` et taille seule par tranches sûres de 250 éléments, piloté par le sélecteur **Portée** (`250`, `1000`, `2500`, `5000`, `all`).
- **Spécificités NAC (`accessControl`)** :
  - `endSystems` peut retourner un wrapper objet (`WsEndSystemListResult` contenant `endSystem` / `endSystems`).
  - Les groupes NAC exposent leurs membres sous `values`, `entries` ou `members`, et peuvent nécessiter une requête par groupe (`group(name: ...)`, optimisée par lots aliasés `g0: group(...)`).
  - Dans **Groupes & Blacklist**, conserver la **dissociation par type de groupe** (`Blacklist / Quarantaine`, `Endpoint / MAC`, `Location / Emplacement`, `IP / Hostname`, `Utilisateurs / LDAP`, `Plages Horaires`, etc.) avec filtres rapides et compteurs.
  - Quand XIQ-SE renvoie un identifiant numérique de port sur un End-System, utiliser `NetOpsTools.buildSwitchPortLookupMap` / `resolveEndSystemPortDisplay` pour afficher le nom lisible du port.

## 5. Tests & Compilation `.exe`
- **Tests automatisés** (à exécuter systématiquement après modification) :
  ```powershell
  .\.venv\Scripts\python.exe tests\test_app.py
  ```
- **Compilation de l'exécutable Windows** :
  ```powershell
  .\build_exe.ps1
  ```
  *(Si un nouveau module Python est ajouté sous `backend/`, penser à ajouter son `--hidden-import` dans `build_exe.ps1`.)*
