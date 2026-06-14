# Deployment

> **⚠️ Aktuální produkce: Hukot VPS `ivz1` (`46.36.40.227`), ne Hetzner.**
> Migrace 2026-06 (viz [`docs/MIGRATION_HUKOT.md`](../docs/MIGRATION_HUKOT.md)).
> Tento návod je historicky psaný pro Hetzner CX11; obecné kroky (Ubuntu 24.04 +
> Caddy + Node + systemd) platí pro libovolný VPS. Běžný redeploy aplikace:
> `deploy/redeploy.sh` (cílí na `root@10.7.0.1` přes WireGuard).

Tahle složka obsahuje **`install.sh`** — one-shot install skript pro produkční nasazení na čerstvé Ubuntu 24.04 LTS instanci.

## Hetzner CX11 — co stačí

| Resource | CX11 | App potřebuje | Margin |
|---|---|---|---|
| vCPU | 1 (shared) | 1 (peak při holding) | ⚠ pohybuje se na limitu při ≥50 souběžných |
| RAM | 2 GB | ~400 MB peak | ✅ 4× rezerva |
| Disk | 20 GB SSD | ~300 MB | ✅ 60× rezerva |
| Traffic | 20 TB/měs | ~10 GB při 100k pageviews | ✅ 2000× rezerva |

**Verdict:** pro free OSS MVP (0-300 unique users/den, 1000+ prověrek) je CX11 **dostatečný**. Při >50 souběžných requestech vyleze response time na 3-5 s — upgrade na CX22 (2 vCPU) za 6 €/měs.

## Setup ve 3 krocích

### 1. Hetzner Cloud — vytvořit CX11

- Image: **Ubuntu 24.04**
- Location: nejbližší (Falkenstein DE / Helsinki FI / Nuremberg DE pro CZ uživatele)
- SSH klíč: nahrát svůj veřejný
- Backups: doporučeno (1.20 €/měs, daily snapshot)
- Cloud Firewall: volitelné, ufw v install.sh stačí

### 2. DNS

Nastav A/AAAA record domény na IP CX11.

### 3. Run install.sh

SSH na server jako root:

```sh
ssh root@<server-ip>
curl -fsSL https://raw.githubusercontent.com/milos106/icovazby/main/deploy/install.sh | bash -s icovazby.example.com
```

Skript:
1. Aktualizuje systém
2. Nainstaluje Node 20 LTS, Caddy, ufw, fail2ban
3. Vytvoří user `icovazby`, klonuje repo do `/opt/icovazby`, build
4. Nastaví systemd service s memory cap 900 MB + sandboxing
5. Caddy reverse proxy s automatickým Let's Encrypt TLS
6. ufw firewall (jen 22, 80, 443)
7. Swap 1 GB
8. sysctl tuning pro vysoký počet open sockets
9. fail2ban na SSH

### 4. Doplnit secrets

```sh
ssh root@<server-ip>
nano /opt/icovazby/.env
# uprav HLIDAC_API_TOKEN, SMTP_HOST, SMTP_USER, SMTP_PASS, SMTP_FROM
systemctl restart icovazby
```

## Co po instalaci

```sh
systemctl status icovazby          # běží?
journalctl -u icovazby -f          # live log
curl https://icovazby.example.com/healthz
```

## Update na novou verzi

```sh
cd /opt/icovazby
sudo -u icovazby git pull
sudo -u icovazby npm ci --omit=dev
sudo -u icovazby npm run build
systemctl restart icovazby
```

## Monitoring (volitelné)

- **Uptimerobot** (free): https check každých 5 min na `/healthz`.
- **Cloudflare** (free) před Caddy: DDoS, analytics, basic WAF.
- **Hetzner Backup** (1.20 €/měs): daily snapshot, 7 dnů retention.

## Bezpečnost out-of-box

✅ TLS via Let's Encrypt (auto-renew)
✅ HSTS + security headers
✅ ufw deny incoming, allow 22/80/443
✅ fail2ban SSH brute force jail
✅ unattended-upgrades pro security patches
✅ systemd sandboxing (`ProtectSystem=strict`, `ProtectHome=true`, `NoNewPrivileges`)
✅ Memory hard cap 900 MB → OOM-kill icovazby, ne celý server
✅ App user `icovazby` bez shell, jen `/opt/icovazby/data` writable

## Co skript NEDĚLÁ (musíš sám)

- ❌ Doplnit HLIDAC_API_TOKEN a SMTP credentials do `.env`
- ❌ Nastavit DNS
- ❌ Cloudflare proxy (volitelné)
- ❌ Externí backup (Hetzner Backup zapni v Cloud Console)
- ❌ Monitoring alert (Uptimerobot)

## Troubleshooting

**`systemctl status icovazby` ukazuje failed**
→ `journalctl -u icovazby -n 50` — typicky chyba v `.env` (špatný HLIDAC_API_TOKEN format)

**Caddy nezískává TLS cert**
→ Zkontroluj DNS propagaci (`dig icovazby.example.com`). Caddy zkouší ACME challenge na portu 80 — musí být přístupný z internetu (ufw + Hetzner Cloud Firewall).

**OOM kill**
→ `dmesg | grep -i oom` — pokud icovazby, sniž `CACHE_MAX_ENTRIES` v `.env` (default 5000 → 2000).

**ARES rate limit hit**
→ Sniž `ARES_RATE_PER_SECOND` z 5 na 3 v `.env`.
