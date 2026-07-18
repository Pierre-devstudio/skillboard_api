from __future__ import annotations

import os
import threading
import time
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

HOST = "127.0.0.1"
PORT = 5500
ROOT = Path(__file__).resolve().parent
STATIC_DIR = ROOT / "static"

ROUTE_FILES = {
    "/insights": "skills_portal.html",
    "/insights/": "skills_portal.html",
    "/skills": "skills_portal.html",
    "/skills/": "skills_portal.html",
    "/studio": "studio_portal.html",
    "/studio/": "studio_portal.html",
    "/people": "people_portal.html",
    "/people/": "people_portal.html",
}

START_URLS = (
    f"http://{HOST}:{PORT}/skills_login.html",
    f"http://{HOST}:{PORT}/studio_login.html",
    f"http://{HOST}:{PORT}/people_login.html",
)


class NovoskillPreviewHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(STATIC_DIR), **kwargs)

    def do_GET(self) -> None:
        parsed = urlsplit(self.path)
        target = ROUTE_FILES.get(parsed.path)
        if target:
            query = f"?{parsed.query}" if parsed.query else ""
            self.path = f"/{target}{query}"
        super().do_GET()

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()


def open_tabs() -> None:
    time.sleep(0.6)
    for url in START_URLS:
        webbrowser.open_new_tab(url)
        time.sleep(0.2)


def main() -> None:
    if not STATIC_DIR.is_dir():
        raise SystemExit(f"Dossier introuvable : {STATIC_DIR}")

    print("Skills local :", START_URLS[0])
    print("Studio local :", START_URLS[1])
    print("People local :", START_URLS[2])
    print("Arrêt : Ctrl+C")

    threading.Thread(target=open_tabs, daemon=True).start()

    server = ThreadingHTTPServer((HOST, PORT), NovoskillPreviewHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServeur local arrêté.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
