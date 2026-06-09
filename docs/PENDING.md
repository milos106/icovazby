# Pending integrations

Funkce, jejichž **kód je hotový**, ale jsou skryté z UI dokud nedorazí
externí přístup / partnership. Tento dokument je TODO seznam pro
re-aktivaci jakmile přístup přijde.

---

## F6 — Ochranné známky (TMView)

**Status:** UI skryté, code v `src/tmview/` zachovaný.

**Co je hotové:**
- `src/tmview/client.ts` — cookie jar + session refresh + searchTrademarks
- `src/tmview/service.ts` — applicant filtering + per-office sort + attribution
- `GET /api/trademarks/:ico` endpoint (vrací 503 UPSTREAM_BLOCKED)
- UI karta `dd-upv` v `public/index.html` (`x-show="false"`)
- Alpine `ddTrademarksLoader` v `public/js/app.js`

**Proč je skryté:**

| Cesta | Problem |
|---|---|
| TMView server-side fetch | F5 bot detection blokuje data-center IP (Hetzner → ECONNRESET) |
| TMView browser direct fetch | CORS — tmdn.org neobsluhuje preflight pro cross-origin |
| ÚPV ISDV scraping | `robots.txt` Disallow: /  → explicitně zakázáno |
| ÚPV data.gov.cz | Trademark register tam není (jen úřední deska) |

**Reálná cesta vpřed (aktivní):**

1. **EUIPO Cobranding partnership** — email odeslán `information@euipo.europa.eu`
   + Cc `euipn@euipo.europa.eu` dne 2026-06-09.
   Očekávaná odpověď: 1–2 týdny.
   Cíl: OAuth2 token, `client_id` / `client_secret`.

2. **ÚPV bulk export** — email odeslán `info@upv.gov.cz` + Cc `posta@upv.gov.cz`
   dne 2026-06-09. Očekávaná odpověď: 2–4 týdny.
   Cíl: XML / CSV dump licencovaný pro re-distribuci.

### Jak re-aktivovat až přijde EUIPO token

1. **Doplnit OAuth2 do `src/tmview/client.ts`:**
   ```ts
   const accessToken = await getOAuth2Token(
     process.env.TMVIEW_CLIENT_ID!,
     process.env.TMVIEW_CLIENT_SECRET!,
   );
   // Místo cookie jar:
   headers: { Authorization: `Bearer ${accessToken}` }
   ```

2. **Server endpoint** v `src/server.ts` `/api/trademarks/:ico`:
   - Smazat 503 fallback
   - Odkomentovat `const data = await cached(...)`

3. **UI v `public/index.html`:**
   - Odstranit `x-show="false"` z `<div id="dd-upv">`
   - Vrátit původní `x-show="$store.sections.visible('dd-upv')"`
   - Přidat `x-data="ddTrademarksLoader()" x-init="load(report.ico)"`
   - Vrátit kompletní rendering (table s trademarks)

4. **Settings v `public/js/app.js`:**
   - Odkomentovat řádek v `SECTION_DEFS`:
     `{ key: "dd-upv", label: "™ Ochranné známky (TMView)", group: "Profil firmy" }`

5. **Server `.env`:**
   ```
   TMVIEW_CLIENT_ID=...
   TMVIEW_CLIENT_SECRET=...
   ```

6. **README:** přidat sekci o TMview do Datové zdroje + atribut „TMview / EUIPN, Cobranding partner #X".

### Jak re-aktivovat až přijde ÚPV bulk

Pokud přijde ÚPV jako první, varianta self-hosted:

1. Nový modul `src/upv/` (paralelně k tmview):
   - `scripts/sync_upv.mjs` — denní cron stahne XML, parse, uloží do SQLite
   - `src/upv/store.ts` — lookup po IČO majitele přes SQLite
2. Endpoint `GET /api/upv-trademarks/:ico` (separátní od /api/trademarks).
3. UI: stejné `dd-upv` card, jen swap data source z TMView na ÚPV-local.

Obě cesty mohou koexistovat (lokální CZ data + EU/WIPO přes TMView API).

---

## R9 — CEDR (MFČR Monitor SOAP)

**Status:** ODLOŽENO — duplicita s Hlídač státu (derivát).

CEDR primary API je SOAP `monitor.statnipokladna.gov.cz/api/monitorws` operation `ExtractData`. Vyžaduje complex XSD schema pro request, vrací bulk XML pro celé datasety (ne per-IČO query). 6-8h práce na full implementaci.

**Marginální hodnota:** Hlídač státu už používáme pro dotace přes `/api/v2/dotace/hledat?dotaz=ico%3A{IČO}`. HS je derivátem CEDR, pokrývá ~95 % případů.

CEDR by stálo za to integrovat jen pokud klienti budou požadovat audit-grade autoritativní zdroj (banky AML).

## R10 — ISIR plný XML feed (SOAP)

**Status:** ODLOŽENO — duplicita s Hlídač státu.

ISIR SOAP service `isir.justice.cz:8443/isir_public_ws/IsirWsPublicService` má diff polling pattern (100 events/request, `idPodnetu` increment). 6-8h plné implementace.

**Marginální hodnota:** Hlídač státu `/api/v2/insolvence/hledat?dotaz=icodluznik%3A{IČO}` pokrývá běžný DD use case s minutovou latencí proti přímému feedu.

Direct ISIR feed by se vyplatil pro real-time monitor dashboard (např. "dnes podáno X nových insolvencí"), ne pro per-IČO lookup.

## R12 — Bulk DD ZIP s PDF prověrkami

**Status:** ODLOŽENO — vyžaduje Puppeteer (200+ MB native deps).

Současný Bulk DD vrací CSV summary + linky na PDF per row. Plné ZIP s PDF reporty vyžaduje:
- Puppeteer/Playwright nainstalovaný (200 MB Chromium)
- Server-side HTML → PDF rendering paralelně
- ZIP stream s 50 PDF binaries

Pro production self-hosted single-instance Hetzner CX22 by Puppeteer eat 30-50 % RAM. Lepší cesta = klient-side bulk: user otevře 50 `/report/:ico` tabs a uloží jako PDF (browser auto-print). Současný workflow je dostačující pro většinu use case.

## R14 — User accounts + multi-tenant

**Status:** ČEKÁ na B2B validation (pre-validation viz cesta C diskuze).

Big lift (~12h) bez validovaného komerčního zájmu. Implementace plán:
- SQLite tabulka users (email, bcrypt password_hash, created_at)
- Fastify session cookies
- Per-user persons_index scoping (nebo team-shared rozhodnutí)
- Signup/login/password reset flow

Doporučeno: počkat na 3-5 podepsaných „bych platil za to" leadů z LinkedIn outreach před prací.

## R15 — API pro 3rd party

**Status:** DEPENDS ON R14.

Bearer token auth, OpenAPI/Swagger spec, scoped endpoints. Závisí na user accounts.

## R20 — EN translation (i18n)

**Status:** ODLOŽENO — čeká na CZ market validation.

i18n framework setup ~30 min, ale plný EN překlad UI ~10h. Otevírá mezinárodní use case ale CZ user base je primární.

Doporučeno: nejdřív CZ market traction (paying users, positive feedback), pak EN expand.

## R4 — Hlídač státu person enrichment

**Status:** BLOCKED — HS API neumožňuje lookup bez DOB.

Endpoint `/api/v2/osoby/hledat` vyžaduje jako povinný parametr `DatumNarozeni`. Bez něj vrátí 400. Žádný alternativní endpoint pro firm → persons reverse lookup neexistuje.

Pro tentative osoby (bez DOB v ARES VR) nemáme cestu jak DOB doplnit z HS. Reálné možnosti:
1. **EUIPO Cobranding partnership** (pendingr) — má v některých případech DOB pro PEP
2. **Bulk export HS osob** — vyžaduje partnership (email `hlidacstatu@hlidacstatu.cz`)
3. **Manuální curation** — admin UI pro doplnění DOB k VIP firmám

## R2 — Sentry + UptimeRobot + B2 backup

**Status:** ČÁSTEČNĚ — GitHub Actions test workflow hotov.

Zbylé části vyžadují registraci u externích služeb:
- **Sentry** (free tier 5k events) — registrace na sentry.io → DSN do `.env` jako `SENTRY_DSN`
- **UptimeRobot** (free 50 monitorů) — registrace → ping `https://icovazby.cz/healthz` každých 5 min
- **Backblaze B2** (10 GB free) — registrace → API key → daily cron rsync persons-index.sqlite

Až budeš mít účty, pošli mi tokeny do `.env` na serveru a SDK integrace je 30 min každá.

## R8 — Aktivní občan / Lobby registr (RELOB)

**Status:** BLOCKED — žádné public API.

Zjištění z research 2026-06-09:
- relob.gov.cz je Nuxt SPA, žádné REST endpointy
- data.gov.cz nemá dataset „lobbování"
- Web UI vyhledávání po IČO funguje, programatický přístup ne

**Cesta vpřed:** email `relob@msp.gov.cz` s žádostí o data export. Nebo počkat na NKOD publikaci.

## R18 — Demo video

**Status:** SKIP — vyžaduje user manual akce (screencast s mikrofonem). Plánováno jakmile bude EUIPO partnership.

## Možné další features čekající

Žádné aktuálně. F4 (Katastr) a F1–F8 dokončené nebo dokumentované.
