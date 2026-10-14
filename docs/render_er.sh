#!/usr/bin/env bash
# Render the Mermaid block in docs/er_core.md to docs/er.png (white background, light theme).
# Needs podman (rootless) or docker. Usage: ./docs/render_er.sh
set -euo pipefail
cd "$(dirname "$0")"
trap 'rm -f er.mmd mermaid.config.json puppeteer.config.json' EXIT

RUNTIME=$(command -v podman || command -v docker)
sed -n '/^```mermaid$/,/^```$/p' er_core.md | sed '1d;$d' > er.mmd
echo '{ "theme": "default" }' > mermaid.config.json
echo '{ "args": ["--no-sandbox"] }' > puppeteer.config.json

# --user root: in rootless podman this maps to your own user on the host, so the
# output file is owned by you. Chromium needs --no-sandbox when run as root.
"$RUNTIME" run --rm --user root -e PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium -v "$PWD:/data:Z" docker.io/minlag/mermaid-cli:latest \
  -i /data/er.mmd -o /data/er.png -c /data/mermaid.config.json \
  -p /data/puppeteer.config.json -b white -s 2

echo "wrote docs/er.png"
