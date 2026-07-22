#!/bin/zsh
set -e

PROJECT_DIR=${0:A:h}
cd "$PROJECT_DIR"

APP_URL="http://127.0.0.1:8765"

if curl --silent --fail --max-time 2 "$APP_URL/api/health" | grep --quiet '"ok":true'; then
  echo "사진 정리가 이미 실행 중입니다. 기존 화면을 엽니다."
  open "$APP_URL"
  exit 0
fi

if lsof -tiTCP:8765 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "8765 포트를 다른 프로그램이 사용 중입니다. 해당 프로그램을 종료한 뒤 다시 실행해 주세요."
  exit 1
fi

if [[ ! -d .venv ]]; then
  python3 -m venv .venv
fi

source .venv/bin/activate
python -m pip install --quiet --disable-pip-version-check -r requirements.txt

cd frontend
npm install --silent
npm run build --silent
cd "$PROJECT_DIR"

PYTHONPATH="$PROJECT_DIR/src" python -m photo_sorter.server
