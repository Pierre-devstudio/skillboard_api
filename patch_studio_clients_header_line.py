from pathlib import Path

ROOT = Path.cwd()
CSS_PATH = ROOT / "static" / "studio_portal_theme.css"

if not CSS_PATH.exists():
    raise SystemExit(f"Fichier introuvable : {CSS_PATH}")

raw = CSS_PATH.read_bytes()
newline = "\r\n" if b"\r\n" in raw else "\n"
text = raw.decode("utf-8")

marker = "/* PATCH Studio clients modal - suppression ligne header 2026-06 */"
addition = f"""

{marker}
.sb-client-modal-card .sb-modal-head {{
  border-bottom:none !important;
}}
"""

if marker in text:
    print("OK : règle déjà présente, aucun changement nécessaire.")
else:
    text = text.rstrip() + addition + "\n"
    if newline == "\r\n":
        text = text.replace("\r\n", "\n").replace("\n", "\r\n")
    CSS_PATH.write_bytes(text.encode("utf-8"))
    print(f"OK : ligne de séparation du header supprimée dans {CSS_PATH}")
