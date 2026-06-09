#!/usr/bin/env bash
# Rychlý redeploy s --checksum aby se nezapomněly přepsat byte-identické soubory
set -euo pipefail
SERVER="${1:-root@10.7.0.1}"

cd "$(dirname "$0")/.."
npm run build
node scripts/build_static_pages.mjs
rsync -avzc --delete -e ssh dist/ "$SERVER:/opt/icovazby/dist/"
rsync -avzc -e ssh public/ "$SERVER:/opt/icovazby/public/"
# package.json je zdroj pravdy pro verzi (healthz + cache-buster v HTML).
# Musí na server, jinak runtime injekce v server.ts vidí starou verzi.
rsync -avzc -e ssh package.json "$SERVER:/opt/icovazby/package.json"
ssh "$SERVER" 'chown -R icovazby:icovazby /opt/icovazby/{dist,public,package.json} && systemctl restart icovazby'
echo ""
echo "Test:"
ssh "$SERVER" 'sleep 3; curl -s http://127.0.0.1:3000/healthz | head -c 200'
echo ""
