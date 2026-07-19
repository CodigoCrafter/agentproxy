#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
START_NOW=0
SKIP_BROWSER=0

for arg in "$@"; do
  case "$arg" in
    --start|--on)
      START_NOW=1
      ;;
    --skip-browser)
      SKIP_BROWSER=1
      ;;
    -h|--help)
      cat <<'HELP'
AgentProxy WSL installer

Usage:
  bash scripts/install-wsl.sh
  bash scripts/install-wsl.sh --start

Options:
  --start         Run proxy hermes after installation.
  --skip-browser Skip Playwright Chromium installation.
HELP
      exit 0
      ;;
    *)
      echo "Unknown option: $arg" >&2
      exit 1
      ;;
  esac
done

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "This installer is intended for WSL/Linux. On Windows, use npm install && npm run build && npm link." >&2
  exit 1
fi

if ! grep -qi microsoft /proc/version 2>/dev/null; then
  echo "Warning: WSL was not detected. Continuing because this is still Linux."
fi

# A non-interactive WSL shell can inherit npm/node.exe from the Windows PATH.
# Prefer the user's native NVM installation before checking the runtime.
if [[ -s "$HOME/.nvm/nvm.sh" ]] && {
  ! command -v node >/dev/null 2>&1 || [[ "$(node -p 'process.platform')" != "linux" ]]
}; then
  export NVM_DIR="$HOME/.nvm"
  # shellcheck disable=SC1090
  source "$NVM_DIR/nvm.sh"
  nvm use --silent default >/dev/null 2>&1 || nvm use --silent node >/dev/null 2>&1
fi

if ! command -v node >/dev/null 2>&1; then
  cat >&2 <<'ERR'
Node.js was not found.
Install Node.js 20+ inside WSL first, then run this again.
Recommended:
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
ERR
  exit 1
fi

if [[ "$(node -p 'process.platform')" != "linux" ]]; then
  echo "A Windows Node.js executable is shadowing the WSL runtime: $(command -v node)" >&2
  echo "Install Node.js 20+ inside WSL (NVM is recommended), then run the installer again." >&2
  exit 1
fi

NODE_MAJOR="$(node -p "Number(process.versions.node.split('.')[0])")"
if [[ "$NODE_MAJOR" -lt 20 ]]; then
  echo "Node.js 20+ is required. Current version: $(node -v)" >&2
  exit 1
fi

cd "$ROOT_DIR"

echo
echo "AgentProxy WSL quick install"
echo "Project: $ROOT_DIR"
echo

npm install

if [[ "$SKIP_BROWSER" -eq 0 ]]; then
  npx playwright install chromium
fi

npm run build
npm link

# Remove aliases left by the older Windows-hosted proxy setup. They override
# the native WSL npm link and point to files that may no longer exist.
if [[ -f "$HOME/.bashrc" ]]; then
  sed -i '\|alias proxy=.*/AppData/Roaming/npm/proxy\.cmd|d' "$HOME/.bashrc"
  sed -i '\|bash ~/.local/bin/update-hermes-wsl-ip\.sh|d' "$HOME/.bashrc"
fi

echo
echo "AgentProxy installed in WSL."
echo "Try: proxy status"
echo "Open a new WSL terminal after installation so the cleaned PATH takes effect."

if [[ "$START_NOW" -eq 1 ]]; then
  echo
  echo "Starting Hermes profile..."
  proxy hermes
fi
