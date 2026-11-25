"""Code generator turning any XIQ-SE GraphQL operation into Python, cURL, or PowerShell."""

import json
from typing import Any, Dict, Optional


def _build_urls(profile: Dict[str, Any]) -> Dict[str, str]:
    proto = (profile.get("protocol") or "https").strip()
    host = (profile.get("host") or "xiqse.corp.local").strip()
    port = int(profile.get("port") or 8443)
    gql_path = (profile.get("graphql_path") or "/nbi/graphql").strip()
    oauth_path = (profile.get("oauth_path") or "/oauth/token").strip()
    if not gql_path.startswith("/"):
        gql_path = "/" + gql_path
    if not oauth_path.startswith("/"):
        oauth_path = "/" + oauth_path
    base = f"{proto}://{host}" if ((proto == "https" and port == 443) or (proto == "http" and port == 80)) else f"{proto}://{host}:{port}"
    return {
        "base": base,
        "graphql": base + gql_path,
        "oauth": base + oauth_path,
    }


def generate_snippets(
    profile: Dict[str, Any],
    query: str,
    variables: Optional[Dict[str, Any]] = None,
) -> Dict[str, str]:
    """Generate ready-to-use Python, cURL, and PowerShell scripts for a GraphQL operation."""
    urls = _build_urls(profile)
    auth_type = (profile.get("auth_type") or "oauth2").lower()
    verify_ssl = bool(profile.get("verify_ssl", False))
    client_id = profile.get("client_id") or "YOUR_CLIENT_ID"
    username = profile.get("username") or "YOUR_USERNAME"
    vars_dict = variables or {}
    payload_obj: Dict[str, Any] = {"query": query.strip()}
    if vars_dict:
        payload_obj["variables"] = vars_dict
    payload_json = json.dumps(payload_obj, ensure_ascii=False)

    # ---- PYTHON ----
    ssl_line = "VERIFY_SSL = True" if verify_ssl else "VERIFY_SSL = False\nurllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)"
    if auth_type == "oauth2":
        py_auth = f'''TOKEN_URL = "{urls['oauth']}"
CLIENT_ID = "{client_id}"
CLIENT_SECRET = "YOUR_CLIENT_SECRET"  # Remplacez par votre secret

# 1. Obtenir le jeton OAuth 2.0 (client_credentials)
token_resp = requests.post(
    TOKEN_URL,
    auth=(CLIENT_ID, CLIENT_SECRET),
    data={{"grant_type": "client_credentials"}},
    verify=VERIFY_SSL,
    timeout=30,
)
token_resp.raise_for_status()
access_token = token_resp.json()["access_token"]
headers = {{
    "Authorization": f"Bearer {{access_token}}",
    "Content-Type": "application/json",
    "Accept": "application/json",
}}
auth = None'''
    elif auth_type == "basic":
        py_auth = f'''USERNAME = "{username}"
PASSWORD = "YOUR_PASSWORD"  # Remplacez par votre mot de passe
headers = {{"Content-Type": "application/json", "Accept": "application/json"}}
auth = (USERNAME, PASSWORD)'''
    else:
        py_auth = '''ACCESS_TOKEN = "YOUR_BEARER_TOKEN"
headers = {
    "Authorization": f"Bearer {ACCESS_TOKEN}",
    "Content-Type": "application/json",
    "Accept": "application/json",
}
auth = None'''

    python_code = f'''import json
import requests
import urllib3

GRAPHQL_URL = "{urls['graphql']}"
{ssl_line}

{py_auth}

query = """{query.strip()}"""
variables = {json.dumps(vars_dict, indent=2, ensure_ascii=False)}

# 2. Exécuter la requête GraphQL NBI XIQ-SE
response = requests.post(
    GRAPHQL_URL,
    json={{"query": query, "variables": variables}},
    headers=headers,
    auth=auth,
    verify=VERIFY_SSL,
    timeout=30,
)
response.raise_for_status()
print(json.dumps(response.json(), indent=2, ensure_ascii=False))
'''

    # ---- CURL ----
    k_flag = "" if verify_ssl else "-k "
    escaped_payload = payload_json.replace("'", "'\"'\"'")
    if auth_type == "oauth2":
        curl_code = f'''# 1. Récupérer le jeton OAuth 2.0
TOKEN=$(curl -s {k_flag}-X POST "{urls['oauth']}" \\
  -u "{client_id}:YOUR_CLIENT_SECRET" \\
  -d "grant_type=client_credentials" | jq -r '.access_token')

# 2. Appeler l'API GraphQL NBI XIQ-SE
curl -s {k_flag}-X POST "{urls['graphql']}" \\
  -H "Authorization: Bearer $TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{escaped_payload}' | jq .
'''
    elif auth_type == "basic":
        curl_code = f'''curl -s {k_flag}-X POST "{urls['graphql']}" \\
  -u "{username}:YOUR_PASSWORD" \\
  -H "Content-Type: application/json" \\
  -d '{escaped_payload}' | jq .
'''
    else:
        curl_code = f'''curl -s {k_flag}-X POST "{urls['graphql']}" \\
  -H "Authorization: Bearer YOUR_BEARER_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{escaped_payload}' | jq .
'''

    # ---- POWERSHELL ----
    ps_ssl = "" if verify_ssl else """# Ignorer les certificats auto-signés (PowerShell 5.1 / 7+)
if ($PSVersionTable.PSVersion.Major -lt 7) {
    add-type @"
using System.Net;
using System.Security.Cryptography.X509Certificates;
public class TrustAllCertsPolicy : ICertificatePolicy {
    public bool CheckValidationResult(ServicePoint srvPoint, X509Certificate certificate, WebRequest request, int certificateProblem) { return true; }
}
"@
    [System.Net.ServicePointManager]::CertificatePolicy = New-Object TrustAllCertsPolicy
}
$skipCert = if ($PSVersionTable.PSVersion.Major -ge 7) { @{ SkipCertificateCheck = $true } } else { @{} }
"""
    ps_skip_arg = "@skipCert " if not verify_ssl else ""
    ps_payload = payload_json.replace("'", "''")

    if auth_type == "oauth2":
        ps_code = f'''{ps_ssl}$ClientId = "{client_id}"
$ClientSecret = "YOUR_CLIENT_SECRET"
$BasicPair = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("$($ClientId):$($ClientSecret)"))

# 1. Obtenir le jeton OAuth 2.0
$TokenResp = Invoke-RestMethod {ps_skip_arg}-Method Post `
    -Uri "{urls['oauth']}" `
    -Headers @{{ Authorization = "Basic $BasicPair" }} `
    -Body @{{ grant_type = "client_credentials" }}

# 2. Appeler l'API GraphQL NBI XIQ-SE
$Body = '{ps_payload}'
$Result = Invoke-RestMethod {ps_skip_arg}-Method Post `
    -Uri "{urls['graphql']}" `
    -Headers @{{ Authorization = "Bearer $($TokenResp.access_token)"; "Content-Type" = "application/json" }} `
    -Body $Body

$Result | ConvertTo-Json -Depth 10
'''
    elif auth_type == "basic":
        ps_code = f'''{ps_ssl}$Username = "{username}"
$Password = "YOUR_PASSWORD"
$BasicPair = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("$($Username):$($Password)"))

$Body = '{ps_payload}'
$Result = Invoke-RestMethod {ps_skip_arg}-Method Post `
    -Uri "{urls['graphql']}" `
    -Headers @{{ Authorization = "Basic $BasicPair"; "Content-Type" = "application/json" }} `
    -Body $Body

$Result | ConvertTo-Json -Depth 10
'''
    else:
        ps_code = f'''{ps_ssl}$Body = '{ps_payload}'
$Result = Invoke-RestMethod {ps_skip_arg}-Method Post `
    -Uri "{urls['graphql']}" `
    -Headers @{{ Authorization = "Bearer YOUR_BEARER_TOKEN"; "Content-Type" = "application/json" }} `
    -Body $Body

$Result | ConvertTo-Json -Depth 10
'''

    return {
        "python": python_code,
        "curl": curl_code,
        "powershell": ps_code,
    }
