# Migrace na Hukot VPS-L04G (`ivz1`)

> **Status:** připraveno k zahájení po objednávce VPS  
> **Cíl:** Sjednotit Hetzner + 3 Hukot webhostings do jednoho VPS v ČR; odblokovat MSP Veřejný rejstřík (CZ IP)  
> **Tarif:** Hukot VPS-L04G (4 GB / 2 vCPU / 40 GB NVMe / 140 Kč/měs), 12 měsíců předplatné, Ubuntu 24.04 LTS, datacentrum Česká Třebová  
> **Pracovní okno:** ~3 h aktivního setupu + 14 dní paralelního provozu, pak cutover  
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

## Phase 0 — Pre-migrace (před objednávkou)

- [x] Hukot support potvrdil CZ datacentrum + CZ IP
- [x] Tarif vybrán: **L04G ročně**
- [x] OS: Ubuntu 24.04 LTS Server
- [x] Hostname: `ivz1`
- [x] Up-link 100 Mbps, plný root, bez Managed, bez CPU Compute, bez zálohy, bez snapshotů, bez IPv4 navíc, bez Object Storage
- [x] PDF faktura z Hetzneru nahrána k migračnímu bonusu

---

## Phase 1 — Objednávka

- [ ] **Stisknout OBJEDNAT** s platbou kartou (~60 s aktivace)
- [ ] Zaznamenat veřejnou IPv4 nového VPS: `___________________`
- [ ] Zaznamenat počáteční root heslo (z welcome emailu)
- [ ] Zaznamenat částku migračního bonusu (10 % nevyčerpaného Hetzner období) — po vyřízení Hukotu

> ⚠️ **POZOR:** WPH-01 kkevents.cz **má obsah** (jen bez DB) — nezrušit okamžitě, viz Phase 8.

---

## Phase 2 — SSH bootstrap + akceptační test (do 30 min od aktivace)

- [ ] První SSH login: `ssh root@<NEW_IP>` s heslem z welcome
- [ ] Změnit root heslo: `passwd`
- [ ] Vytvořit user `milos` se sudo: `adduser milos && usermod -aG sudo milos`
- [ ] Přidat veřejný SSH klíč do `~milos/.ssh/authorized_keys` (varianta A z konverzace)
- [ ] Otestovat přihlášení jako `milos` z desktopu
- [ ] Zakázat SSH heslem v `/etc/ssh/sshd_config` (`PasswordAuthentication no`)
- [ ] **🎯 AKCEPTAČNÍ TEST — curl MSP:**
  ```bash
  curl -s -o /dev/null -w "%{http_code}\n" \
    -H "Accept: application/json" \
    "https://verejnerejstriky.msp.gov.cz/api/rejstriky/navrhy?hledanyText=26185610&rejstriky=VR"
  ```
  - **Pokud `200`** → ✅ jedeme dál
  - **Pokud `403`** → 🛑 STOP, kontaktovat Hukot support (IP není CZ AS)
- [ ] `whois <NEW_IP>` — potvrdit CZ AS / Hukot.net jako organizaci
- [ ] `timedatectl set-timezone Europe/Prague`
- [ ] `hostnamectl set-hostname ivz1`
- [ ] `apt update && apt upgrade -y`
- [ ] Zapnout unattended-upgrades

---

## Phase 3 — Bezpečnostní vrstva

- [ ] UFW firewall:
  ```bash
  ufw default deny incoming
  ufw default allow outgoing
  ufw allow 22/tcp     # SSH
  ufw allow 80/tcp     # HTTP (Let's Encrypt + redirect)
  ufw allow 443/tcp    # HTTPS
  ufw allow 51820/udp  # WireGuard
  ufw enable
  ```
- [ ] Fail2ban: `apt install fail2ban` + jail pro sshd
- [ ] SSH only-key auth ověřit
- [ ] `auditd` (volitelně)

---

## Phase 4 — Stack instalace

- [ ] **Node 20 LTS** přes nvm pod userem `milos` (NE root)
- [ ] **Caddy 2** z oficiálního repa (`https://caddyserver.com/docs/install#debian-ubuntu-raspbian`)
- [ ] **PHP-FPM 8.4** + extensions: `php8.4-{fpm,mysql,curl,gd,xml,mbstring,intl,zip,bcmath}`
- [ ] **MariaDB 11 LTS** (`mariadb-server`)
  - [ ] `mysql_secure_installation`
  - [ ] Disable remote root, drop test DB
- [ ] **WireGuard tools** (`apt install wireguard`)
- [ ] **Nástroje:** rsync, jq, htop, vim, git, screen, tmux
- [ ] **Better-sqlite3 prereq:** `apt install build-essential python3` (kvůli native modulu)

---

## Phase 5 — Migrace icovazby.cz (Node + SQLite)

- [ ] Vytvořit `/opt/icovazby` s ownership user `icovazby` (system user)
- [ ] `git clone https://github.com/milos106/icovazby /opt/icovazby` *(nebo rsync z Hetzneru)*
- [ ] **Rsync data z Hetzneru:**
  ```bash
  rsync -avz --progress root@10.7.0.1:/opt/icovazby/data/ /opt/icovazby/data/
  ```
- [ ] `cd /opt/icovazby && npm ci --omit=dev`
- [ ] Vytvořit `.env` (kopírovat secrets z Hetzneru):
  - `HLIDAC_API_TOKEN=...`
  - `RESEND_API_KEY=...`
  - `ARES_WEB_DATA_DIR=/opt/icovazby/data`
  - **NEPOUŽÍVAT** `VR_PROXY_URL` ani `VR_PROXY_TOKEN` (volíme přímo MSP z CZ IP)
- [ ] `npm run build`
- [ ] Vytvořit `/etc/systemd/system/icovazby.service`
- [ ] systemd timery:
  - [ ] `icovazby-upv-refresh.timer` (denně 04:30)
  - [ ] `icovazby-drip.timer` (4× denně) *(pokud používáme)*
  - [ ] `vr-warmup.timer` *(zrušit — už nepotřebujeme CF Worker proxy)*
- [ ] `systemctl enable --now icovazby`
- [ ] Caddy config pro `icovazby.cz` → `:3000` (auto Let's Encrypt)
- [ ] Test: `curl https://ivz1.simplesolar.cz/api/health` (po DNS) nebo `curl --resolve icovazby.cz:443:<NEW_IP> ...`

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

- [ ] Vygenerovat nový server key pair na `ivz1`:
  ```bash
  cd /etc/wireguard && wg genkey | tee privatekey | wg pubkey > publickey
  ```
- [ ] Vytvořit `/etc/wireguard/wg0.conf` (server)
- [ ] `systemctl enable --now wg-quick@wg0`
- [ ] Aktualizovat peer config na **desktopu** (`/etc/wireguard/hetzner.conf` → `/etc/wireguard/ivz1.conf`)
- [ ] Aktualizovat peer config na **telefonu** (WireGuard app)
- [ ] Test tunelu: `ping 10.8.0.1` z desktopu
- [ ] Aktualizovat `~/.ssh/config` na desktopu (alias `ivz1`)

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

**Datum zahájení:** _______________  
**Datum dokončení Phase 11:** _______________  
**Datum vypnutí Hetzneru:** _______________  
**Datum potvrzení kreditu Hukotu:** _______________
