# IČO vazby

> **Webová prověrka českých firem a jejich propojení.** Otevřený softwarový balík, který agreguje 10+ veřejných českých registrů (ARES, OR, RŽP, ADIS DPH, ISIR, ČNB JERRS, EU sankce, Hlídač státu) do jednoho průchodu: identifikace + 🟢🟡🔴 risk skóre + holding discovery + cross-company person graph + e-mail alerty + PDF prověrka.
>
> **Self-hosted, AGPL-3.0.** Žádný cloud, žádné login. Spustíš si vlastní instanci nebo přispěješ kódem.

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)
[![Node 20+](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org/)

⚠ **AS IS, bez záruky.** Aplikace agreguje veřejná data — pro právně závazné rozhodnutí ověřuj v primárních zdrojích. Maintainer nenese odpovědnost za rozhodnutí na základě výstupů.

---

## Co umí

| Sekce | Co dělá |
|---|---|
| **🛡️ Profil firmy** | IČO nebo název → 🟢🟡🔴 risk badge + findings + identifikace + DPH + jednatelé + OR + UBO + dotace + smlouvy + sankce + insolvence + JERRS + živnosti. Rozbalovací karty s persistovaným stavem. |
| **🔍 Rozkrýt holding** | Auto-trigger pro a.s./s.r.o. — BFS po sdílených jednatelech + akcionářích z OR portálu. Najde subsidiaries i přes 2. úroveň. |
| **🌐 Mapa propojení** | 2–50 IČO → osoby ve více firmách + Mermaid graf. Volitelně historické vazby (nominee detection). |
| **🔗 Vazby osoby** | Klik na jednatele → všechny jeho firmy (z lokálního indexu osoba→firmy budovaného postupně). |
| **🏢 Hledat na adrese** | Detekce virtuálních kanceláří (>50 firem = ⚠️, >500 = 🚨). |
| **📄 PDF prověrka** | `/report/:ico` → printable HTML s auto-print, uložíš jako PDF deliverable. |
| **🔔 E-mail alerty** | Subscribe pro periodickou kontrolu změn statutára / insolvence / zániku. |
| **🚀 Demo route** | `/demo/26185610` a `/demo/45274649` — bez tokenu, pre-cached, pro landing. |
| **Export do fakturace** | Fakturoid / iDoklad / Pohoda JSON. |
| **Historie + oblíbené** | LocalStorage, žádný backend. Shareable `?ico=…` URL. |
| **Tmavý režim** | System-aware + manuální toggle, persistentní. |

## Stack

- **Backend:** Fastify (TS), zod, undici, p-retry, p-limit, lru-cache, nodemailer — žádná databáze (kromě JSON souboru pro subscribers).
- **Frontend:** vanilla HTML + Tailwind CDN + Alpine.js + Mermaid 11 + Inter font — bez build stepu.
- **Data:** veřejná REST API českých registrů. Žádný proxy, žádné scraping, žádný AI vrstva.

## Spuštění lokálně

```sh
git clone https://github.com/<your>/icovazby.git
cd icovazby
npm install
cp .env.example .env
# vyplň HLIDAC_API_TOKEN (volitelně) v .env
npm run build
npm start
```

Otevři **http://127.0.0.1:3000**.

Hot reload pro vývoj: `npm run dev`.

## Konfigurace (env)

| Variable | Default | Popis |
|---|---|---|
| `PORT` | `3000` | Listen port |
| `HOST` | `127.0.0.1` | Bind. Pro LAN nastav `0.0.0.0`. |
| `RATE_LIMIT_PER_MIN` | `60` | Per-IP HTTP rate limit |
| `RATE_LIMIT_HEAVY_PER_MIN` | `10` | Limit pro `/api/holding/discover` + `/api/cross-persons` (multiplier endpoints) |
| `DD_CACHE_TTL_MS` | `86400000` | LRU cache TTL pro DD a VR (24h) |
| `HOLDING_CONCURRENCY` | `3` | Souběžné upstream calls v holding discovery |
| `ARES_RATE_PER_SECOND` | `5` | Token bucket pro ARES upstream. Drž ≤ 8. |
| `ARES_TIMEOUT_MS` | `15000` | Timeout ARES requestu |
| `ARES_RETRIES` | `3` | Retry budget |
| `HLIDAC_API_TOKEN` | _(volitelný)_ | Bez něj se HS sekce neukážou. Vlastní si vyřídíš na hlidacstatu.cz/api. |
| `SMTP_HOST` / `SMTP_USER` / `SMTP_PASS` | _(volitelné)_ | Bez nich alerts mailer jen loguje do konzole. |
| `ALERTS_CHECK_MIN` | `360` | Interval kontroly subscriptions v minutách (6h) |
| `LOG_LEVEL` | `info` | Pino log level |

## Architektura ve velkém

```
┌─────────────┐   HTTP    ┌────────────────────────────────────┐
│   Browser   │ ────────▶ │  Fastify (src/server.ts)           │
│  Alpine.js  │           │  ├── rate-limit (per-IP, scoped)   │
└─────────────┘           │  ├── LRU cache (24h pro DD/VR)     │
                          │  └── per-request HS token (ALS)    │
                          └──┬───────┬───────┬─────────┬───────┘
                             │       │       │         │
                          ┌──▼──┐ ┌──▼──┐ ┌──▼──┐  ┌───▼────┐
                          │ARES │ │ VR  │ │ HS  │  │ ADIS / │
                          │MFČR │ │MSp  │ │tkn  │  │ČNB/EU  │
                          └─────┘ └─────┘ └─────┘  └────────┘
```

- **`src/services.ts`** — pure business logic, framework-free.
- **`src/holding/discover.ts`** — BFS po grafu firma→firma, dva typy hran.
- **`src/graph/crossCompanyPersons.ts`** — Mermaid graph builder.
- **`src/persons_index/store.ts`** — lokální cache osoba→firmy + subjekty inventář.
- **`src/alerts/`** — subscribe → diff snapshot → SMTP.
- **`src/report/html.ts`** — printable HTML pro PDF export.
- **`src/cache.ts`** — LRU dekorátor.

## REST API (vybrané)

| Endpoint | Co dělá |
|---|---|
| `GET /healthz` | Liveness + cache stats + integration flags |
| `GET /api/dd/:ico` | Plný DD report (24h cache) |
| `GET /api/vr/:ico` | Detail OR (24h cache) |
| `GET /report/:ico` | **Printable HTML report pro PDF** |
| `GET /demo/:ico` | **Demo bez tokenu** (jen pre-selected IČO) |
| `POST /api/holding/discover` | Body: `{ ico, depth?, maxIcos? }` → subsidiaries |
| `POST /api/cross-persons` | Body: `{ icos[], includeHistorical? }` → osoby + Mermaid |
| `POST /api/alerts/subscribe` | Body: `{ email, ico }` → potvrzovací e-mail |
| `GET /api/alerts/verify/:token` | Aktivace odběru |
| `DELETE /api/alerts/:id` | Unsubscribe |

Detailní seznam: `grep "app\\.\\(get\\|post\\|delete\\)" src/server.ts`.

## Datové zdroje a licence

| Zdroj | Licence | Komerční | Atribuce |
|---|---|---|---|
| **ARES** (MFČR) | CC BY 4.0 | ✅ | „Source: ARES, MFČR" |
| **Veřejný rejstřík (OR)** | Z. č. 304/2013 Sb. | ✅ | „Source: VR, MSp ČR" |
| **ADIS** | § 96a z. o DPH | ✅ | „Source: MFČR ADIS" |
| **Hlídač státu** | CC BY 3.0 CZ | ✅ s atribucí | ⚠ Funkční odkaz na hlidacstatu.cz povinný |
| **ISIR** | § 419 z. č. 182/2006 Sb. | ✅ pod limitem | „Source: ISIR / MSp ČR" |
| **ČNB JERRS / kurzy** | nař. vlády 425/2016 Sb. | ✅ | „Source: ČNB" |
| **EU Consolidated Sanctions** | Commission Decision 2011/833/EU | ✅ | „Source: EU Commission" |

Aplikace všechny atribuce vykresluje automaticky v patičce + u příslušných sekcí.

## GDPR

Výstupy obsahují osobní údaje (jména, data narození jednatelů), publikované veřejně podle čl. 6(1)(e) GDPR. **Pokud výsledky ukládáš nebo dále zpracováváš, stáváš se správcem osobních údajů** a máš vlastní povinnosti (privacy policy, právní základ, práva subjektů údajů, doba uchování).

Tento software:
- **Neloggue request body.**
- **Necachuje výsledky DD** v perzistentním úložišti (jen in-memory LRU, vyprší po 24h, padne s restartem procesu).
- **Ukládá** pouze e-mail subscribers (pokud používáš alerty) do `data/subscriptions.json`. Subscriber má právo na výmaz přes `DELETE /api/alerts/:id`.

## Trademark / brand policy

Název **„IČO vazby"**, logo a doména `icovazby.cz` jsou veřejně používány autorem od r. 2026 jako brand projektu. Můžete forknout kód a provozovat vlastní instanci pod AGPL-3.0 podmínkami, ale **NESMÍTE** používat název „IČO vazby" ani matoucí varianty (např. „ICO vazby", „IČOvazby", „IcoVazby") pro odvozenou službu, která by mohla být zaměňována s touto. Pro fork zvolte vlastní název (např. „RegistryCheck CZ", „FirmaScan"). Práva k brandu jsou nezávislá na AGPL právech ke zdrojovému kódu — chráněna § 425 a § 2976 obč. zák. (ochrana názvu, nekalá soutěž) i bez formální ochranné známky.

## Licence kódu — AGPL-3.0

Tento projekt je licencován pod **GNU Affero General Public License v3.0 or later** ([LICENSE](./LICENSE)).

**Co to znamená:**
- ✅ Můžeš použít, modifikovat, distribuovat zdarma.
- ✅ Můžeš nasadit jako vnitrofiremní nástroj.
- ⚠ **Pokud nabízíš modifikovanou verzi jako webovou službu třetím stranám, musíš publikovat zdrojový kód tvých úprav** (AGPL SaaS klauzule).
- ⚠ Odvozené dílo musí být také AGPL-3.0.

**Komerční licence:** držitel autorských práv (původní autor) může poskytnout alternativní (uzavřenou) licenci za poplatek. Kontakt: viz `SECURITY.md`.

Licence dat (CC BY 4.0 ARES, CC BY 3.0 HS, …) jsou **nezávislé** na licenci kódu.

## Acceptable use upstream API

| Zdroj | Limit | Naše ochrana |
|---|---|---|
| ARES | 500/min na uživatele (MFČR) | `ARES_RATE_PER_SECOND=5` (= 300/min) + LRU cache |
| Hlídač státu | per-token (uživatel si vyřídí) | per-request token přes `X-Hlidac-Token` header |
| VR portál (justice) | bez explicitního limitu | `HOLDING_CONCURRENCY=3` + LRU cache |
| ISIR | 3000/den, 50/min | Cache + p-retry |

Pokud nasadíš veřejně, **doporučujeme za reverse proxy s vlastním WAF** (Cloudflare free tier postačí).

## Testy

```sh
npm test                              # vitest, mock klient
node tests/e2e.playwright.mjs         # E2E proti běžícímu serveru
```

## Contribute

Viz [CONTRIBUTING.md](./CONTRIBUTING.md).

## Security

Pro odhalené zranitelnosti viz [SECURITY.md](./SECURITY.md).

## Status

**`v0.4`** — Holding discovery rozšířen:

- Deep preseed při bootu — ARES VR jednatele pro top firem
- Bootstrap inventory ~16 700 firem + 6 600 jednatelů (Agrofert holding najde 5+ dceřinek včetně ZZN Polabí přes akcionářskou strukturu)
- Auto-detect OSVČ jednatelů (PD MONT → Dubický OSVČ)
- `includeHistorical` checkbox v holding discovery (synced s Mapou přes Alpine store)
- UI redesign Profil sekce, žádné auto-scroll skoky
- DNS přes Cloudflare (bypass Hetzner 443 filter), Always Use HTTPS

`v0.3` — MVP s production-ready hardening (rate limit, cache, p-limit), 3 deliverable features (PDF, demo, e-mail alerty) a první OSS release pod AGPL-3.0.
