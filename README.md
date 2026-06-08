# IČO vazby (ares-web)

> Webová aplikace pro **prověrku českých firem a jejich propojení** — vyhledávání podle IČO a názvu, kompletní profil firmy s 🟢🟡🔴 risk skóre, mapa propojení statutárů (Mermaid), holding discovery, detekce virtuálních adres. Bez AI, bez přihlášení, data z 11+ veřejných zdrojů.
>
> **Local-only projekt.** Není veřejně hostovaný ani na npm; spouští se z téhož repozitáře.

## Co umí

| Sekce | Co dělá |
|---|---|
| **🛡️ Profil firmy** | IČO nebo název → 🟢🟡🔴 risk badge + findings + identifikace + DPH + jednatelé + OR + UBO + dotace + smlouvy + sankce + insolvence + JERRS + živnosti + holding discovery. Vše v jedné sekci s rozbalovacími kartami. |
| **Mapa propojení** | 2–50 IČO → osoby ve více firmách + Mermaid graf. Volitelně i historické vazby (nominee detection). |
| **Hledat na adrese** | Detekce virtuálních kanceláří. > 50 firem = ⚠️, > 500 = 🚨. |
| **Export do fakturace** | Tlačítka Fakturoid / iDoklad / Pohoda → zkopíruje JSON do schránky, paste do fakturačního systému. |
| **Historie + oblíbené** | Posledních 10 hledání v localStorage + bookmark hvězdičkou. Sticky dropdown v hlavičce. |
| **Shareable URL** | `?ico=26185610&action=dd` deep-link → automaticky otevře report. Funguje pro DD, graf (`?icos=…`), adresu (`?address=…`). |

## Stack

- **Backend:** Fastify (TS), zod, undici, p-retry — žádné databáze, žádný stav.
- **Frontend:** vanilla HTML + Tailwind CDN + Alpine.js + Mermaid 11 — bez build stepu.
- **Data:** veřejné ARES REST API (CC BY 4.0). Žádné externí volání mimo ARES.

## Spuštění lokálně

```sh
git clone git@github.com:milos106/ares-web.git
cd ares-web
npm install
npm run build
npm start
```

Otevři **http://127.0.0.1:3000** v browseru.

Pro vývoj s hot reloadem:

```sh
npm run dev
```

## Konfigurace (env vars)

| Variable | Default | Popis |
|---|---|---|
| `PORT` | `3000` | Listen port |
| `HOST` | `127.0.0.1` | Bind host. Nastav `0.0.0.0` pokud chceš LAN přístup. |
| `RATE_LIMIT_PER_MIN` | `60` | Per-IP HTTP rate limit |
| `ARES_RATE_PER_SECOND` | `5` | Token bucket pro upstream ARES. Drž ≤ 8 (MFČR stop 500/min). |
| `ARES_TIMEOUT_MS` | `15000` | Timeout ARES requestu |
| `ARES_RETRIES` | `3` | Retry budget pro retriable chyby |
| `LOG_LEVEL` | `info` | Pino log level |

## REST API

| Endpoint | Co dělá |
|---|---|
| `GET /healthz` | Liveness check |
| `GET /api/validate/:ico` | Mod-11 checksum, bez network volání |
| `GET /api/company/:ico` | Profil firmy z ARES agregátu |
| `GET /api/dd/:ico` | Plný report hloubkové prověrky (paralelně 3 endpointy) |
| `GET /api/licenses/:ico` | Živnostenská oprávnění z RŽP |
| `GET /api/res/:ico` | Statistická klasifikace (velikost, sektor, NUTS) z RES |
| `GET /api/export/:ico/:target` | Fakturoid / iDoklad / Pohoda payload (`target` = jeden z těchto tří) |
| `GET /api/search/companies?obchodniJmeno=…&sidloPsc=…` | Hledání podle názvu / PSČ |
| `GET /api/search/address?adresa=…` | Hledání podle adresy |
| `POST /api/cross-persons` | Body: `{ icos: string[], includeHistorical?: bool, emitMermaid?: bool }` |

Vrací JSON, vždy s `_attribution` blokem.

## Architektonický vztah k ares-mcp

`ares-web` reuse-uje business logiku z [ares-mcp](https://github.com/milos106/ares-mcp) (soubory v `src/ares/`, `src/graph/`, `src/errors.ts`) — to jsou stejné typy a klient. Rozdílné jsou jen vrstvy navrch:

- **ares-mcp** = MCP server pro AI klienty (Claude Desktop, Cursor)
- **ares-web** = REST API + statický web pro lidi v browseru

Žádná z těch vrstev nepotřebuje druhou — můžeš mít nasazené jen jedno, nebo obojí.

## Datové zdroje a jejich licence

Aplikace integruje veřejné datové zdroje. Každý má vlastní licenci a vlastní povinnost atribuce:

| Zdroj | Použito pro | Licence | Atribuce | Komerční |
|---|---|---|---|---|
| **ARES** (MFČR) | Profil, statutáři, NACE, sídlo | CC BY 4.0 | „Source: ARES, MFČR" | ✅ |
| **ADIS** (Finanční správa) | Nespolehlivý plátce DPH + zveřejněné účty | Veřejná data § 96a z. o DPH | „Source: MFČR ADIS" | ✅ |
| **Hlídač státu** _(v přípravě, vyžaduje token)_ | Veřejné zakázky, smlouvy, UBO, dotace | **CC BY 3.0 CZ** | ⚠️ **POVINNÝ funkční odkaz na hlidacstatu.cz** zobrazený vždy s daty i v patičce | ✅ s atribucí; komerční bez atribuce vyžaduje smlouvu s api@hlidacstatu.cz |
| **ISIR** (Justice ČR) _(v přípravě)_ | Detail insolvenčního řízení | Veřejná data § 419 z. č. 182/2006 Sb. | „Source: ISIR / MSp ČR" | ✅ pod limitem 3000/den, 50/min |
| **Veřejný rejstřík (OR)** | Plný strukturovaný výpis: akcie, kapitál, statutární orgán, dozorčí rada, akcionáři, historie firmy (ostatní skutečnosti) | Z. č. 304/2013 Sb. (veřejně přístupné) | „Source: Veřejný rejstřík, MSp ČR" | ✅ |
| **ČNB — denní kurzy** | CZK→cizí měna widget v headeru, tooltipy převodů | Veřejná data ČNB | „Source: ČNB" | ✅ |
| **ČNB — JERRS open-data** | Indikátor regulovaného subjektu (banka, směnárna, NPSU…) | Otevřená data dle nař. vlády 425/2016 Sb. | „Source: ČNB" | ✅ |
| **EU Consolidated Sanctions List** | Screening jmen statutárních orgánů proti EU sankcím | **Commission Decision 2011/833/EU** (free reuse) | „Source: EU Commission — FPI / FSF" | ✅ **včetně komerčního použití** |

### Hlídač státu — atribuční povinnost (citát z licence CC BY 3.0)

> „Musíte vždy a bezpodmínečně uvést původ dat a autorství zdrojových dat (na internetu plný, funkční internetový odkaz na Hlídač státu). Nesmíte přidat žádná další technická či právní omezení nad rámec této licence."

Toto je proto v patičce aplikace zobrazeno explicitně, pokud je integrace aktivní (HLIDAC_API_TOKEN nastaven).

### EU sankce — přímý přístup, ne přes OpenSanctions

Původně jsme uvažovali OpenSanctions wrapper (CC BY-NC 4.0, nelze komerčně), ale EU's vlastní Open Data Portal **explicitně publikuje** unauthenticated XML feed konsolidovaného sankčního listu:

```
https://webgate.ec.europa.eu/fsd/fsf/public/files/xmlFullSanctionsList_1_1/content?token=dG9rZW4tMjAxNw
```

Token `dG9rZW4tMjAxNw` (base64 „token-2017") je dokumentovaný jako veřejná URL distribuce datasetu na [data.europa.eu](https://data.europa.eu/data/datasets/consolidated-list-of-persons-groups-and-entities-subject-to-eu-financial-sanctions). Licence: **Commission Decision 2011/833/EU** — volné užití včetně komerčního, vyžaduje pouze uvedení zdroje. Žádné non-commercial restrikce.

Můžeš override URL přes env `EU_SANCTIONS_URL` (např. pokud si zaregistruješ vlastní EU Login token pro vyšší stabilitu).

## Atribuce a licence dat

ARES data jsou publikována pod **Creative Commons Attribution 4.0 (CC BY 4.0)**. Při použití výstupů aplikace musíš uvádět zdroj:

> Source: ARES — Administrativní registr ekonomických subjektů, © Ministerstvo financí ČR, https://ares.gov.cz/, licensed under CC BY 4.0.

Footer každé stránky obsahuje plnou atribuci + GDPR upozornění + affiliation disclaimer („nesouvisí s MFČR").

## GDPR

Výpisy z ARES obsahují osobní údaje (jména, data narození jednatelů). ARES je publikuje na základě veřejné listiny (čl. 6(1)(e) GDPR). **Pokud tato data ukládáš nebo zpracováváš downstream, stáváš se správcem** ve smyslu nařízení (EU) 2016/679 a máš vlastní povinnosti (privacy policy, právní základ, práva subjektů údajů).

ares-web sám **nelogguje request body** ani neukládá výsledky — každý dotaz proletí beze stopy.

## Licence kódu

MIT — viz [LICENSE](./LICENSE). Licence dat (CC BY 4.0) je nezávislá.

## Acceptable use ARES

MFČR limituje ARES na **500 dotazů/min na uživatele**. ares-web defaultně tahá max 5 req/s = 300/min, takže pod stropem zůstaneš. Pokud někdy přesáhneš (např. paralelně několik instancí), MFČR si vyhrazuje právo IP zablokovat.

## Testy

```sh
npm test                              # 14 unit testů, vitest, mock klient
node tests/e2e.playwright.mjs         # 8 E2E proti běžícímu serveru
```

E2E test pokrývá: profil + URL state + RES klasifikaci + clipboard export + DD deep-link + Mermaid graf + shell detekci + history dropdown.

## Status projektu

v0.2 — MVP rozšířený o RES/RŽP detaily, export do 3 fakturačních systémů, localStorage historie + oblíbené, shareable URL deep-links, vitest + Playwright pokrytí. Žádný placený SaaS, žádný npm publish, jen lokální použití.
