#!/bin/zsh
set -euo pipefail

PROJECT_DIR=${0:A:h:h}
cd "$PROJECT_DIR"
source "$PROJECT_DIR/scripts/bootstrap-macos.zsh"

prepare_python_environment "$PROJECT_DIR/.venv-build" "$PROJECT_DIR/requirements-build.txt"

cd frontend
npm ci --silent
npm audit --audit-level=low
npm run build --silent
cd "$PROJECT_DIR"

"$UV_BIN" tool run pip-audit==2.10.1 --requirement requirements.txt
.venv-build/bin/python -m pytest -q
.venv-build/bin/python -m PyInstaller \
  --noconfirm \
  --clean \
  --windowed \
  --name PhotoSorter \
  --paths src \
  --add-data "frontend/dist:frontend/dist" \
  packaging/entrypoint.py

rm -f dist/PhotoSorter-macOS.zip
/usr/bin/ditto -c -k --sequesterRsrc --keepParent \
  dist/PhotoSorter.app \
  dist/PhotoSorter-macOS.zip

echo "빌드 완료: $PROJECT_DIR/dist/PhotoSorter-macOS.zip"
