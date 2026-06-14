#!/usr/bin/env bash
# Rychlý redeploy s --checksum aby se nezapomněly přepsat byte-identické soubory
set -euo pipefail
SERVER="${1:-root@10.7.0.1}"

cd "$(dirname "$0")/.."
# Auto-bump patch verze PŘED buildem → změní ?v={{VERSION}} u app.js a rozbije
# browser cache (jinak prohlížeče drží starý app.js až max-age 14400 = 4 h).
# --no-git-tag-version: jen upraví package.json + lock, nedělá git commit/tag.
# Skip přes BUMP=0 (např. redeploy beze změn frontendu).
if [ "${BUMP:-1}" = "1" ]; then
  npm version patch --no-git-tag-version >/dev/null
  echo "→ verze $(node -p "require('./package.json').version") (cache-bust)"
fi
npm run build
node scripts/build_static_pages.mjs
rsync -avzc --delete -e ssh dist/ "$SERVER:/opt/icovazby/dist/"
rsync -avzc -e ssh public/ "$SERVER:/opt/icovazby/public/"
# package.json + lock = zdroj pravdy pro verzi + runtime deps. Musí na server,
# jinak runtime injekce v server.ts vidí starou verzi a tsup-bundled imports
# (např. @anthropic-ai/sdk) selžou s ERR_MODULE_NOT_FOUND.
rsync -avzc -e ssh package.json package-lock.json "$SERVER:/opt/icovazby/"
ssh "$SERVER" 'cd /opt/icovazby && npm install --omit=dev --omit=optional --no-audit --no-fund 2>&1 | tail -2 && chown -R icovazby:icovazby /opt/icovazby/{dist,public,package.json,package-lock.json,node_modules} && systemctl restart icovazby'
echo ""
echo "Test:"
ssh "$SERVER" 'sleep 3; curl -s http://127.0.0.1:3000/healthz | head -c 200'
echo ""
