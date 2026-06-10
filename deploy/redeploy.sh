#!/usr/bin/env bash
# Rychlý redeploy s --checksum aby se nezapomněly přepsat byte-identické soubory
set -euo pipefail
SERVER="${1:-root@10.7.0.1}"

cd "$(dirname "$0")/.."
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
