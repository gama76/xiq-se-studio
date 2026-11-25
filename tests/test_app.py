"""Automated tests for XIQ-SE API Studio (GraphQL engine, templates, schema, codegen, storage, UI)."""

import json
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from backend.code_generator import generate_snippets
from backend.server import AppContext
from backend.templates_catalog import GRAPHQL_TEMPLATES


def run_tests() -> None:
    with tempfile.TemporaryDirectory() as tmpdir:
        ctx = AppContext(data_dir=Path(tmpdir))

        # 1. Verify all frontend assets exist and are non-empty
        for asset in (
            "index.html",
            "styles.css",
            "js/api.js",
            "js/schema_tools.js",
            "js/views_ops.js",
            "js/views_tools.js",
            "js/views_studio.js",
            "js/app.js",
        ):
            p = ctx.frontend_dir / asset
            assert p.exists() and p.stat().st_size > 500, f"Missing or too small frontend asset: {asset}"

        # 2. Verify icon exists
        assert (ROOT / "assets" / "app_icon.ico").exists(), "Missing app_icon.ico"

        # 3. Verify all 24 curated templates execute cleanly against the GraphQL simulator
        assert len(GRAPHQL_TEMPLATES) >= 24, f"Expected >=24 templates, got {len(GRAPHQL_TEMPLATES)}"
        for tpl in GRAPHQL_TEMPLATES:
            res = ctx.execute_graphql(tpl["query"], tpl.get("variables", {}), source="test")
            assert res["ok"], f"Template failed ({tpl['id']}): {res.get('errors')}"
            assert res["data"] is not None, f"Empty data for template {tpl['id']}"

        # 4. Verify Dashboard, Network, NAC, Workflows, Policy, Alarms, Admin composite queries
        dashboard_q = """query DashboardOverview {
          network { devices { ip sysName status } sites { name location devList } }
          accessControl { appliances { displayName activeEndSystems } endSystems { macAddress state } }
          alarms { activeAlarms { id severity } recentEvents { id summary } }
          workflows { workflows { id name } executions { executionId status } }
          policy { domains { name roles { name defaultVlan } } }
          analytics { topApplications { name bytesTotalMB } }
          administration { serverInfo { version hostName } authorizationGroups { name } apiClients { clientId } }
        }"""
        dres = ctx.execute_graphql(dashboard_q, {}, source="test")
        assert dres["ok"]
        assert len(dres["data"]["network"]["devices"]) >= 8
        assert len(dres["data"]["accessControl"]["appliances"]) == 3
        assert len(dres["data"]["workflows"]["workflows"]) >= 6
        assert len(dres["data"]["policy"]["domains"]) == 2
        assert len(dres["data"]["analytics"]["topApplications"]) >= 8

        # 5. Verify full GraphQL __schema introspection
        intro = ctx.execute_graphql(
            "{ __schema { queryType { name } mutationType { name } types { name kind fields { name } } } }",
            record_history=False,
        )
        assert intro["ok"]
        schema_types = intro["data"]["__schema"]["types"]
        assert len(schema_types) >= 35, f"Expected >=35 GraphQL types, got {len(schema_types)}"

        # 6. Verify stateful mutations actually persist in the mock engine
        ctx.mock.reset()
        before_sites = len(ctx.mock.sites)
        ms = ctx.execute_graphql(
            'mutation { network { createSite(input: { name: "Nantes-Lab", parentLocation: "/World/France" }) { status siteLocation } } }'
        )
        assert ms["ok"] and ms["data"]["network"]["createSite"]["status"] == "SUCCESS"
        assert len(ctx.mock.sites) == before_sites + 1

        # 6b. Verify NAC allEndSystemMacs and single group lookup (used by Audit MAC Jamais Vues)
        macs_res = ctx.execute_graphql("{ accessControl { allEndSystemMacs group(name: \"Corporate-Laptops\") { name entries } } }")
        assert macs_res["ok"]
        seen = set(m.upper() for m in macs_res["data"]["accessControl"]["allEndSystemMacs"])
        grp_entries = macs_res["data"]["accessControl"]["group"]["entries"]
        never_seen = [m for m in grp_entries if m.upper() not in seen]
        assert "AA:BB:CC:00:11:22" in never_seen, f"Expected never-seen demo MAC, got {never_seen}"

        # 6c. Verify aliased batch NAC group query AND multi-threaded storage concurrency
        batch_q = """query BatchNacGroups {
          accessControl {
            g0: group(name: "Corporate-Laptops") { name entries }
            g1: group(name: "VoIP-Phones") { name entries }
            g2: group(name: "IoT-Cameras") { name entries }
          }
        }"""
        bres = ctx.execute_graphql(batch_q, record_history=False)
        assert bres["ok"]
        assert "AA:BB:CC:00:11:22" in bres["data"]["accessControl"]["g0"]["entries"]
        assert "AA:BB:CC:00:33:44" in bres["data"]["accessControl"]["g1"]["entries"]
        assert "AA:BB:CC:00:11:22" in bres["data"]["accessControl"]["g2"]["entries"]  # Duplicate across 2 groups

        # Audit summary persistence
        ctx.storage.save_audit_summary("demo-simulator", {"neverSeenCount": 3, "duplicateCount": 1, "totalUniqueGroupMacs": 8})
        saved_sum = ctx.storage.get_audit_summary("demo-simulator")
        assert saved_sum and saved_sum["neverSeenCount"] == 3 and saved_sum["duplicateCount"] == 1

        from concurrent.futures import ThreadPoolExecutor

        def _worker(i: int) -> bool:
            r = ctx.execute_graphql("{ network { devices { ip } } }", record_history=True, source=f"t{i}")
            return bool(r["ok"])

        with ThreadPoolExecutor(max_workers=16) as pool:
            results = list(pool.map(_worker, range(48)))
        assert all(results), "Concurrent history/graphql stress test failed!"

        # 7. Verify Code Generator for OAuth2, Basic, and Bearer profiles
        for auth_type in ("oauth2", "basic", "bearer"):
            prof = {
                "protocol": "https",
                "host": "xiqse.corp.local",
                "port": 8443,
                "graphql_path": "/nbi/graphql",
                "oauth_path": "/oauth/token",
                "auth_type": auth_type,
                "client_id": "my-client",
                "username": "admin",
                "verify_ssl": False,
            }
            snippets = generate_snippets(prof, "{ network { devices { ip sysName } } }", {})
            assert "requests.post" in snippets["python"]
            assert "curl" in snippets["curl"]
            assert "Invoke-RestMethod" in snippets["powershell"]

        # 8. Verify Storage (Profiles, History, Favorites, Imported Schema)
        saved = ctx.storage.save_profile(
            {
                "name": "Lab XIQ-SE",
                "mode": "live",
                "host": "192.168.100.10",
                "port": 8443,
                "auth_type": "oauth2",
                "client_id": "cid",
                "client_secret": "csec",
            },
            set_active=False,
        )
        assert ctx.storage.get_profile(saved["id"]) is not None
        assert ctx.storage.delete_profile(saved["id"]) is True
        assert ctx.storage.delete_profile("demo-simulator") is False  # Protected default

        assert len(ctx.storage.get_history()) >= 20
        ctx.storage.save_favorite({"name": "Mes switches", "query": "{ network { devices { ip } } }"})
        assert len(ctx.storage.get_favorites()) == 1

        ctx.storage.save_imported_schema("demo-simulator", ctx.mock.schema)
        assert ctx.storage.get_imported_schema("demo-simulator") is not None

        print(
            f"ALL TESTS PASSED! Verified {len(GRAPHQL_TEMPLATES)} templates, "
            f"{len(schema_types)} GraphQL schema types, stateful mutations, "
            f"3 auth codegen modes, persistent storage, and all frontend assets."
        )


if __name__ == "__main__":
    run_tests()
