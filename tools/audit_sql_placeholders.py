from pathlib import Path
import ast
import re

ROOT = Path(__file__).resolve().parents[1]
PLACEHOLDER_RE = re.compile(r"(?<!%)%s")
EXCLUDED_PARTS = {".git", "venv", "__pycache__", ".pytest_cache", ".mypy_cache"}


def is_excluded(path: Path) -> bool:
    rel_parts = path.relative_to(ROOT).parts
    return any(part in EXCLUDED_PARTS or part.startswith(".patch_backups") for part in rel_parts)


def literal_string(node: ast.AST):
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    if isinstance(node, ast.JoinedStr):
        out = []
        for value in node.values:
            if isinstance(value, ast.Constant) and isinstance(value.value, str):
                out.append(value.value)
            else:
                return None
        return "".join(out)
    return None


def literal_param_count(node: ast.AST):
    if isinstance(node, (ast.Tuple, ast.List)):
        return len(node.elts)
    return None


def main() -> int:
    issues = []
    for path in ROOT.rglob("*.py"):
        if is_excluded(path):
            continue
        try:
            tree = ast.parse(path.read_text(encoding="utf-8"))
        except Exception:
            continue
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call) or len(node.args) < 2:
                continue
            fn = node.func
            fn_name = fn.attr if isinstance(fn, ast.Attribute) else (fn.id if isinstance(fn, ast.Name) else "")
            if fn_name not in {"execute", "executemany"}:
                continue
            sql = literal_string(node.args[0])
            param_count = literal_param_count(node.args[1])
            if sql is None or param_count is None:
                continue
            placeholder_count = len(PLACEHOLDER_RE.findall(sql))
            if placeholder_count and placeholder_count != param_count:
                issues.append((path.relative_to(ROOT), node.lineno, placeholder_count, param_count, " ".join(sql.strip().split())[:180]))
    if not issues:
        print("OK - aucun décalage détecté entre placeholders SQL et paramètres Python littéraux.")
        return 0
    print(f"KO - {len(issues)} décalage(s) détecté(s) :")
    for rel, line, ph, pc, preview in issues:
        print(f"- {rel}:{line} -> {ph} placeholders / {pc} paramètres :: {preview}")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
