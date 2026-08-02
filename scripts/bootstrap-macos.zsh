#!/bin/zsh
set -euo pipefail

TOOLS_DIR="$PROJECT_DIR/.tools"
UV_VERSION="0.12.1"
NODE_VERSION="22.23.2"
mkdir -p "$TOOLS_DIR"

case "$(uname -m)" in
  arm64)
    UV_PLATFORM="aarch64-apple-darwin"
    UV_EXPECTED_HASH="77d2906988e8074fd43f2f329ec452ebbf9b0c257ba1c66451c71de70a6baf42"
    NODE_PLATFORM="darwin-arm64"
    NODE_EXPECTED_HASH="61130f394c1630d211dd50aecc4353d379480f36d3ac913cd85dbba1aed585c6"
    ;;
  x86_64)
    UV_PLATFORM="x86_64-apple-darwin"
    UV_EXPECTED_HASH="69d9f9a00337f25a50dcb13882052da08b8469bac11091c98c5694c3c6721467"
    NODE_PLATFORM="darwin-x64"
    NODE_EXPECTED_HASH="58e99022c2ff89395576cc7fd4d98cea24bb68081475d5f88b801ee8729fb026"
    ;;
  *) echo "지원하지 않는 Mac CPU입니다: $(uname -m)" >&2; return 1 ;;
esac

UV_BIN="$TOOLS_DIR/uv/uv"
if [[ ! -x "$UV_BIN" ]]; then
  echo "내장 Python 관리 도구를 내려받는 중입니다..."
  mkdir -p "$TOOLS_DIR/uv"
  UV_ARCHIVE="uv-$UV_PLATFORM.tar.gz"
  UV_DOWNLOAD="$TOOLS_DIR/$UV_ARCHIVE"
  curl --fail --location --silent --show-error \
    "https://github.com/astral-sh/uv/releases/download/$UV_VERSION/$UV_ARCHIVE" \
    --output "$UV_DOWNLOAD"
  (
    cd "$TOOLS_DIR"
    printf '%s  %s\n' "$UV_EXPECTED_HASH" "$UV_ARCHIVE" | shasum -a 256 --check
  )
  tar -xzf "$UV_DOWNLOAD" -C "$TOOLS_DIR/uv" --strip-components=1
fi

export UV_PYTHON_INSTALL_DIR="$TOOLS_DIR/python"
export UV_CACHE_DIR="$TOOLS_DIR/cache"

NODE_ARCHIVE="node-v$NODE_VERSION-$NODE_PLATFORM.tar.gz"
NODE_HOME="$TOOLS_DIR/node-v$NODE_VERSION-$NODE_PLATFORM"
if [[ ! -x "$NODE_HOME/bin/node" ]]; then
  echo "내장 프런트엔드 빌드 도구를 내려받는 중입니다..."
  NODE_DOWNLOAD="$TOOLS_DIR/$NODE_ARCHIVE"
  curl --fail --location --silent --show-error \
    "https://nodejs.org/dist/v$NODE_VERSION/$NODE_ARCHIVE" \
    --output "$NODE_DOWNLOAD"
  (
    cd "$TOOLS_DIR"
    printf '%s  %s\n' "$NODE_EXPECTED_HASH" "$NODE_ARCHIVE" | shasum -a 256 --check
  )
  tar -xzf "$NODE_DOWNLOAD" -C "$TOOLS_DIR"
fi

export PATH="$NODE_HOME/bin:$PATH"

prepare_python_environment() {
  local environment_dir="$1"
  local requirements_file="$2"

  "$UV_BIN" python install 3.13 --no-bin
  if [[ ! -x "$environment_dir/bin/python" ]]; then
    "$UV_BIN" venv --python 3.13 "$environment_dir"
  fi
  "$UV_BIN" pip install --quiet \
    --python "$environment_dir/bin/python" \
    --requirements "$requirements_file"
}
