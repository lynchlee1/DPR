from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
SOURCE_ROOTS = ("src", "frontend/src", "tests", "packaging", "scripts")
SOURCE_SUFFIXES = {".css", ".js", ".jsx", ".py", ".ts", ".tsx"}
MAX_SOURCE_LINES = 1_000


def test_source_files_do_not_exceed_1000_lines() -> None:
    oversized = []

    for source_root in SOURCE_ROOTS:
        for path in (PROJECT_ROOT / source_root).rglob("*"):
            if path.is_file() and path.suffix in SOURCE_SUFFIXES:
                line_count = len(path.read_text(encoding="utf-8").splitlines())
                if line_count > MAX_SOURCE_LINES:
                    oversized.append(f"{path.relative_to(PROJECT_ROOT)} ({line_count} lines)")

    assert not oversized, "Source files must be split at 1,000 lines:\n" + "\n".join(oversized)
