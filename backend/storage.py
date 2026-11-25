"""Persistent local storage for XIQ-SE API Studio (profiles, history, favorites, schemas)."""

import json
import os
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional


def get_data_dir() -> Path:
    """Return user-writable application data directory with safe fallbacks."""
    candidates = []
    env_dir = os.environ.get("XIQSE_DATA_DIR")
    if env_dir:
        candidates.append(Path(env_dir))
    appdata = os.environ.get("APPDATA")
    if appdata:
        candidates.append(Path(appdata) / "XIQ-SE-Studio")
    candidates.append(Path.home() / ".xiq-se-studio")
    candidates.append(Path.cwd() / "xiqse_data")
    candidates.append(Path(os.environ.get("TEMP", ".")) / "XIQ-SE-Studio")

    for base in candidates:
        try:
            base.mkdir(parents=True, exist_ok=True)
            probe = base / ".write_test"
            probe.write_text("ok", encoding="utf-8")
            probe.unlink(missing_ok=True)
            return base
        except OSError:
            continue
    return Path.cwd()


class StorageManager:
    """Manages profiles, query history, saved favorites, and custom imported schemas."""

    def __init__(self, data_dir: Optional[Path] = None) -> None:
        self._lock = threading.RLock()
        self.data_dir = data_dir or get_data_dir()
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.profiles_file = self.data_dir / "profiles.json"
        self.history_file = self.data_dir / "history.json"
        self.favorites_file = self.data_dir / "favorites.json"
        self.audit_file = self.data_dir / "audit_summaries.json"
        self.schemas_dir = self.data_dir / "schemas"
        self.schemas_dir.mkdir(parents=True, exist_ok=True)
        self._ensure_defaults()

    def _read_json(self, path: Path, default: Any) -> Any:
        with self._lock:
            if not path.exists():
                return default
            try:
                return json.loads(path.read_text(encoding="utf-8"))
            except Exception:
                return default

    def _write_json(self, path: Path, data: Any) -> None:
        with self._lock:
            tmp = path.with_name(f"{path.name}.{uuid.uuid4().hex[:8]}.tmp")
            try:
                tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
                tmp.replace(path)
            finally:
                if tmp.exists():
                    try:
                        tmp.unlink()
                    except OSError:
                        pass

    def _ensure_defaults(self) -> None:
        if not self.profiles_file.exists():
            default_profiles = {
                "active_profile_id": "demo-simulator",
                "profiles": [
                    {
                        "id": "demo-simulator",
                        "name": "Mode Démo — Simulateur XIQ-SE",
                        "mode": "demo",
                        "protocol": "https",
                        "host": "xiqse-demo.corp.local",
                        "port": 8443,
                        "graphql_path": "/nbi/graphql",
                        "auth_type": "oauth2",
                        "oauth_path": "/oauth/token",
                        "client_id": "demo-client-id",
                        "client_secret": "demo-client-secret",
                        "username": "admin",
                        "password": "",
                        "bearer_token": "",
                        "verify_ssl": False,
                        "timeout": 30,
                        "notes": "Environnement de démonstration intégré avec données réalistes Extreme Networks.",
                    }
                ],
            }
            self._write_json(self.profiles_file, default_profiles)

        if not self.history_file.exists():
            self._write_json(self.history_file, [])

        if not self.favorites_file.exists():
            self._write_json(self.favorites_file, [])

    # ---- Profiles ----

    def get_profiles_state(self) -> Dict[str, Any]:
        state = self._read_json(self.profiles_file, {"active_profile_id": None, "profiles": []})
        if not state.get("profiles"):
            self._ensure_defaults()
            state = self._read_json(self.profiles_file, {"active_profile_id": None, "profiles": []})
        return state

    def get_active_profile(self) -> Dict[str, Any]:
        state = self.get_profiles_state()
        active_id = state.get("active_profile_id")
        for p in state.get("profiles", []):
            if p.get("id") == active_id:
                return p
        return state["profiles"][0]

    def get_profile(self, profile_id: str) -> Optional[Dict[str, Any]]:
        state = self.get_profiles_state()
        for p in state.get("profiles", []):
            if p.get("id") == profile_id:
                return p
        return None

    def save_profile(self, profile: Dict[str, Any], set_active: bool = True) -> Dict[str, Any]:
        state = self.get_profiles_state()
        profiles = state.get("profiles", [])
        pid = profile.get("id") or f"prof-{uuid.uuid4().hex[:8]}"
        normalized = {
            "id": pid,
            "name": (profile.get("name") or "Serveur XIQ-SE").strip(),
            "mode": profile.get("mode", "live"),
            "protocol": profile.get("protocol", "https"),
            "host": (profile.get("host") or "").strip(),
            "port": int(profile.get("port") or 8443),
            "graphql_path": (profile.get("graphql_path") or "/nbi/graphql").strip(),
            "auth_type": profile.get("auth_type", "oauth2"),
            "oauth_path": (profile.get("oauth_path") or "/oauth/token").strip(),
            "client_id": profile.get("client_id", ""),
            "client_secret": profile.get("client_secret", ""),
            "username": profile.get("username", ""),
            "password": profile.get("password", ""),
            "bearer_token": profile.get("bearer_token", ""),
            "verify_ssl": bool(profile.get("verify_ssl", False)),
            "timeout": int(profile.get("timeout") or 30),
            "notes": profile.get("notes", ""),
        }
        updated = False
        for idx, existing in enumerate(profiles):
            if existing.get("id") == pid:
                profiles[idx] = normalized
                updated = True
                break
        if not updated:
            profiles.append(normalized)
        state["profiles"] = profiles
        if set_active or not state.get("active_profile_id"):
            state["active_profile_id"] = pid
        self._write_json(self.profiles_file, state)
        return normalized

    def set_active_profile(self, profile_id: str) -> Optional[Dict[str, Any]]:
        state = self.get_profiles_state()
        for p in state.get("profiles", []):
            if p.get("id") == profile_id:
                state["active_profile_id"] = profile_id
                self._write_json(self.profiles_file, state)
                return p
        return None

    def delete_profile(self, profile_id: str) -> bool:
        if profile_id == "demo-simulator":
            return False
        state = self.get_profiles_state()
        profiles = [p for p in state.get("profiles", []) if p.get("id") != profile_id]
        if len(profiles) == len(state.get("profiles", [])):
            return False
        state["profiles"] = profiles
        if state.get("active_profile_id") == profile_id:
            state["active_profile_id"] = profiles[0]["id"] if profiles else None
        self._write_json(self.profiles_file, state)
        return True

    # ---- History ----

    def add_history(
        self,
        profile_name: str,
        query: str,
        variables: Any,
        duration_ms: int,
        success: bool,
        error_preview: str = "",
        source: str = "studio",
    ) -> Dict[str, Any]:
        with self._lock:
            history: List[Dict[str, Any]] = self._read_json(self.history_file, [])
            q_stripped = (query or "").strip()
            op_type = "mutation" if q_stripped.lower().startswith("mutation") else "query"
            entry = {
                "id": f"hist-{uuid.uuid4().hex[:8]}",
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "profile_name": profile_name,
                "operation_type": op_type,
                "query": q_stripped,
                "variables": variables or {},
                "duration_ms": duration_ms,
                "success": success,
                "error_preview": error_preview[:300] if error_preview else "",
                "source": source,
            }
            history.insert(0, entry)
            history = history[:200]
            self._write_json(self.history_file, history)
            return entry

    def get_history(self, limit: int = 100) -> List[Dict[str, Any]]:
        history: List[Dict[str, Any]] = self._read_json(self.history_file, [])
        return history[:limit]

    def clear_history(self) -> None:
        self._write_json(self.history_file, [])

    # ---- Favorites ----

    def get_favorites(self) -> List[Dict[str, Any]]:
        return self._read_json(self.favorites_file, [])

    def save_favorite(self, fav: Dict[str, Any]) -> Dict[str, Any]:
        favorites = self.get_favorites()
        fid = fav.get("id") or f"fav-{uuid.uuid4().hex[:8]}"
        item = {
            "id": fid,
            "name": (fav.get("name") or "Requête sans nom").strip(),
            "category": (fav.get("category") or "Personnalisé").strip(),
            "description": (fav.get("description") or "").strip(),
            "query": fav.get("query", ""),
            "variables": fav.get("variables") or {},
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }
        updated = False
        for i, existing in enumerate(favorites):
            if existing.get("id") == fid:
                favorites[i] = item
                updated = True
                break
        if not updated:
            favorites.insert(0, item)
        self._write_json(self.favorites_file, favorites)
        return item

    def delete_favorite(self, fav_id: str) -> bool:
        favorites = self.get_favorites()
        new_favs = [f for f in favorites if f.get("id") != fav_id]
        if len(new_favs) == len(favorites):
            return False
        self._write_json(self.favorites_file, new_favs)
        return True

    # ---- Imported NBI Schemas ----

    def save_imported_schema(self, profile_id: str, schema_data: Dict[str, Any]) -> None:
        path = self.schemas_dir / f"{profile_id}.json"
        self._write_json(path, schema_data)

    def get_imported_schema(self, profile_id: str) -> Optional[Dict[str, Any]]:
        path = self.schemas_dir / f"{profile_id}.json"
        return self._read_json(path, None)

    # ---- MAC Audit Summary Persistence ----

    def save_audit_summary(self, profile_id: str, summary: Dict[str, Any]) -> Dict[str, Any]:
        with self._lock:
            all_summaries = self._read_json(self.audit_file, {})
            entry = {
                **summary,
                "updated_at": datetime.now(timezone.utc).isoformat(),
            }
            all_summaries[profile_id] = entry
            self._write_json(self.audit_file, all_summaries)
            return entry

    def get_audit_summary(self, profile_id: str) -> Optional[Dict[str, Any]]:
        all_summaries = self._read_json(self.audit_file, {})
        return all_summaries.get(profile_id)
