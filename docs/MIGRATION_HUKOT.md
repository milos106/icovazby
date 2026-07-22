# Migrace na Hukot VPS-L04G (`ivz1`)

> **Status (2026-06-14):** Phase 1–6 HOTOVO. Všechny 4 weby zmigrované na ivz1 (icovazby, mb-tenis, kkevents, **simplesolar** — cutover 13./14. 6.). Zbývá Phase 13: vypovědět 3 Hukot hostingy (WH-01 mb-tenis, WH-03 simplesolar, WPH-01 kkevents) + počkat na kredit. Pozn.: u simplesolaru je `info@` e-mail SOUČÁSTÍ WH-03 — před výpovědí ověřit, že CF Email Routing + odchozí pošta fungují (viz Phase 6). DNS simplesolar.cz je na Cloudflare (ne Hukot).  
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

## Phase 6 — Migrace simplesolar.cz ✅ HOTOVO (cutover 2026-06-13/14)

> **Realita byla jiná než plán.** Nebyl to „PHP + 2 DB", ale **WooCommerce web (prázdný e-shop) + custom solární monitoring** (25× `zz_*.php`) + mobilní app API. Obě DB (`aps_10406` WP, `db_monitoring` solár 175 MB) byly na EXTERNÍM Hukotím MySQL `vix.securitynet.cz` (dostupném jen z WH-03 shellu). Web jsme **přestavěli na nový** (ne lift-and-shift) a WordPress úplně zahodili.

### Přístup + stažení
- [x] SSH na WH-03: `ssh.vix.hukot.net`, login `simplesolar.cz`, dedikovaný klíč `~/.ssh/simplesolar_wh03` (alias `wh03`). **Restriktivní whitelist shell** — jen `ls` + SFTP; `mysqldump`/`mysql`/`tar` zakázané. DB tedy export přes phpMyAdmin.
- [x] Soubory (418 MB www, bez 349MB debug.log a redundantní .wpress) staženy přes SFTP do `/home/milos/work/simplesolar/wh03-pull-2026-06-13/`

### Databáze (MySQL 8.0 → MariaDB 10.11)
- [x] Export `aps_10406` + `db_monitoring` přes phpMyAdmin (gzip). Kompatibilita ověřena (žádné utf8mb4_0900, vše InnoDB)
- [x] Import na ivz1 MariaDB 10.11. Lokální user `db_monitoring`@localhost (heslo NENÍ v repu — viz `~/Stažené/dulezite/`; rotováno 2026-07-22 po úniku ve veřejném repu). Auth tabulka `fve_users` (z wp_users + table_monitoring)
- [x] Finální čerstvý dump `db_monitoring` při nočním cutoveru (zachytit celý den) → re-import. Záloha předchozího stavu v `/root/simplesolar-migration/`

### Nový web (redesign V3, ne migrace)
- [x] Statický web V3 „Solární svítání" světlý+tmavý (přepínač), zdroj `/home/milos/work/simplesolar/web-new/` (generátor `build.py`). Stránky: Úvod, Varianty (Solax X3 10K G4.4), Vzdálené řízení, Dotace NZÚ (podmínky 2026), O nás, Kontakt, GDPR zásady
- [x] Kontaktní formulář `poptavka.php` (honeypot, loguje do `/var/lib/simplesolar/poptavky.log`, odesílá přes postfix→Seznam relay)

### Moje FVE modul (WordPress zahozen)
- [x] Samostatné PHP: `prihlaseni.php` + `moje-fve.php` (dashboard s denní/měsíční historií) + `prepinace.php` (bojler/topení/nabíjení) + `inc/fve.php`. Login přes phpass (stávající WP hesla fungují), čte db_monitoring@localhost

### zz_*.php (datalogger + mobilní app)
- [x] 25 skriptů přepojeno na `localhost` (startscript.php). **4 pvapp opraveny** na prepared statements + ořez apostrofů z UserName/datum (app posílá `'dub042'`, `"2026-06-14"`). Legacy log skripty: `mysqli_report(MYSQLI_REPORT_OFF)` (jinak 500 na PHP 8.4)
- [x] **Caddy: HTTP příjem pro `/zz_*.php` bez redirectu** — dataloggery POSTují přes HTTP, jinak 308 → ztráta dat
- [x] **PHP date.timezone = Europe/Prague** (default UTC by posunul data o 2h oproti historii)

### Deploy + cutover
- [x] Docroot `/var/www/simplesolar` (staré WP záloha `/var/www/simplesolar-old-wp`), Caddy vhost + php8.4-fpm.sock
- [x] **DNS přesunuto na Cloudflare** (ne Hukot — kvůli Email Routingu a rychlejším certům). A+AAAA → ivz1 (šedý mráček), LE cert
- [x] Ověřeno end-to-end: web (IPv4+IPv6), Moje FVE, mobilní app (3 aktivní instalace: Dub042/Horní Rokytá, Srbsko, Rokyta píšou; mp1/Hostkovice nečinná od 8/2025), e-mail
- [x] **E-mail: Cloudflare Email Routing** `info@simplesolar.cz` → Seznam/Gmail (info@ bylo SOUČÁSTÍ WH-03, ne samostatné). Odchozí „odesílat jako info@" po zrušení Hukotu řešit přes Zoho nebo odpovídat ze Seznamu

### Post-cutover fix — denní souhrny zamrzlé (MariaDB strict mód) 🐞 → ✅ (2026-06-15)
- **Symptom:** appka i dashboard ukazovaly „Vyrobená/Spotřebovaná Energie – Dnes" **zamrzlou na hodnotě z 13.6.** (den cutoveru). Živá data (aktuální výkon) i `table_min` ale chodily normálně.
- **Příčina:** `table_day` (a `table_month`) mají sloupce `Es_1/Es_2/Es_3` jako **NOT NULL bez defaultu**, ale `zz_log_*.php` je v INSERTu nového dne/měsíce **nevyplňují** (jen 6 sloupců). Starý **Hukot MySQL běžel v lenient módu** → implicitní 0. **MariaDB na ivz1 = STRICT** (`STRICT_TRANS_TABLES,...`) → INSERT padá `ERROR 1364: Field 'Es_1' doesn't have a default value`, a kvůli `mysqli_report(OFF)` **tiše**. Systémové — od cutoveru `MAX(day)=20260613` pro všechny weby.
- **Fix:** `sql_mode = NO_ENGINE_SUBSTITUTION` (legacy-compat) — okamžitě přes `SET GLOBAL` (PHP otevírá fresh connection per request → hned) + persistentně v `/etc/mysql/mariadb.conf.d/99-legacy-sqlmode.cnf`. **Bez restartu** = žádný výpadek příjmu. Jeden fix místo úprav ~25 skriptů; předešel i pádu `table_month` k 1.7.
- **Backfill:** chybějící denní souhrny 14.+15.6. dopočítány z `table_min` (`E_str1=SUM(Vyroba)/12000` atd. — 5min vzorky × 5min/60000). Přesnost ověřena proti známému 13.6.: odchylka **0,2–0,5 %**. Žádná data se neztratila (`table_min` netknutý).
- **Pozn. do budoucna:** legacy solární kód předpokládá lenient MySQL — strict mód na MariaDB je třeba držet vypnutý (config výše), jinak tiše padají další INSERTy.

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

> **Update 2026-06-11 večer (Claude):** Na ivz1 už běží **nový statický web** kkevents.cz (zdroj `~/work/kkevents_web`, nasazeno do `/var/www/kkevents`, Caddy vhost `kkevents.cz, www.kkevents.cz` + log `/var/log/caddy/kkevents.log`; HTTP 308 ověřeno z venku, LE cert naskočí po DNS cutoveru — Phase 9). Public web už tedy na WPH-01 nezávisí.
>
> **Update 2026-06-11 pozdě večer:** Miloš prošel WPH-01 přes FTP — **`www` i `_log` jsou PRÁZDNÉ**, není co zálohovat. Premisa „web má obsah" už neplatí (Hukot soubory zřejmě smazal při suspendaci). Poslední šance na původní fotky/texty: ① zeptat se Hukot supportu, zda drží zálohu WPH-01 (soubory + DB), ② fotky od Kláry & Kristýny / jejich fotografů. Jinak Phase 8 = bezpředmětná, WPH-01 lze vypovědět hned po záloze e-mailové schránky (pokud existuje).

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

- [x] **icovazby.cz** A → ivz1 ✅ (cutover 2026-06-11 12:28; běží přes CF orange cloud, ověřeno 2026-06-13: `/healthz` + `/api/vr` + `/api/ds` + `/api/dd` všechny 200)
- [x] **simplesolar.cz** A+AAAA → `46.36.40.227` / `2a02:25b0:aaaa:2f27::` ✅ (cutover 2026-06-13/14; NS přesunuto na Cloudflare, šedý mráček, LE cert. Pozn.: cert naskočil až ~1h10m po cutoveru — Hukotí NS uzel dlouho vracel starou IP + zachytával ACME; vyřešilo se doběhem cache)
- [x] **mb-tenis.cz** A → `46.36.40.227` ✅ (ověřeno 2026-06-13: DNS ukazuje na ivz1, nový web „MB tenis" servíruje z `/var/www/mb-tenis/app/public`, apex 200)
- [x] **kkevents.cz** A → `46.36.40.227` ✅ (cutover 2026-06-11 večer: NS → Cloudflare, LE cert CN=kkevents.cz vydán 15:50 UTC, apex+www 200; resolver cache dobíhá ~1h)
- [x] **simplesolar.cz** Cloudflare Email Routing ✅ (zapnuto, MX `route1/2/3.mx.cloudflare.net` + SPF; `info@simplesolar.cz` → Seznam, testovací mail dorazil 2026-06-14)
  - [x] **Vyřešeno (rozhodnutí uživatele 2026-06-14):** (a) příchozí `info@` jde přes CF Routing → Seznam ✅. (b) **Bez Zoho** — odchozí „odesílat jako info@" v Gmailu se NEpoužívá; na poptávky se odpovídá ze Seznamu (kde mail chodí). Poptávkový formulář na webu posílá přes Seznam SMTP relay (From=`milos.pospisil@seznam.cz`, Reply-To=zákazník). User: smazat „odesílat jako info@" z Gmailu (Účty a import), ať to po zrušení Hukotu nehází chyby. (c) stará pošta z Hukot schránky — hostings zrušené, případnou archivaci řeší user.

---

## Phase 10 — WireGuard migrace z Hetzneru

- [x] Vygenerovat nový server key pair na `ivz1` — server pubkey: `pYouF8OkSrt23DJQqZ+lQa0WC8/N/rpSi2/RhNuvBXo=`
- [x] Vytvořit `/etc/wireguard/wg0.conf` (server) — stejná subnet 10.7.0.0/24 + IPv6 `fddd:2c4:2c4:2c4::/64`, port 51820, NAT MASQUERADE/SNAT na ens18, 3 peery zkopírovány z Hetzneru (thinkpad, mobil, macbookVPN)
- [x] `systemctl enable --now wg-quick@wg0`
- [x] Aktualizovat peer config na **desktopu** — vytvořen `/etc/wireguard/ivz1.conf`, `hetzner.conf` ponechán jako fallback; `wg-quick down hetzner && wg-quick up ivz1`
- [x] Aktualizovat `~/.ssh/known_hosts` (10.7.0.1 měl Hetzner SSH fingerprint, teď ivz1)
- [x] `systemctl enable wg-quick@ivz1` (auto-up po rebootu)
- [x] Test tunelu: `ssh root@10.7.0.1 hostname` → vrátí `ivz1` ✅
- [x] Aktualizovat peer config na **telefonu** (WireGuard app) ✅ (ověřeno 2026-06-14: peer `10.7.0.3`, handshake aktivní — telefon jede)
  - Peer's Public Key: → `pYouF8OkSrt23DJQqZ+lQa0WC8/N/rpSi2/RhNuvBXo=`
  - Endpoint: → `46.36.40.227:51820`
- [x] Aktualizovat peer config na **macbookVPN** — provedeno vzdáleně přes SSH ProxyJump (lokál → Hetzner public → macbook WG)
  - ⚠️ **PAST:** `/usr/local/bin/wg-quick` na macbooku není standardní wg-quick, ale **custom „Catalina WireGuard launcher"** skript napsaný ručně. Má hardkód `CONF="/usr/local/etc/wireguard/hetzner.conf"` a hardkód `route delete 178.104.160.124` v down sekci.
  - Workaround: fyzický `hetzner.conf` přepsán ivz1 settings (jméno legacy, obsah = ivz1). `wg-quick up hetzner` startuje ivz1 tunel.
  - **Symlink workaround (2026-06-11 odpoledne)**: `hetzner.conf` je symlink na `ivz1.conf`, takže `ivz1.conf` je jediný zdroj pravdy. Skript stále načítá přes legacy jméno.
  - **Pro čistý fix v budoucnu**: `brew reinstall wireguard-tools` selhal (wireguard-go checksum mismatch). Zkusit znovu po brew update, nebo manuálně stáhnout upstream wg-quick.
  - **Recovery při zlomení**: `sudo cp /usr/local/bin/wg-quick.hacked.bak /usr/local/bin/wg-quick && sudo wg-quick up hetzner`
  - **✅ Auto-restart fix (2026-06-14):** macbook WG tiše padal — `wireguard-go` proces umřel (spánek / změna sítě) a starý launchd `com.wireguard.hetzner` jen bootoval (`wg-hetzner-start.sh`), žádná průběžná obnova. Nasazen **launchd watchdog `com.wireguard.ivz1`** (`/Library/LaunchDaemons/com.wireguard.ivz1.plist`, skript `/usr/local/bin/wg-watchdog.sh`): `RunAtLoad` + `StartInterval 60` — když je utun10 dole nebo handshake > 180 s, udělá `wg-quick down/up`. Starý `com.wireguard.hetzner` vypnut (plist → `.disabled`). `PersistentKeepalive 25` už launcher nastavoval sám. Mac dosažitelný z desktopu přes **LAN `milospospisil@192.168.1.109`** (SSH klíč, passwordless sudo); WG endpoint v `ivz1.conf` byl správný (46.36.40.227), jen tunel nejel. Log watchdogu: `/var/log/wg-watchdog.log` na Macu.
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

## Phase 11 — ha1.pp.ua + Home Assistant ekosystém ✅

- [x] ha1.pp.ua: zóna v Cloudflare, `ssh.ha1.pp.ua` CNAME na CF Tunnel UUID (`d6e2fa43-...`) — funguje
- [x] HA web access ověřen: primární cesta = **`ha.mb-tenis.cz` přes CF Tunnel** (CF orange, cloudflared add-on v HA)
- [x] Sekundární cesta: `mpcz.duckdns.org:8123` — DNS sice resolves na home IP, ale port forward na home routeru **NEexistuje** (timeout z venku na všech portech 80/443/8123/22). DDNS je pouze update DNS záznamu, ale router nepropouští. Bezpečnostně dobré.
- [x] **Tailscale na Hetzneru = nepoužívaný** — analýza ukázala 0 established connections na port 443 za 15 s, většina iptables counter byly SYN flood od scanneru
- [x] **Rozhodnutí:** Tailscale NE-migrovat na ivz1, vyhyne s Hetzner cleanupem (Phase 13)
- [x] User: HA UI → External URL změněno na `https://ha.mb-tenis.cz` *(hotovo, potvrzeno 2026-06-14)*
- [x] User: HA → odinstalován Tailscale add-on (leftover z testování) *(hotovo, potvrzeno 2026-06-14)*
- [x] Port forward 8123 v home routeru → **NEEXISTUJE** (ověřeno, žádná akce nutná)

---

## Phase 12 — Verifikace + 7 dní paralelního provozu

- [x] `icovazby.cz` z nové IP odpovídá s plnou funkcionalitou *(ověřeno 2026-06-13)*
  - [x] `/healthz` 200 *(pozor: endpoint je `/healthz`, ne `/api/health` — to vrací 404)*
  - [x] `/api/dd/26185610` plný profil (200)
  - [x] `/api/vr/26185610` 200 s daty (NE `vr_blocked`!) — AGROFERT JSON, latence ~130 ms
  - [x] `/api/ds/26185610` 200 s DS ID
  - [ ] AI souhrn funguje (BYO klíč)
  - [ ] PDF prověrka generuje se
  - [ ] Bulk DD ZIP test
- [x] `simplesolar.cz` odpovídá *(cutover 2026-06-13, live z ivz1, LE cert, Moje FVE + mobilní app + formulář ověřeny)*
- [ ] `mb-tenis.cz` odpovídá
- [ ] `kkevents.cz` placeholder
- [x] Email forward funguje (CF Email Routing → Seznam, otestováno)
- [x] WG tunel desktop ↔ `ivz1` funguje *(používán průběžně; Mac watchdog dořešen)*
- [ ] **Monitoring 7 dní:**
  - [ ] `free -h` hourly screenshot v `journalctl`
  - [ ] `iostat -x 10` během Bulk DD
  - [x] UptimeRobot ping na `icovazby.cz` *(nastaveno, potvrzeno 2026-06-14)*
  - [ ] Sledovat OOM v `dmesg`
  - [ ] Sledovat I/O latence (SSD propad na 0 MB/s je známý risk)

---

## Phase 13 — Vypnutí starých služeb

### Hetzner ✅ (2026-06-11 odpoledne)

- [x] **Hetzner backup:** persons-index.sqlite (93 MB) + .env + wg0.conf + 9 systemd units → `~/backups/hetzner-final-2026-06-11/`
- [x] Smoke test ivz1 (žádná závislost na Hetzneru, žádný `178.104.160.124` v configu)
- [x] **Fix CF SSL/TLS mode** z `Flexible` na `Full (strict)` — Flexible vytvořila 308 smyčku (CF↔origin přes HTTP, Caddy auto-redirect na HTTPS)
- [x] **Hetzner VPS smazán** v Hetzner Cloud Console
- [x] Ověřeno: `178.104.160.124` 100 % packet loss, SSH timeout — IP vrácena do poolu

### 3 Hukot hostings (čeká po dokončení Phase 6-8)

- [x] **Email výpověď WH-01 mb-tenis** *(posláno)*
- [x] **Email výpověď WH-03 simplesolar** *(posláno)*
- [x] **Email výpověď WPH-01 kkevents** *(posláno)*
- [x] **Hostings zrušené** *(potvrzeno uživatelem 2026-06-14)*
- [ ] Počkat na potvrzení Hukotu + připsání kreditu (souhrnně ~700–1 200 Kč) — *pasivně sledovat*

---

## Phase 14 — Cleanup + dokumentace

- [x] Memory: žádný `reference_hetzner_vpn.md` soubor neexistoval (moot). Aktuální projektová memory = `simplesolar-migrace-redesign.md` (udržovaná průběžně).
- [x] README: root `README.md` bez Hetzner/starých-IP referencí (ověřeno grepem). `deploy/README.md` + `deploy/install.sh` dostaly banner „aktuální produkce = Hukot VPS ivz1 (46.36.40.227)" + odkaz na tento dokument (2026-06-14).
- [x] **Offsite backup DB → Google Drive** ✅ (2026-06-14; místo R2 použit existující rclone GDrive remote). Pattern pro **db_monitoring** (solár) i **persons-index** (icovazby): ivz1 systemd timer noční záloha (`/usr/local/bin/{simplesolar,icovazby}-db-backup.sh`, `*-backup.timer` 02:30/02:45, lokálně 30 dní) → desktop cron 9:15 (`/home/milos/work/simplesolar/backups/offsite-backup.sh`) stáhne přes rsync + `rclone copy` na `GoogleDrive:backups/{simplesolar,icovazby}/` (rotace 14 dní). persons-index přes bezpečný sqlite3 `.backup` (WAL DB). Data tedy na 3 místech (ivz1 + desktop + GDrive).
- [x] `deploy/redeploy.sh` — žádná změna nutná, už cílí na `root@10.7.0.1` (WG IP ivz1).
- [ ] **`.env.example`** — odstranit `VR_PROXY_URL` + `VR_PROXY_TOKEN`. ⚠️ MUSÍ UDĚLAT USER RUČNĚ — Claude má deny pravidlo na čtení/zápis `**/.env.*` souborů, takže k `.env.example` nemá přístup.
- [x] **Bezpečnostní postup** (kdo má co):
  - SSH na ivz1: klíč `~/.ssh/` na desktopu (milos), root login přes WG IP `10.7.0.1` nebo veřejně `46.36.40.227`.
  - WG peery: desktop (`10.7.0.2`), telefon, externí osoba read-only Adminer (`10.7.0.5`, AllowedIPs jen `10.7.0.1/32`, UFW restrikce). Server pubkey `pYouF8OkSrt23DJQqZ+lQa0WC8/N/rpSi2/RhNuvBXo=`, endpoint `:51820`.
  - Seznam SMTP heslo (relay pro poptávkový formulář) v `/etc/postfix/sasl_passwd` na ivz1 (root, chmod 600).
  - Cloudflare účet (DNS + Email Routing) = osobní účet uživatele. Recovery codes: u uživatele.
  - DB hesla: `db_monitoring` (heslo NENÍ v repu — viz `~/Stažené/dulezite/`, rotováno 2026-07-22), v `inc/fve.php` + `startscript.php` na ivz1.

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
**Datum dokončení Phase 11 (HA + Tailscale):** 2026-06-11 15:30 CEST  
**Datum vypnutí Hetzneru:** 2026-06-11 15:48 CEST  
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

### E3. ✅ HOTOVO — Offsite backup DB na Google Drive (2026-06-14)

Realizováno přes **Google Drive** (existující rclone remote) místo R2 — viz Phase 14. Pokrývá `persons-index.sqlite` (icovazby) i `db_monitoring` (solár). Bezpečný sqlite3 `.backup`, ivz1 systemd timer + desktop cron → `rclone copy` na GDrive, rotace 14 dní.

**Termín:** Před vypnutím Hetzneru (Phase 13).

### E4. ✅ HOTOVO — UptimeRobot ping na nový endpoint (2026-06-14)

HTTPS check `https://icovazby.cz/` přidán na UptimeRobot (potvrzeno uživatelem).
