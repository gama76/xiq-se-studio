"""Embedded local HTTP server and REST API bridge for XIQ-SE API Studio."""

import json
import mimetypes
import os
import sys
import threading
import webbrowser
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, Optional, Tuple
from urllib.parse import parse_qs, unquote, urlparse

from backend.code_generator import generate_snippets
from backend.mock_engine import MockXIQSEEngine
from backend.storage import StorageManager
from backend.templates_catalog import GRAPHQL_TEMPLATES
from backend.xiqse_client import XIQSEClient


def get_resource_dir() -> Path:
    """Resolve base directory both in source mode and PyInstaller onefile bundle."""
    if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
        return Path(sys._MEIPASS)  # type: ignore[attr-defined]
    return Path(__file__).resolve().parent.parent


class AppContext:
    """Shared application state across HTTP requests."""

    def __init__(self, data_dir: Optional[Path] = None) -> None:
        self.storage = StorageManager(data_dir=data_dir)
        self.client = XIQSEClient()
        self.mock = MockXIQSEEngine()
        self.frontend_dir = get_resource_dir() / "frontend"

    def resolve_profile(self, override: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        if override and isinstance(override, dict) and override.get("host"):
            return override
        return self.storage.get_active_profile()

    def execute_graphql(
        self,
        query: str,
        variables: Optional[Dict[str, Any]] = None,
        operation_name: Optional[str] = None,
        profile_override: Optional[Dict[str, Any]] = None,
        record_history: bool = True,
        source: str = "studio",
    ) -> Dict[str, Any]:
        profile = self.resolve_profile(profile_override)
        mode = (profile.get("mode") or "live").lower()
        if mode == "demo":
            result = self.mock.execute_graphql(query, variables)
        else:
            result = self.client.execute_graphql(
                profile,
                query,
                variables=variables,
                operation_name=operation_name,
            )

        if record_history and "__schema" not in (query or ""):
            err_msg = ""
            if result.get("errors"):
                first = result["errors"][0]
                err_msg = first.get("message", str(first)) if isinstance(first, dict) else str(first)
            self.storage.add_history(
                profile_name=profile.get("name", "XIQ-SE"),
                query=query,
                variables=variables,
                duration_ms=result.get("duration_ms", 0),
                success=bool(result.get("ok")),
                error_preview=err_msg,
                source=source,
            )
        return result


def _make_handler(ctx: AppContext):
    class RequestHandler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, format: str, *args: Any) -> None:
            # Silence default stderr logs in desktop mode unless debug env is set
            if os.environ.get("XIQSE_DEBUG"):
                super().log_message(format, *args)

        def _send_json(self, status: int, data: Any) -> None:
            raw = json.dumps(data, ensure_ascii=False).encode("utf-8")
            self.close_connection = True
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(raw)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(raw)

        def _read_json_body(self) -> Dict[str, Any]:
            length = int(self.headers.get("Content-Length") or 0)
            if length <= 0:
                return {}
            raw = self.rfile.read(length)
            try:
                return json.loads(raw.decode("utf-8"))
            except Exception as exc:
                raise ValueError(f"Corps JSON invalide : {exc}") from exc

        def _serve_static(self, rel_path: str) -> None:
            clean = rel_path.lstrip("/") or "index.html"
            target = (ctx.frontend_dir / clean).resolve()
            if not str(target).startswith(str(ctx.frontend_dir.resolve())):
                self.send_error(HTTPStatus.FORBIDDEN)
                return
            if not target.exists() or not target.is_file():
                target = ctx.frontend_dir / "index.html"
            if not target.exists():
                self.send_error(HTTPStatus.NOT_FOUND, "Frontend assets not found")
                return
            content = target.read_bytes()
            ctype, _ = mimetypes.guess_type(str(target))
            if target.suffix == ".js":
                ctype = "application/javascript; charset=utf-8"
            elif target.suffix == ".css":
                ctype = "text/css; charset=utf-8"
            elif target.suffix == ".html":
                ctype = "text/html; charset=utf-8"
            elif target.suffix == ".svg":
                ctype = "image/svg+xml"
            self.close_connection = True
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", ctype or "application/octet-stream")
            self.send_header("Content-Length", str(len(content)))
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(content)

        def do_GET(self) -> None:
            try:
                self._handle_get()
            except Exception as exc:
                self._send_json(500, {"error": f"Erreur serveur interne (GET): {exc}"})

        def _handle_get(self) -> None:
            parsed = urlparse(self.path)
            path = parsed.path
            qs = parse_qs(parsed.query)

            if path == "/api/health":
                profile = ctx.storage.get_active_profile()
                self._send_json(
                    200,
                    {
                        "status": "ok",
                        "app": "XIQ-SE API Studio",
                        "version": "1.0.0",
                        "active_profile": {
                            "id": profile.get("id"),
                            "name": profile.get("name"),
                            "mode": profile.get("mode"),
                            "host": profile.get("host"),
                        },
                        "data_dir": str(ctx.storage.data_dir),
                    },
                )
                return

            if path == "/api/profiles":
                self._send_json(200, ctx.storage.get_profiles_state())
                return

            if path == "/api/templates":
                self._send_json(200, {"templates": GRAPHQL_TEMPLATES})
                return

            if path == "/api/history":
                limit = int((qs.get("limit") or ["100"])[0])
                self._send_json(200, {"history": ctx.storage.get_history(limit=limit)})
                return

            if path == "/api/favorites":
                self._send_json(200, {"favorites": ctx.storage.get_favorites()})
                return

            if path == "/api/schema/imported":
                profile = ctx.storage.get_active_profile()
                schema = ctx.storage.get_imported_schema(profile["id"])
                self._send_json(200, {"schema": schema})
                return

            if path == "/api/audit/summary":
                profile = ctx.storage.get_active_profile()
                summary = ctx.storage.get_audit_summary(profile["id"])
                self._send_json(200, {"summary": summary})
                return

            if path.startswith("/api/"):
                self._send_json(404, {"error": f"Route inconnue: {path}"})
                return

            self._serve_static(unquote(path))

        def do_POST(self) -> None:
            try:
                self._handle_post()
            except Exception as exc:
                self._send_json(500, {"error": f"Erreur serveur interne (POST): {exc}"})

        def _handle_post(self) -> None:
            parsed = urlparse(self.path)
            path = parsed.path
            try:
                body = self._read_json_body()
            except ValueError as exc:
                self._send_json(400, {"error": str(exc)})
                return

            if path == "/api/profiles":
                set_active = bool(body.get("set_active", True))
                saved = ctx.storage.save_profile(body, set_active=set_active)
                ctx.client.invalidate_token(saved["id"])
                self._send_json(200, {"profile": saved, "state": ctx.storage.get_profiles_state()})
                return

            if path == "/api/profiles/activate":
                pid = body.get("id") or ""
                activated = ctx.storage.set_active_profile(pid)
                if not activated:
                    self._send_json(404, {"error": "Profil introuvable."})
                    return
                self._send_json(200, {"profile": activated, "state": ctx.storage.get_profiles_state()})
                return

            if path == "/api/connection/test":
                profile = body.get("profile") or ctx.storage.get_active_profile()
                if (profile.get("mode") or "live").lower() == "demo":
                    self._send_json(
                        200,
                        {
                            "ok": True,
                            "duration_ms": 6,
                            "message": "Mode Démo actif : Simulateur GraphQL NBI XIQ-SE prêt (tous les domaines disponibles).",
                            "url": "demo://xiqse-demo.corp.local:8443/nbi/graphql",
                            "status_code": 200,
                            "root_type": "Query",
                            "server_info": ctx.mock._server_info(),
                        },
                    )
                    return
                res = ctx.client.test_connection(profile)
                self._send_json(200, res)
                return

            if path == "/api/graphql":
                query = body.get("query") or ""
                variables = body.get("variables")
                op_name = body.get("operationName")
                record_history = bool(body.get("recordHistory", True))
                source = body.get("source") or "studio"
                if isinstance(variables, str):
                    variables = json.loads(variables) if variables.strip() else {}
                res = ctx.execute_graphql(
                    query=query,
                    variables=variables,
                    operation_name=op_name,
                    record_history=record_history,
                    source=source,
                )
                self._send_json(200, res)
                return

            if path == "/api/schema/introspect":
                profile = ctx.storage.get_active_profile()
                if (profile.get("mode") or "live").lower() == "demo":
                    self._send_json(
                        200,
                        {
                            "ok": True,
                            "source": "demo-introspection",
                            "duration_ms": 8,
                            "schema": ctx.mock.schema,
                        },
                    )
                    return
                res = ctx.client.introspect_schema(profile)
                if res.get("ok") and isinstance(res.get("data"), dict) and res["data"].get("__schema"):
                    schema = res["data"]["__schema"]
                    ctx.storage.save_imported_schema(profile["id"], schema)
                    self._send_json(
                        200,
                        {
                            "ok": True,
                            "source": "live-introspection",
                            "duration_ms": res.get("duration_ms", 0),
                            "schema": schema,
                        },
                    )
                    return
                # Fallback to previously imported schema if available
                cached = ctx.storage.get_imported_schema(profile["id"])
                self._send_json(
                    200,
                    {
                        "ok": False,
                        "source": "error",
                        "errors": res.get("errors") or [{"message": "Échec de l'introspection __schema."}],
                        "cached_schema": cached,
                    },
                )
                return

            if path == "/api/schema/import":
                raw_schema = body.get("schema")
                if isinstance(raw_schema, str):
                    try:
                        raw_schema = json.loads(raw_schema)
                    except Exception as exc:
                        self._send_json(400, {"error": f"JSON de schéma invalide : {exc}"})
                        return
                if not isinstance(raw_schema, dict):
                    self._send_json(400, {"error": "Format de schéma NBI JSON invalide."})
                    return
                # Unwrap common GraphQL export envelopes
                schema_obj = raw_schema
                if "data" in schema_obj and isinstance(schema_obj["data"], dict) and "__schema" in schema_obj["data"]:
                    schema_obj = schema_obj["data"]["__schema"]
                elif "__schema" in schema_obj and isinstance(schema_obj["__schema"], dict):
                    schema_obj = schema_obj["__schema"]
                if "types" not in schema_obj:
                    self._send_json(400, {"error": "Le fichier JSON ne contient pas de champ 'types' (__schema). Exportez 'NBI Schema (JSON)' depuis Diagnostics > Server > Server Utilities dans XIQ-SE."})
                    return
                profile = ctx.storage.get_active_profile()
                ctx.storage.save_imported_schema(profile["id"], schema_obj)
                self._send_json(200, {"ok": True, "schema": schema_obj, "types_count": len(schema_obj.get("types") or [])})
                return

            if path == "/api/favorites":
                saved = ctx.storage.save_favorite(body)
                self._send_json(200, {"favorite": saved, "favorites": ctx.storage.get_favorites()})
                return

            if path == "/api/codegen":
                profile = ctx.storage.get_active_profile()
                query = body.get("query") or ""
                variables = body.get("variables") or {}
                if isinstance(variables, str):
                    try:
                        variables = json.loads(variables) if variables.strip() else {}
                    except Exception:
                        variables = {}
                snippets = generate_snippets(profile, query, variables)
                self._send_json(200, snippets)
                return

            if path == "/api/demo/reset":
                ctx.mock.reset()
                self._send_json(200, {"ok": True, "message": "Données du simulateur réinitialisées."})
                return

            if path == "/api/audit/summary":
                profile = ctx.storage.get_active_profile()
                saved = ctx.storage.save_audit_summary(profile["id"], body)
                self._send_json(200, {"ok": True, "summary": saved})
                return

            if path == "/api/open-url":
                url = (body.get("url") or "").strip()
                if not (url.startswith("https://") or url.startswith("http://")):
                    self._send_json(400, {"error": "URL invalide (http:// ou https:// requis)."})
                    return
                webbrowser.open(url)
                self._send_json(200, {"ok": True, "url": url})
                return

            if path == "/api/export/save":
                # Save exported content cleanly to Downloads folder so desktop WebView exports always succeed
                filename = os.path.basename(body.get("filename") or "xiqse-export.json")
                content = body.get("content") or ""
                downloads = Path.home() / "Downloads"
                downloads.mkdir(parents=True, exist_ok=True)
                dest = downloads / filename
                dest.write_text(content, encoding="utf-8-sig" if filename.endswith(".csv") else "utf-8")
                self._send_json(200, {"ok": True, "path": str(dest)})
                return

            self._send_json(404, {"error": f"Route POST inconnue: {path}"})

        def do_DELETE(self) -> None:
            try:
                self._handle_delete()
            except Exception as exc:
                self._send_json(500, {"error": f"Erreur serveur interne (DELETE): {exc}"})

        def _handle_delete(self) -> None:
            parsed = urlparse(self.path)
            path = parsed.path

            if path.startswith("/api/profiles/"):
                pid = unquote(path.split("/api/profiles/", 1)[1])
                ok = ctx.storage.delete_profile(pid)
                self._send_json(200 if ok else 400, {"ok": ok, "state": ctx.storage.get_profiles_state()})
                return

            if path == "/api/history":
                ctx.storage.clear_history()
                self._send_json(200, {"ok": True})
                return

            if path.startswith("/api/favorites/"):
                fid = unquote(path.split("/api/favorites/", 1)[1])
                ok = ctx.storage.delete_favorite(fid)
                self._send_json(200 if ok else 404, {"ok": ok, "favorites": ctx.storage.get_favorites()})
                return

            self._send_json(404, {"error": f"Route DELETE inconnue: {path}"})

    return RequestHandler


def start_embedded_server(
    host: str = "127.0.0.1",
    port: int = 0,
    data_dir: Optional[Path] = None,
) -> Tuple[ThreadingHTTPServer, int, AppContext]:
    """Start the embedded HTTP server in a daemon thread and return (server, port, ctx)."""
    ctx = AppContext(data_dir=data_dir)
    server = ThreadingHTTPServer((host, port), _make_handler(ctx))
    actual_port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, name="XIQSE-HTTP-Server", daemon=True)
    thread.start()
    return server, actual_port, ctx
