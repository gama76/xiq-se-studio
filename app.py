"""Desktop entrypoint for XIQ-SE API Studio (.exe launcher)."""

import argparse
import os
import sys
import time
import webbrowser

from backend.server import start_embedded_server


def main() -> None:
    parser = argparse.ArgumentParser(description="XIQ-SE API Studio - Extreme Networks NBI GraphQL Client")
    parser.add_argument("--browser", action="store_true", help="Ouvrir dans le navigateur par défaut au lieu de la fenêtre native.")
    parser.add_argument("--headless", action="store_true", help="Démarrer uniquement le serveur HTTP local sans ouvrir de fenêtre.")
    parser.add_argument("--port", type=int, default=0, help="Port TCP local (0 = automatique).")
    args, _ = parser.parse_known_args()

    server, port, _ctx = start_embedded_server(host="127.0.0.1", port=args.port)
    url = f"http://127.0.0.1:{port}/"

    if args.headless:
        print(f"XIQ-SE API Studio server running at {url}", flush=True)
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            server.shutdown()
        return

    if not args.browser:
        try:
            import webview  # type: ignore

            window = webview.create_window(
                title="XIQ-SE API Studio — Extreme Networks",
                url=url,
                width=1420,
                height=900,
                min_size=(1060, 680),
                background_color="#0b1120",
            )
            webview.start(debug=bool(os.environ.get("XIQSE_DEBUG")))
            server.shutdown()
            return
        except Exception as exc:
            # Graceful fallback to default browser if WebView2 runtime is unavailable
            if os.environ.get("XIQSE_DEBUG"):
                print(f"WebView fallback ({exc}), opening browser at {url}", file=sys.stderr)

    webbrowser.open(url)
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        server.shutdown()


if __name__ == "__main__":
    main()
