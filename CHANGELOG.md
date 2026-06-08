# Changelog

Všechny významné změny v tomto projektu jsou zaznamenány zde.

Formát vychází z [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), verzování podle [SemVer](https://semver.org/).

## [0.4.0] — 2026-06-08

### Added

- **Deep preseed**: server při bootu projíždí top-cz-companies.json (~520 firem)
  a stahuje jejich jednatele z ARES VR do persons_index. Holding discovery
  pak najde rodinné struktury i bez user history. Vypnutí: `PRESEED_DEEP=0`.
- **Bootstrap inventory dump** (16 660 firem + 6 624 jednatelů): generovaný
  jednorázově lokálním harvest skriptem (`/tmp/harvest_50k.mjs` +
  `/tmp/harvest_deep.mjs`), nahrán na server jako `data/persons-index.json`.
  Pokrývá ~95 % známých velkých českých holdingových struktur.
- **Auto-detect OSVČ jednatelů** (`enrichJednateleOsvc()`): při DD na firmu
  (PD MONT s.r.o.) projde jednatele a pro každého zkusí najít jeho OSVČ
  záznam přes ARES search by jméno + filtr pravniForma 107/108 + match DOB.
  Pak holding discovery najde i OSVČ jako dceřinky (PD MONT → Dubický OSVČ).
- **includeHistorical v holding discovery**: nový parameter (default false)
  pro `discoverHolding()`. UI checkbox v sekci 🔍 Rozkrýt holding. Synced
  s checkboxem v Mapě propojení přes globální Alpine store (`$store.history`).
- **Loading spinner** v holding discovery — visual cue že discovery běží
  na pozadí (5-15 s).
- **Global history toggle** přes Alpine.store(„history"): jeden binární
  flag řídí jak discovery (Profil), tak render (Mapa). Zaškrtnutí kdekoli
  propaguje se do druhého místa automaticky.

### Changed

- **ARES VR endpoint pro akcionáře**: holding discovery reverse scan teď
  získává akcionáře z ARES VR `/ekonomicke-subjekty-vr/:ico` (authoritativní,
  vždy odpovídá) místo VR portal `/api/rejstriky/detail/:ico` (v ověřovacím
  provozu, často vrací `{message: error}` např. pro ZZN Polabí).
- **Reverse scan cap**: z 200 firem na **5 000** (= projíždí celý seed
  bootstrap). Zpomalí discovery o ~30 s ale zvýší pokrytí.
- **UI redesign Profil sekce „Rozkrýt holding"**: 3-řádkový layout
  (akce → volby → status) místo jednoho přeplněného flex řádku.
- **Žádné auto-scroll skoky** (`scrollIntoView` odstraněno ze všech sekcí).
  Stránka zůstává tam, kde je.
- **Mapa propojení checkbox přejmenován** „Zobrazit historické vazby"
  (Profil checkbox: „Hledat i historické vazby") — odhalují různé sémantiky.
- **Search fallback**: pokud ARES nenajde firmu pro neúplné jméno (`agrofer`),
  postupné krácení query (`agrofer → agrofe → agrof → agro`); pokud i to
  selže, lokální subjects inventory substring match. Notice v UI.
- **OSVČ false-positive risk**: právní forma 107/108 už nedostává žluté
  riziko za chybějící statutární orgán (ze zákona ho mít nemůžou).
- **Aktivních osob count** v Mapě propojení: deduplikováno přes personKey
  (dříve 32 raw rows vs 26 unikátních osob).

### Fixed

- **Mapa propojení reset** při novém profilu (předtím kumulovala IČO mezi
  vyhledáními: PD MONT pak SimpleSolar → 2 holdingy v jednom grafu).
- **Mermaid graf v dark mode** má tmavý kontejner (předtím bílé pozadí).
- **localStorage key migrace** `ares-web:*` → `icovazby:*` (automatická
  migrace v <head>, existující uživatelé nepřijdou o nastavení).
- **Personal key normalizace** — diakritika v jednatel jménech (Jedlička vs
  Jedlicka) způsobovala dva oddělené klíče v persons_index. Harvest skript
  teď používá stejný NFD strip jako server.

### Infrastructure

- **DNS přes Cloudflare** (icovazby.cz) — bypass Hetzner upstream 443
  filtru. Flexible TLS mode (CF→server přes HTTP/80).
- **Always Use HTTPS** v CF — automatický redirect HTTP→HTTPS.
- **Static cache snížen** na 5 min (z 24 h) pro rychlejší propagaci JS změn.
- **Resolver fix**: instrukce pro lokální DNS (`resolvectl dns ... 1.1.1.1`)
  pro testování během DNS propagace u registrátora.

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
