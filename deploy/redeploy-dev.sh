#!/usr/bin/env bash
# Redeploy do DEV instance (icovazby-dev :3001, /opt/icovazby-dev) → dev.icovazby.cz.
# Produkce se NEdotkne. Na prod nasazuj přes deploy/redeploy.sh (až schválí uživatel).
set -euo pipefail
SERVER="${1:-root@10.7.0.1}"

cd "$(dirname "$0")/.."
# Auto-bump patch verze PŘED buildem → cache-bust app.js (jako u prod).
if [ "${BUMP:-1}" = "1" ]; then
  npm version patch --no-git-tag-version >/dev/null
  echo "→ DEV verze $(node -p "require('./package.json').version") (cache-bust)"
fi
npm run build
node scripts/build_static_pages.mjs
rsync -avzc --delete -e ssh dist/ "$SERVER:/opt/icovazby-dev/dist/"
rsync -avzc -e ssh public/ "$SERVER:/opt/icovazby-dev/public/"
rsync -avzc -e ssh package.json package-lock.json "$SERVER:/opt/icovazby-dev/"
ssh "$SERVER" 'cd /opt/icovazby-dev && npm install --omit=dev --omit=optional --no-audit --no-fund 2>&1 | tail -2 && chown -R icovazby:icovazby /opt/icovazby-dev/{dist,public,package.json,package-lock.json,node_modules} && systemctl restart icovazby-dev'
echo ""
echo "DEV test:"
ssh "$SERVER" 'sleep 3; curl -s http://127.0.0.1:3001/healthz | head -c 200'
echo ""
echo "→ https://dev.icovazby.cz (po nastavení DNS)"
