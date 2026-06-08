#!/usr/bin/env bash
# Rychlý redeploy s --checksum aby se nezapomněly přepsat byte-identické soubory
set -euo pipefail
SERVER="${1:-root@10.7.0.1}"

cd "$(dirname "$0")/.."
npm run build
rsync -avzc --delete -e ssh dist/ "$SERVER:/opt/icovazby/dist/"
rsync -avzc -e ssh public/ "$SERVER:/opt/icovazby/public/"
ssh "$SERVER" 'chown -R icovazby:icovazby /opt/icovazby/{dist,public} && systemctl restart icovazby'
echo ""
echo "Test:"
ssh "$SERVER" 'sleep 3; curl -s http://127.0.0.1:3000/healthz | head -c 200'
echo ""
