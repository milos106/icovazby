# Changelog

Všechny významné změny v tomto projektu jsou zaznamenány zde.

Formát vychází z [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), verzování podle [SemVer](https://semver.org/).

## [0.3.0] — 2026-06-08

První veřejný OSS release pod AGPL-3.0.

### Added
- **PDF prověrka** (`GET /report/:ico`) — printable HTML s auto-print pro deliverable.
- **Demo route** (`GET /demo/:ico`) — pre-cached snapshoty pro IČO 26185610 (Agrofert) + 45274649 (ČEZ), bez nutnosti HS tokenu.
- **E-mail alerty** — subscribe (`POST /api/alerts/subscribe`), verify (`GET /api/alerts/verify/:token`), unsubscribe (`DELETE /api/alerts/:id`). Periodicky kontroluje změny statutárního orgánu, insolvence a zánik subjektu, posílá e-mail při změně. SMTP volitelné (Nodemailer); bez konfigurace mailer loguje.
- **LRU cache** (`src/cache.ts`) — 5000 entries × 24h TTL pro `/api/dd` a `/api/vr`. Druhý request ~10× rychlejší.
- **p-limit(3)** kolem ARES/VR calls v holding discovery — chrání před banem.
- **Scoped rate limit** (10/min) pro `/api/holding/discover` a `/api/cross-persons` (multiplier endpointy).
- **AGPL §13 footer** v UI s odkazem na zdrojový kód a licenci.
- **X-Powered-By** header s identifikací buildu (důkazní materiál při sporu).
- **Canary string** v `src/cache.ts` — marker pro detekci uzavřených forků.
- **Deploy script** `deploy/install.sh` + `deploy/README.md` pro Hetzner CX.
- **OSS dokumentace**: `LICENSE` (AGPL-3.0 plný text), `README.md` (rewrite), `CONTRIBUTING.md`, `SECURITY.md`, `CHANGELOG.md`.
- **SPDX hlavičky** ve všech TS souborech.

### Fixed
- OSVČ (právní forma 107/108) už nedostává žluté riziko za chybějící statutární orgán ve VR (false-positive).
- Aktivních osob count v Mapě propojení deduplikováno (32 → 26 unikátních osob).
- Mermaid graf má v dark mode tmavý kontejner místo bílého overlay.
- H3 firmy přepnut z `text-2xl bold` na `text-3xl semibold` (lepší hierarchie).
- KBD hint v search input platform-aware (`⌘` na Mac, `Ctrl` jinde).
- Sticky sidebar `top-20` → `top-24` (nepřekrývá zalomený header).
- Mobile horizontal nav `top-16` → `top-[7.5rem]` (pod headerem správně).
- Mobile header z 115 px na 59 px (logo zmenšeno, podtitul skrytý <sm).
- CZ-NACE „+ N dalších" má tooltip se seznamem dalších kódů.

### Security
- HTTPS via Let's Encrypt + auto-renew.
- nginx security headers: HSTS, X-Content-Type-Options, Permissions-Policy, Referrer-Policy.
- systemd sandboxing (`ProtectSystem=strict`, `ProtectHome=true`, `NoNewPrivileges`).
- Memory cap 1 GB → OOM-kill jen icovazby, ne celý server.
- `.env` v `.gitignore`, žádné tokeny v repu.

## [0.2.0] — pre-OSS

Vnitřní fáze — sloučení Profil firmy do jedné karty, scroll-spy, chevron rotation, Cmd+K, Inter font, dark mode, vazby osoby, holding discovery, OR portal integrace (VR via verejnerejstriky.msp.gov.cz), per-user HS token, lokální index osoba→firmy, EU sankce přímý FSF feed, ČNB JERRS, ADIS DPH, ISIR, UBO + dotace + smlouvy přes Hlídač státu.

## [0.1.0] — Vnitřní MVP

Fastify backend + vanilla HTML frontend, ARES core integrace, vyhledávání podle IČO/názvu, profil firmy, hloubková prověrka, mapa propojení přes statutáry, hledání na adrese, export do fakturačních systémů (Fakturoid/iDoklad/Pohoda), localStorage historie + oblíbené, shareable URL.
