# Migrace na Hukot VPS-L04G (`ivz1`)

> **Status:** Phase 1–5 hotovo, Phase 9 částečně (icovazby.cz cutover hotov). Pokračujeme Phase 6 (simplesolar).  
> **VPS:** ivz1 (46.36.40.227 / 2a02:25b0:aaaa:2f27::), Ubuntu 24.04.4 LTS, Hukot Česká Třebová  
> **Cíl:** Sjednotit Hetzner + 3 Hukot webhostings do jednoho VPS v ČR; odblokovat MSP Veřejný rejstřík (CZ IP)  
> **Tarif:** Hukot VPS-L04G (4 GB / 2 vCPU / 40 GB NVMe / 140 Kč/měs), 12 měsíců předplatné  
> **Tento dokument prochází v krocích shora dolů. Odškrtávat checkboxy po splnění.**

---

## Souhrn cílů

```
Z (před):                                       Na (po):
  ├─ Hetzner FSN1 (DE, blokované MSP)           ├─ Hukot ivz1 (CZ, Česká Třebová)
  │  └─ icovazby.cz (Node + SQLite)             │  ├─ icovazby.cz (Node + SQLite)
  ├─ Hukot WH-01: mb-tenis.cz (PHP 7)           │  ├─ simplesolar.cz (PHP 8.4 + 2× DB)
  ├─ Hukot WH-03: simplesolar.cz (PHP 8.4)      │  ├─ mb-tenis.cz (PHP 8.4)
  ├─ Hukot WPH-01: kkevents.cz (WordPress)      │  ├─ kkevents.cz (placeholder → PHP)
  └─ ~280 Kč/měs                                │  └─ WireGuard endpoint
                                                ├─ Cloudflare Email Routing (simplesolar.cz)
                                                └─ 140 Kč/měs = úspora 140 Kč/měs
```

---

## Phase 0 — Pre-migrace (před objednávkou) ✅

- [x] Hukot support potvrdil CZ datacentrum + CZ IP
- [x] Tarif vybrán: **L04G ročně**
- [x] OS: Ubuntu 24.04 LTS Server
- [x] Hostname: `ivz1`
- [x] Up-link 100 Mbps, plný root, bez Managed, bez CPU Compute, bez zálohy, bez snapshotů, bez IPv4 navíc, bez Object Storage
- [x] PDF faktura z Hetzneru nahrána k migračnímu bonusu

---

## Phase 1 — Objednávka ✅

- [x] **Stisknout OBJEDNAT** s platbou kartou (aktivace 2026-06-11)
- [x] Zaznamenat veřejnou IPv4 nového VPS: **`46.36.40.227`** (IPv6: `2a02:25b0:aaaa:2f27::`)
- [x] Zaznamenat počáteční root heslo (z welcome emailu)
- [ ] Zaznamenat částku migračního bonusu (10 % nevyčerpaného Hetzner období) — po vyřízení Hukotu

> ⚠️ **POZOR:** WPH-01 kkevents.cz **má obsah** (jen bez DB) — nezrušit okamžitě, viz Phase 8.

---

## Phase 2 — SSH bootstrap + akceptační test ✅

- [x] První SSH login: `ssh root@46.36.40.227` (Hukot konzole, heslo z welcome)
- [x] Změnit root heslo: `passwd`
- [x] Vytvořit user `milos` se sudo — _přeskočeno, používáme root + SSH klíč_
- [x] Přidat veřejný SSH klíč do `~/.ssh/authorized_keys` (přes `ssh-copy-id` z lokálu)
- [x] Otestovat přihlášení z desktopu
- [x] Zakázat SSH heslem v `/etc/ssh/sshd_config` (`PasswordAuthentication no` + `PermitRootLogin prohibit-password`)
- [x] **🎯 AKCEPTAČNÍ TEST — curl MSP:** ✅ **200 OK**, JSON s AGROFERT daty, 5/5 bez rate limitu, latence 150 ms
  ```bash
  curl -s -o /dev/null -w "%{http_code}\n" \
    -H "Accept: application/json" \
    "https://verejnerejstriky.msp.gov.cz/api/rejstriky/navrhy?hledanyText=26185610&rejstriky=VR"
  ```
  - **Pokud `200`** → ✅ jedeme dál
  - **Pokud `403`** → 🛑 STOP, kontaktovat Hukot support (IP není CZ AS)
- [x] `whois <NEW_IP>` — potvrdit CZ AS (Hukot písemné potvrzení postačí)
- [x] `timedatectl set-timezone Europe/Prague`
- [x] hostname `ivz1` byl nastaven Hukotem při bootstrapu
- [x] `apt update && apt upgrade -y` (unattended-upgrades udělal automaticky při first boot)
- [x] Zapnout unattended-upgrades

---

## Phase 3 — Bezpečnostní vrstva ✅

- [x] UFW firewall:
  ```bash
  ufw default deny incoming
  ufw default allow outgoing
  ufw allow 22/tcp     # SSH
  ufw allow 80/tcp     # HTTP (Let's Encrypt + redirect)
  ufw allow 443/tcp    # HTTPS
  ufw allow 51820/udp  # WireGuard
  ufw enable
  ```
- [x] Fail2ban s sshd jail (1 jail aktivní)
- [x] SSH only-key auth ověřeno
- [ ] `auditd` (volitelně) — _přeskočeno_

---

## Phase 4 — Stack instalace ✅

- [x] **Node 20 LTS** přes NodeSource apt repo (v20.20.2, npm 10.8.2) — systemový, ne nvm
- [x] **Caddy 2** z oficiálního repa (v2.11.4)
- [x] **PHP-FPM 8.4** + extensions: `php8.4-{fpm,cli,mysql,curl,gd,xml,mbstring,intl,zip,bcmath}` (8.4.22)
- [x] **MariaDB 10.11 LTS** (Ubuntu 24.04 default; pro náš case LTS do 2028 stačí)
  - [x] `mysql_secure_installation` ekvivalent (drop test DB, anonymous users)
  - [x] Disable remote root, drop test DB
- [x] **WireGuard tools**
- [x] **Nástroje:** rsync, jq, htop, vim, git, tmux
- [x] **Better-sqlite3 prereq:** `build-essential` + python3

---

## Phase 5 — Migrace icovazby.cz (Node + SQLite) ✅

- [x] Vytvořit `/opt/icovazby` s ownership user `icovazby` (system user UID 107)
- [x] Tar pipe z Hetzneru přes lokál (`ssh hetzner tar c | ssh ivz1 tar x`) — 113 MB za 4 sekundy přes WG
- [x] **Rsync data z Hetzneru** — persons-index.sqlite 93 MB, persons-index.json 21 MB, dist/, src/, public/
- [x] `cd /opt/icovazby && npm ci --omit=dev` — dependencies nainstalovány
- [x] Vytvořit `.env` (kopírováno z Hetzneru, odstraněno `VR_PROXY_URL` + `VR_PROXY_TOKEN`)
- [x] **NE-spuštěn `npm run build`** — dist/server.js z Hetzneru je hotový (196 KB)
- [x] Vytvořit `/etc/systemd/system/icovazby.service` (zkopírováno z Hetzneru)
- [x] systemd timery:
  - [x] `icovazby-upv-refresh.timer` (denně 04:30)
  - [x] `icovazby-drip.timer` (hodinově)
  - [x] `icovazby-refresh.timer` (neděle 03:00)
  - [x] `vr-warmup.timer` *(zrušen — nepotřebujeme CF Worker proxy)*
- [x] `systemctl enable --now icovazby` — služba běží, 145 MB RSS
- [x] Caddy config pro `icovazby.cz` + `www.icovazby.cz` → `:3000` (auto Let's Encrypt)
- [x] **LE cert získán** přes HTTP-01 challenge (po DNS cutover na ivz1 + dočasně DNS only)
- [x] Test: `curl https://icovazby.cz/api/vr/26185610` → **200 OK, plný JSON s AGROFERT daty, latence 110 ms (přes CF: 81 ms)**

### Cleanup CF Worker `vr-proxy` (po cutoveru icovazby.cz) ✅

- [x] Hetzner `vr-warmup.timer` + `vr-warmup.service` disablovány (zbytečné pingování)
- [x] Hetzner `.env`: odstraněn `VR_PROXY_URL` + `VR_PROXY_TOKEN`
- [x] CF Worker `vr-proxy.milospospisil68.workers.dev` smazán z dashboardu (verified: vrací 404)

---

## Phase 6 — Migrace simplesolar.cz (PHP + 2 DB)

- [ ] SSH na WH-03 (Hukot shell)
- [ ] Backup obsahu:
  ```bash
  tar czf simplesolar-www.tar.gz /home/.../www/
  mysqldump --all-databases --single-transaction > simplesolar-dbs.sql
  ```
- [ ] Scp tarball + SQL na nový VPS
- [ ] Rozbalit do `/var/www/simplesolar`
- [ ] Vytvořit DB usera + import:
  ```sql
  CREATE DATABASE simplesolar_db1; CREATE DATABASE simplesolar_db2;
  CREATE USER 'simplesolar'@'localhost' IDENTIFIED BY '...';
  GRANT ALL ON simplesolar_db1.* TO 'simplesolar'@'localhost';
  GRANT ALL ON simplesolar_db2.* TO 'simplesolar'@'localhost';
  ```
- [ ] Update DB connection v PHP konfigu (host=localhost, nová hesla)
- [ ] PHP-FPM pool config pro `simplesolar` (vlastní socket)
- [ ] Caddy config: `simplesolar.cz` → PHP-FPM passthrough
- [ ] Převést cron jobs (z Hukot panelu) na crontab nebo systemd timery
- [ ] **Test curl-called scriptů** z `curl http://localhost/skript.php`
- [ ] **Akceptační test:** přístup přes `curl --resolve simplesolar.cz:443:<NEW_IP> https://simplesolar.cz/`

---

## Phase 7 — Migrace mb-tenis.cz (PHP)

- [ ] Stejný proces: backup obsahu + DB z WH-01
- [ ] **Pozor: PHP 7.0 → 8.4 kompatibilita test** (deprecated funkce: `mysql_*` API, `each()`, `create_function()`, …)
  - [ ] Spustit `php -l` na všechny `.php` souborech
  - [ ] Případně si pomoci nástrojem [PHPCompatibility](https://github.com/PHPCompatibility/PHPCompatibility)
- [ ] DB import (1 DB)
- [ ] PHP-FPM pool
- [ ] Caddy config

---

## Phase 8 — Migrace kkevents.cz (WP soubory, **bez DB**)

> Tarif WPH-01, WordPress hosting, PHP 8.4. Web má **obsah ale žádnou DB** — buď nedokončená WP instalace, statický export, nebo soubory bez aktivní DB. Stáhneme všechno a rozhodneme se na místě podle obsahu.

- [ ] SSH na WPH-01 (Hukot shell) — projít strukturu `/home/.../www/`
  - [ ] `ls -lah` v root webu — kolik MB, co tam je (wp-config.php? wp-content/uploads?)
  - [ ] `find . -name "wp-config.php"` — pokud existuje, vytáhnout DB connection údaje (i když DB neexistuje, hodí se vědět, co tam mělo být)
- [ ] Backup obsahu:
  ```bash
  tar czf kkevents-www.tar.gz /home/.../www/
  ```
- [ ] **Pokud má WP soubory:** zkontrolovat `wp-content/uploads/` (media) a `wp-content/themes/` (vlastní šablona?). To je to, co nelze znovu vytvořit.
- [ ] **Pokud byla DB ale teď je smazaná:** zeptat se Hukot support, zda mají backup DB v zálohách
- [ ] Scp tarball na nový VPS
- [ ] Rozbalit do `/var/www/kkevents`
- [ ] **Rozhodnutí podle obsahu:**
  - **A) Funkční WordPress** → instalovat fresh WP na VPS, nahrát uploads + themes, ručně nastavit
  - **B) Statický export** → Caddy serve jako statika
  - **C) Hybridní (pár PHP skriptů)** → PHP-FPM passthrough
- [ ] Caddy config pro `kkevents.cz`
- [ ] **Akceptační test:** stránka odpovídá z nové IP s viditelným obsahem
- [ ] **Pozdější:** přepsat na vlastní PHP / nový web (separate task)

---

## Phase 9 — DNS cutover (Cloudflare)

> **Plán:** Cloudflare TTL je 60 s, propagace okamžitá. Cutover po doménách.

- [ ] **icovazby.cz** A → `<NEW_IP>` (po úspěšném Phase 5)
- [ ] **simplesolar.cz** A → `<NEW_IP>` (po úspěšném Phase 6)
- [ ] **mb-tenis.cz** A → `<NEW_IP>` (po Phase 7)
- [ ] **kkevents.cz** A → `<NEW_IP>` (po Phase 8)
- [ ] **simplesolar.cz** Cloudflare Email Routing:
  - [ ] Zapnout v Cloudflare dashboard
  - [ ] CF automaticky přidá MX záznamy
  - [ ] Custom address: `*@simplesolar.cz` (catchall) → `milospospisil68@gmail.com`
  - [ ] Verifikace Gmail link
  - [ ] **Test:** poslat email na `test@simplesolar.cz`, ověřit doručení do Gmailu

---

## Phase 10 — WireGuard migrace z Hetzneru

- [x] Vygenerovat nový server key pair na `ivz1` — server pubkey: `pYouF8OkSrt23DJQqZ+lQa0WC8/N/rpSi2/RhNuvBXo=`
- [x] Vytvořit `/etc/wireguard/wg0.conf` (server) — stejná subnet 10.7.0.0/24 + IPv6 `fddd:2c4:2c4:2c4::/64`, port 51820, NAT MASQUERADE/SNAT na ens18, 3 peery zkopírovány z Hetzneru (thinkpad, mobil, macbookVPN)
- [x] `systemctl enable --now wg-quick@wg0`
- [x] Aktualizovat peer config na **desktopu** — vytvořen `/etc/wireguard/ivz1.conf`, `hetzner.conf` ponechán jako fallback; `wg-quick down hetzner && wg-quick up ivz1`
- [x] Aktualizovat `~/.ssh/known_hosts` (10.7.0.1 měl Hetzner SSH fingerprint, teď ivz1)
- [x] `systemctl enable wg-quick@ivz1` (auto-up po rebootu)
- [x] Test tunelu: `ssh root@10.7.0.1 hostname` → vrátí `ivz1` ✅
- [ ] Aktualizovat peer config na **telefonu** (WireGuard app):
  - Peer's Public Key: → `pYouF8OkSrt23DJQqZ+lQa0WC8/N/rpSi2/RhNuvBXo=`
  - Endpoint: → `46.36.40.227:51820`
- [x] Aktualizovat peer config na **macbookVPN** — provedeno vzdáleně přes SSH ProxyJump (lokál → Hetzner public → macbook WG); `wg-quick` na macbooku má hardkód `CONF="/usr/local/etc/wireguard/hetzner.conf"`, takže fyzický `hetzner.conf` přepsán ivz1 settings (jméno souboru je legacy, obsah = ivz1)
- [ ] Po týdnu paralelního provozu (mobil + macbook ověřit) — `systemctl disable --now wg-quick@wg0` na Hetzneru
- [ ] Smazat `/etc/wireguard/hetzner.conf` z lokálu po finálním vypnutí

---

## Phase 10.5 — RustDesk self-hosted na ivz1 (nepředpokládaný bonus)

> Mid-migration jsme objevili že veřejný RustDesk NY relay (`rs-ny.rustdesk.com:21117`) je dlouhodobě **down**. Padly RustDesk z mobilu i thinkpadu. Nasadili jsme vlastní `hbbs` + `hbbr` na ivz1.

- [x] Stáhnut `rustdesk-server` 1.1.15 (oficiální OSS, MIT) z GitHub releases
- [x] System user `rustdesk` + `/opt/rustdesk-server` ownership
- [x] Systemd units: `rustdesk-hbbs.service` + `rustdesk-hbbr.service` (MemoryMax=256M každý)
- [x] UFW: `21115-21119/tcp` + `21116/udp` allowed
- [x] Public Key pro klienty: `kdz3PlzBwaCozKgucjImxBL3QLVYmVIP51POvVDoHCs=`
- [x] Resource footprint: ~10 MB RAM, ~10 MB disk
- [x] **RustDesk klient config** — ID server `46.36.40.227`, key výše

### Vedlejší fix — UFW WG forwarding (pro full-tunnel mobil)

- [x] `DEFAULT_FORWARD_POLICY` zůstává `DROP` (paranoidní default)
- [x] UFW route allow:
  - `in on wg0 out on ens18` — WG peery → internet (split + full tunnel)
  - `in on ens18 out on wg0` — odpovědi
  - `in on wg0 out on wg0` — peer-to-peer přes ivz1 hub (mobile ↔ thinkpad direct)
- [x] Bez tohoto fixu: Chrome na mobilu nejede (full-tunnel WG dropuje pakety v UFW)

---

## Phase 11 — ha1.pp.ua (DDNS / tunel)

- [ ] Ověřit, zda DNS u `pp.ua` registrátora ukazuje na správné cílové místo
- [ ] Pokud Cloudflare Tunnel z domácí HA: žádná změna na ivz1
- [ ] Pokud reverse SSH tunel přes mojeVPS: přemigrovat na ivz1
- [ ] Pokud jen ddclient z domácí: žádná akce nutná

---

## Phase 12 — Verifikace + 7 dní paralelního provozu

- [ ] `icovazby.cz` z nové IP odpovídá s plnou funkcionalitou
  - [ ] `/api/health` 200
  - [ ] `/api/dd/26185610` plný profil
  - [ ] `/api/vr/26185610` 200 s daty (NE `vr_blocked`!)
  - [ ] `/api/ds/26185610` 200 s DS ID
  - [ ] AI souhrn funguje (BYO klíč)
  - [ ] PDF prověrka generuje se
  - [ ] Bulk DD ZIP test
- [ ] `simplesolar.cz` odpovídá
- [ ] `mb-tenis.cz` odpovídá
- [ ] `kkevents.cz` placeholder
- [ ] Email forward funguje (test zpráva)
- [ ] WG tunel desktop ↔ `ivz1` funguje
- [ ] **Monitoring 7 dní:**
  - [ ] `free -h` hourly screenshot v `journalctl`
  - [ ] `iostat -x 10` během Bulk DD
  - [ ] UptimeRobot ping na `icovazby.cz/api/health`
  - [ ] Sledovat OOM v `dmesg`
  - [ ] Sledovat I/O latence (SSD propad na 0 MB/s je známý risk)

---

## Phase 13 — Vypnutí starých služeb (po 14 dnech)

- [ ] **Email výpověď WH-01 mb-tenis** (Příloha B)
- [ ] **Email výpověď WH-03 simplesolar** (Příloha B)
- [ ] **Email výpověď WPH-01 kkevents** (Příloha B, varianta WPH)
- [ ] Počkat na potvrzení Hukotu + připsání kreditu (souhrnně ~700–1 200 Kč)
- [ ] Smazat hostings v admin panelu (až po písemném potvrzení)
- [ ] **Hetzner backup:** vytvořit poslední snapshot persons-index.sqlite a stáhnout k sobě jako pojistku
- [ ] Vypnout / smazat Hetzner VPS (cancel v admin panelu)
- [ ] Ověřit, že úspora se dostavila na příští faktuře Hetzneru

---

## Phase 14 — Cleanup + dokumentace

- [ ] Aktualizovat memory `reference_hetzner_vpn.md` → `reference_hukot_ivz1.md`
- [ ] Aktualizovat README s novou IP / `/etc/hosts` aliasy
- [ ] **Cloudflare R2 backup** persons-index.sqlite (denně cron + retention 30 dní)
- [ ] Aktualizovat `deploy/redeploy.sh` na novou cílovou IP/hostname
- [ ] Aktualizovat `.env.example` s novými proměnnými (bez VR_PROXY_*)
- [ ] Vytvořit zaznamenat **bezpečnostní postup** (kdo má SSH klíč, kde jsou recovery codes)

---

## Akceptační kritéria úspěšné migrace

```
✅ 5 webů odpovídá z CZ IP
✅ icovazby /api/vr/26185610 vrací 200 OK (NE vr_blocked)
✅ Bulk DD generuje 50 PDF najednou bez OOM
✅ Email forwarding simplesolar.cz → Gmail funguje
✅ WireGuard tunel mezi desktopem a ivz1
✅ Hetzner vypnutý (úspora 150 Kč/měs)
✅ WPH-01, WH-01, WH-03 zrušeny → ~700–1 200 Kč kredit u Hukotu
✅ Mesíční náklady: 140 Kč (jen VPS), úspora ~140 Kč/měs vs. před
```

---

## Příloha A — ~~Email šablona: rušení WPH-01 kkevents.cz (dnes)~~

> ⚠️ **Zrušeno:** kkevents má obsah, nemůžeme okamžitě rušit. Migrace v Phase 8, výpověď v Phase 13 (viz Příloha B).

---

## Příloha B — Email šablona: rušení **WH-01 / WH-03** (po 14 dnech)

> **Předmět:** Výpověď služby **[WH-01 mb-tenis.cz / WH-03 simplesolar.cz]**
>
> Dobrý den,
>
> tímto vypovídám smlouvu o poskytování služeb webhostingu **[mb-tenis.cz (WH-01) / simplesolar.cz (WH-03)]** ke dni [DATUM]. Veškerý obsah jsem si stáhl a migroval na svůj VPS u vás (ivz1).
>
> Žádám prosím o:
> 1. Potvrzení ukončení smlouvy
> 2. Připsání alikvotní části za nevyčerpané období jako kredit na můj uživatelský účet u Hukotu (dle čl. X provozních podmínek)
>
> Děkuji.
>
> S pozdravem,
> Miloš Pospíšil

---

## Příloha C — Rollback plán (kdyby něco selhalo)

```
1. DNS rollback (Cloudflare): A záznam zpět na Hetzner IP (TTL 60s = okamžitě)
2. Hetzner VPS je stále up (do dne X+14)
3. Hukot hostings stále up (do potvrzení výpovědi)
4. Žádná data se nesmí mazat, dokud paralelní provoz neuspěje 7+ dní
```

---

## Příloha D — Klíčové soubory k zálohování *před* vypnutím Hetzneru

```
/opt/icovazby/data/persons-index.sqlite       (95 MB)
/opt/icovazby/data/persons-index.sqlite-wal   (WAL)
/opt/icovazby/data/ds_cache (pokud separate)
/opt/icovazby/.env                            (secrets)
/etc/wireguard/wg0.conf                       (server klíč)
/etc/systemd/system/icovazby*.service
/etc/systemd/system/icovazby*.timer
/etc/caddy/Caddyfile
```

Backup na laptop:
```bash
mkdir -p ~/backups/hetzner-final-$(date +%F)
cd ~/backups/hetzner-final-$(date +%F)
rsync -av root@10.7.0.1:/opt/icovazby/data/ ./icovazby-data/
rsync -av root@10.7.0.1:/etc/wireguard/ ./wireguard/
rsync -av root@10.7.0.1:/etc/systemd/system/icovazby*.service ./systemd/
rsync -av root@10.7.0.1:/etc/caddy/ ./caddy/
```

---

## Sledování stavu

**Datum zahájení:** 2026-06-11 12:00 CEST  
**Datum cutover icovazby.cz na ivz1:** 2026-06-11 12:28 CEST  
**Datum dokončení Phase 11:** _______________  
**Datum vypnutí Hetzneru:** _______________  
**Datum potvrzení kreditu Hukotu:** _______________

---

## Příloha E — Plánované enhancementy (po dokončení migrace)

### E1. Cloudflare DNS-01 challenge pro Caddy LE renewal

**Problém:** LE cert je platný 90 dní. Caddy auto-renew zkusí HTTP-01 challenge, ale skrz CF Proxy (orange cloud) selže — musí se manuálně přepnout na ⚪ DNS only na 5 minut během renewalu (každých ~60 dní).

**Řešení:** Nasadit Caddy s `cloudflare` DNS pluginem + Cloudflare API token (Zone:DNS:Edit pro icovazby.cz + ostatní). Caddy poté použije DNS-01 challenge, který funguje i přes orange cloud.

**Kroky:**
1. Vygenerovat CF API token s `Zone → DNS → Edit` pro všechny naše zóny
2. Rebuild Caddy přes xcaddy s `github.com/caddy-dns/cloudflare` modulem
3. V Caddyfile globální `tls` direktiva s DNS provider:
   ```caddy
   {
       acme_dns cloudflare {env.CLOUDFLARE_API_TOKEN}
   }
   ```
4. Token uložit do `/etc/caddy/.env` (chmod 600 caddy:caddy)
5. Test: `caddy reload`, sledovat získání certu přes DNS-01

**Termín:** Před prvním renewalem (~2026-08-10, tj. 60 dní od získání).

### E2. Caddy `client_ip` field v logu

**Problém:** Caddy log obsahuje `remote_ip` (CF edge) a `cf-connecting-ip` v headers (reálná klientská IP), ale `client_ip` field zůstává CF edge, ač máme `client_ip_headers CF-Connecting-IP` v Caddyfile. Backend (Fastify) dostává správný X-Forwarded-For od Caddy, takže rate-limit + audit log fungují. Jen Caddy access log je trochu zavádějící.

**Pravděpodobné příčiny:**
- Caddy 2.11 možná interpretuje `client_ip_headers` v Caddyfile jinak než v JSON config
- Možná je třeba `client_ip_headers` pod konkrétním server blokem, ne globálně
- Případně reload neproběhl celý

**Termín:** kdykoli — kosmetický fix, ne kritický.

### E3. Cloudflare R2 backup persons-index.sqlite

**Co:** Nightly cron rsync `/opt/icovazby/data/persons-index.sqlite` na R2 bucket (10 GB free tier).

**Proč:** Pojistka proti SSD selhání ivz1 (recenze hlásily ojediněle propad).

**Kroky:** Vytvořit R2 bucket, API klíče, instalovat `rclone`, cron 02:00 UTC daily, retention 30 dní.

**Termín:** Před vypnutím Hetzneru (Phase 13).

### E4. UptimeRobot ping na nový endpoint

**Co:** Přidat HTTPS check `https://icovazby.cz/` na UptimeRobot.

**Termín:** Po DNS cutover všech domén (Phase 9).
