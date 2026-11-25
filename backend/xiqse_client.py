"""Live HTTP / OAuth2 / GraphQL client for ExtremeCloud IQ - Site Engine (XIQ-SE) NBI."""

import threading
import time
from typing import Any, Dict, List, Optional, Tuple
import requests
import urllib3
from requests.adapters import HTTPAdapter
from requests.auth import HTTPBasicAuth


INTROSPECTION_QUERY = """
query IntrospectionQuery {
  __schema {
    queryType { name }
    mutationType { name }
    subscriptionType { name }
    types {
      ...FullType
    }
  }
}

fragment FullType on __Type {
  kind
  name
  description
  fields(includeDeprecated: true) {
    name
    description
    args {
      ...InputValue
    }
    type {
      ...TypeRef
    }
    isDeprecated
    deprecationReason
  }
  inputFields {
    ...InputValue
  }
  interfaces {
    ...TypeRef
  }
  enumValues(includeDeprecated: true) {
    name
    description
    isDeprecated
    deprecationReason
  }
  possibleTypes {
    ...TypeRef
  }
}

fragment InputValue on __InputValue {
  name
  description
  type { ...TypeRef }
  defaultValue
}

fragment TypeRef on __Type {
  kind
  name
  ofType {
    kind
    name
    ofType {
      kind
      name
      ofType {
        kind
        name
        ofType {
          kind
          name
          ofType {
            kind
            name
          }
        }
      }
    }
  }
}
""".strip()


class XIQSEClient:
    """Handles OAuth2 / Basic / Bearer auth and GraphQL execution against XIQ-SE NBI."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._token_cache: Dict[str, Dict[str, Any]] = {}
        self._sessions: Dict[bool, requests.Session] = {}

    def _base_url(self, profile: Dict[str, Any]) -> str:
        proto = (profile.get("protocol") or "https").strip().rstrip(":/")
        host = (profile.get("host") or "").strip().rstrip("/")
        port = int(profile.get("port") or 8443)
        if not host:
            raise ValueError("L'adresse (IP ou FQDN) du serveur XIQ-SE est requise.")
        if (proto == "https" and port == 443) or (proto == "http" and port == 80):
            return f"{proto}://{host}"
        return f"{proto}://{host}:{port}"

    def _graphql_url(self, profile: Dict[str, Any]) -> str:
        path = (profile.get("graphql_path") or "/nbi/graphql").strip()
        if not path.startswith("/"):
            path = "/" + path
        return self._base_url(profile) + path

    def _session(self, verify_ssl: bool) -> requests.Session:
        with self._lock:
            if verify_ssl not in self._sessions:
                if not verify_ssl:
                    urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
                session = requests.Session()
                session.verify = verify_ssl
                adapter = HTTPAdapter(pool_connections=16, pool_maxsize=16)
                session.mount("https://", adapter)
                session.mount("http://", adapter)
                self._sessions[verify_ssl] = session
            return self._sessions[verify_ssl]

    def invalidate_token(self, profile_id: str) -> None:
        with self._lock:
            self._token_cache.pop(profile_id, None)

    def _acquire_oauth_token(self, profile: Dict[str, Any], force_refresh: bool = False) -> str:
        with self._lock:
            pid = profile.get("id", "default")
            cached = self._token_cache.get(pid)
            now = time.time()
            if cached and not force_refresh and cached.get("expires_at", 0) > now + 30:
                return cached["access_token"]

        client_id = (profile.get("client_id") or "").strip()
        client_secret = (profile.get("client_secret") or "").strip()
        if not client_id or not client_secret:
            raise ValueError("Client ID et Client Secret sont requis pour l'authentification OAuth 2.0.")

        verify_ssl = bool(profile.get("verify_ssl", False))
        timeout = int(profile.get("timeout") or 30)
        base_url = self._base_url(profile)

        configured_path = (profile.get("oauth_path") or "/oauth/token").strip()
        if not configured_path.startswith("/"):
            configured_path = "/" + configured_path

        candidate_paths = [configured_path]
        for fallback in ("/oauth/token/access-token", "/oauth/token"):
            if fallback not in candidate_paths:
                candidate_paths.append(fallback)

        session = self._session(verify_ssl)
        last_error = "Impossible d'obtenir un jeton OAuth 2.0."

        for path in candidate_paths:
            url = base_url + path
            # Strategy 1: HTTP Basic client credentials + form body grant_type
            attempts = [
                {
                    "auth": HTTPBasicAuth(client_id, client_secret),
                    "data": {"grant_type": "client_credentials"},
                    "params": None,
                },
                {
                    "auth": HTTPBasicAuth(client_id, client_secret),
                    "data": None,
                    "params": {"grant_type": "client_credentials"},
                },
                {
                    "auth": None,
                    "data": {
                        "grant_type": "client_credentials",
                        "client_id": client_id,
                        "client_secret": client_secret,
                    },
                    "params": None,
                },
            ]
            for attempt in attempts:
                try:
                    resp = session.post(
                        url,
                        auth=attempt["auth"],
                        data=attempt["data"],
                        params=attempt["params"],
                        headers={"Accept": "application/json"},
                        timeout=timeout,
                    )
                except requests.exceptions.SSLError as exc:
                    raise RuntimeError(
                        f"Erreur SSL/TLS vers {url} : désactivez « Vérifier le certificat SSL » pour un certificat auto-signé. ({exc})"
                    ) from exc
                except requests.exceptions.RequestException as exc:
                    raise RuntimeError(f"Erreur réseau vers {url} : {exc}") from exc

                if resp.status_code == 200:
                    try:
                        payload = resp.json()
                    except Exception:
                        payload = {}
                    token = payload.get("access_token") or payload.get("token")
                    if token:
                        expires_in = int(payload.get("expires_in") or 3600)
                        with self._lock:
                            self._token_cache[pid] = {
                                "access_token": token,
                                "expires_at": now + max(60, expires_in),
                                "token_url": url,
                            }
                        return token
                    last_error = f"Réponse OAuth 200 sans access_token sur {url}: {resp.text[:200]}"
                else:
                    last_error = f"HTTP {resp.status_code} sur {url}: {resp.text[:250]}"
                    if resp.status_code in (404, 405):
                        break  # try next path

        raise RuntimeError(f"Échec d'authentification OAuth 2.0 : {last_error}")

    def _build_auth(
        self, profile: Dict[str, Any], force_refresh: bool = False
    ) -> Tuple[Dict[str, str], Optional[HTTPBasicAuth]]:
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json",
        }
        auth_type = (profile.get("auth_type") or "oauth2").lower()
        if auth_type == "oauth2":
            token = self._acquire_oauth_token(profile, force_refresh=force_refresh)
            headers["Authorization"] = f"Bearer {token}"
            return headers, None
        if auth_type == "bearer":
            token = (profile.get("bearer_token") or "").strip()
            if not token:
                raise ValueError("Le jeton Bearer est vide.")
            if token.lower().startswith("bearer "):
                headers["Authorization"] = token
            else:
                headers["Authorization"] = f"Bearer {token}"
            return headers, None
        if auth_type == "basic":
            username = profile.get("username") or ""
            password = profile.get("password") or ""
            if not username:
                raise ValueError("Le nom d'utilisateur est requis pour l'authentification Basic.")
            return headers, HTTPBasicAuth(username, password)
        return headers, None

    def execute_graphql(
        self,
        profile: Dict[str, Any],
        query: str,
        variables: Optional[Dict[str, Any]] = None,
        operation_name: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Execute a GraphQL query or mutation against a live XIQ-SE server."""
        start = time.perf_counter()
        url = self._graphql_url(profile)
        verify_ssl = bool(profile.get("verify_ssl", False))
        timeout = int(profile.get("timeout") or 30)
        session = self._session(verify_ssl)

        payload: Dict[str, Any] = {"query": query}
        if variables:
            payload["variables"] = variables
        if operation_name:
            payload["operationName"] = operation_name

        def _send(force_refresh: bool = False) -> requests.Response:
            headers, basic_auth = self._build_auth(profile, force_refresh=force_refresh)
            return session.post(
                url,
                json=payload,
                headers=headers,
                auth=basic_auth,
                timeout=timeout,
            )

        try:
            resp = _send(force_refresh=False)
            if resp.status_code == 401 and (profile.get("auth_type") or "oauth2").lower() == "oauth2":
                self.invalidate_token(profile.get("id", "default"))
                resp = _send(force_refresh=True)
        except requests.exceptions.SSLError as exc:
            elapsed = int((time.perf_counter() - start) * 1000)
            return {
                "ok": False,
                "status_code": 0,
                "duration_ms": elapsed,
                "data": None,
                "errors": [
                    {
                        "message": f"Erreur de certificat SSL/TLS ({exc}). Astuce : décochez « Vérifier le certificat SSL » dans le profil de connexion pour les certificats auto-signés XIQ-SE."
                    }
                ],
                "url": url,
            }
        except requests.exceptions.ConnectionError as exc:
            elapsed = int((time.perf_counter() - start) * 1000)
            return {
                "ok": False,
                "status_code": 0,
                "duration_ms": elapsed,
                "data": None,
                "errors": [
                    {
                        "message": f"Impossible de joindre {url}. Vérifiez l'IP/FQDN, le port (8443 par défaut) et le pare-feu. ({exc})"
                    }
                ],
                "url": url,
            }
        except requests.exceptions.Timeout:
            elapsed = int((time.perf_counter() - start) * 1000)
            return {
                "ok": False,
                "status_code": 0,
                "duration_ms": elapsed,
                "data": None,
                "errors": [{"message": f"Délai d'attente dépassé ({timeout}s) vers {url}."}],
                "url": url,
            }
        except Exception as exc:
            elapsed = int((time.perf_counter() - start) * 1000)
            return {
                "ok": False,
                "status_code": 0,
                "duration_ms": elapsed,
                "data": None,
                "errors": [{"message": str(exc)}],
                "url": url,
            }

        elapsed = int((time.perf_counter() - start) * 1000)

        if resp.status_code == 401:
            return {
                "ok": False,
                "status_code": 401,
                "duration_ms": elapsed,
                "data": None,
                "errors": [
                    {
                        "message": "HTTP 401 Non autorisé : vérifiez vos identifiants et les droits « Northbound Interface (NBI) » dans Administration > Client API Access / Authorization Groups."
                    }
                ],
                "url": url,
            }

        if resp.status_code == 403:
            return {
                "ok": False,
                "status_code": 403,
                "duration_ms": elapsed,
                "data": None,
                "errors": [
                    {
                        "message": "HTTP 403 Accès refusé : votre groupe d'autorisation XIQ-SE ne dispose pas des capacités NBI requises (Read/Write, Access Control, Policy...)."
                    }
                ],
                "url": url,
            }

        if resp.status_code >= 400:
            return {
                "ok": False,
                "status_code": resp.status_code,
                "duration_ms": elapsed,
                "data": None,
                "errors": [{"message": f"HTTP {resp.status_code}: {resp.text[:500]}"}],
                "url": url,
            }

        try:
            body = resp.json()
        except Exception:
            return {
                "ok": False,
                "status_code": resp.status_code,
                "duration_ms": elapsed,
                "data": None,
                "errors": [{"message": f"Réponse non-JSON reçue de {url}: {resp.text[:400]}"}],
                "url": url,
            }

        errors: List[Any] = body.get("errors") or []
        data = body.get("data")
        return {
            "ok": len(errors) == 0,
            "status_code": resp.status_code,
            "duration_ms": elapsed,
            "data": data,
            "errors": errors,
            "url": url,
        }

    def test_connection(self, profile: Dict[str, Any]) -> Dict[str, Any]:
        """Test connectivity, authentication, and basic GraphQL query against XIQ-SE."""
        res = self.execute_graphql(profile, "{ __typename }")
        if not res["ok"]:
            return {
                "ok": False,
                "duration_ms": res["duration_ms"],
                "message": (res["errors"][0]["message"] if res.get("errors") else "Erreur inconnue"),
                "url": res.get("url"),
                "status_code": res.get("status_code"),
            }

        # Try fetching serverInfo (version & upTime are standard across XIQ-SE versions)
        info_res = self.execute_graphql(
            profile,
            "{ administration { serverInfo { version upTime } } }",
        )
        server_info = None
        if info_res.get("ok") and isinstance(info_res.get("data"), dict):
            server_info = (info_res["data"].get("administration") or {}).get("serverInfo")

        return {
            "ok": True,
            "duration_ms": res["duration_ms"],
            "message": "Connexion réussie à l'API NBI GraphQL XIQ-SE.",
            "url": res.get("url"),
            "status_code": res.get("status_code"),
            "root_type": (res.get("data") or {}).get("__typename"),
            "server_info": server_info,
        }

    def introspect_schema(self, profile: Dict[str, Any]) -> Dict[str, Any]:
        """Run full GraphQL __schema introspection on the connected XIQ-SE server."""
        return self.execute_graphql(profile, INTROSPECTION_QUERY)
