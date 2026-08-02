#!/bin/zsh
set -euo pipefail

TOOLS_DIR="$PROJECT_DIR/.tools"
UV_VERSION="0.12.1"
NODE_VERSION="22.23.2"
mkdir -p "$TOOLS_DIR"

UV_BIN="$TOOLS_DIR/uv/uv"
if [[ ! -x "$UV_BIN" ]]; then
  echo "내장 Python 관리 도구를 내려받는 중입니다..."
  mkdir -p "$TOOLS_DIR/uv"
  curl --fail --location --silent --show-error \
    "https://astral.sh/uv/$UV_VERSION/install.sh" \
    | env UV_UNMANAGED_INSTALL="$TOOLS_DIR/uv" sh
fi

export UV_PYTHON_INSTALL_DIR="$TOOLS_DIR/python"
export UV_CACHE_DIR="$TOOLS_DIR/cache"

case "$(uname -m)" in
  arm64) NODE_PLATFORM="darwin-arm64" ;;
  x86_64) NODE_PLATFORM="darwin-x64" ;;
  *) echo "지원하지 않는 Mac CPU입니다: $(uname -m)" >&2; return 1 ;;
esac

NODE_ARCHIVE="node-v$NODE_VERSION-$NODE_PLATFORM.tar.gz"
NODE_HOME="$TOOLS_DIR/node-v$NODE_VERSION-$NODE_PLATFORM"
if [[ ! -x "$NODE_HOME/bin/node" ]]; then
  echo "내장 프런트엔드 빌드 도구를 내려받는 중입니다..."
  NODE_DOWNLOAD="$TOOLS_DIR/$NODE_ARCHIVE"
  curl --fail --location --silent --show-error \
    "https://nodejs.org/dist/v$NODE_VERSION/$NODE_ARCHIVE" \
    --output "$NODE_DOWNLOAD"
  curl --fail --location --silent --show-error \
    "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" \
    --output "$TOOLS_DIR/SHASUMS256.txt"
  (
    cd "$TOOLS_DIR"
    grep " $NODE_ARCHIVE\$" SHASUMS256.txt | shasum -a 256 --check
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
