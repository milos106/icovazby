# icovazby.cz — roadmap & strategic backlog

Last updated: **2026-06-09**

Strategický pohled na další směřování. Rozděleno podle horizontu a impactu. Tento dokument je živý — když dokončíme položku, posuneme ji do CHANGELOG (nebo task #N s `completed`); když narazíme na nový nápad, přidáme ho sem.

### 🔧 Infra migrace (běží)

**Hetzner DE → Hukot CZ (ivz1)** — kvůli MSP WAF blokaci Hetzner IP rozsahu a konsolidaci 4 fakturací (Hetzner + 3 Hukot webhostings) do jednoho VPS. Detailní plán s checkboxy: **[`docs/MIGRATION_HUKOT.md`](./MIGRATION_HUKOT.md)**.

**Aktuální backbone** (k 2026-06-09):
- 13 datových zdrojů (ARES, OR, RŽP, ADIS DPH, ISIR, ČNB, EU sankce, Hlídač státu UBO/dotace/smlouvy, ÚPV ochranné známky, …)
- 307k značek + 17k subjektů + 22k osob + 900 ownership edges v SQLite
- Audit log, CI/CD, per-user HS token, multi-tenant začátek
- Mapa propojení (Mermaid + Cytoscape), DD karty, PDF prověrky, bulk DD, alerty, sharing read-only

---

## 🚀 Quick wins (1–3 dny každý, vysoký user benefit)

### 1. Auto-summary profilu přes LLM
Claude/GPT vygeneruje exec summary firmy v 5 větách — risk faktory, zajímavosti, červené vlajky. Frontend tlačítko „📋 Souhrn pro klienta" → instant report. **Killer feature pro advokáty.**

### 2. Watchlist & monitoring s notifikacemi
„Sledovat firmu" tlačítko → e-mail / push při změně (nový jednatel, změna DPH, insolvence, sankce). Už máme alerty na uložené searches — rozšířit i na single subjects. Hodně přidaná hodnota.

### 3. Embed widget pro 3rd party
```html
<script src="https://icovazby.cz/embed.js"></script>
<icovazby-card ico="26185610"></icovazby-card>
```
Mini kartička s risk score + CTA → tvůj web. **Marketing kanál** — bezplatně se šíří přes blogy/zprávy.

### 4. Browser extension
Chrome/Firefox — vidíš IČO kdekoliv na webu (fakturoid, e-mail, GovČR), hover → mini DD. Týden práce, **freemium funnel**.

---

## 📊 Datové zdroje k dotažení

### A. Katastr nemovitostí (ČÚZK) — **deferred do post-monetizace** (2026-06-09)
Kdo vlastní jaké nemovitosti = velký DD signál pro banky / advokáty / realitky. ALE ČÚZK API je **placené** (~50–100 Kč/výpis přes WSDP nebo VDP), smluvní zákaz long-term cache, GDPR exposure roste, ekonomicky dává smysl až s 10+ platícími klienty kteří to vyloženě poptávají.

**Rozhodnutí 2026-06-09:** Počkat na monetizaci a B2B trakci, pak udělat **Model A** (pass-through ~99 Kč/lookup, marže ~49 Kč). Detaily ekonomiky v session log.

**Alternativa zdarma teď:** RÚIAN adresní cross-reference — kolik firem sídlí na stejné adrese (detekce shared business centers, virtual office, červené vlajky). Free open data, ~2 dny implementace, podobná DD hodnota jako Katastr „má-li firma majetek".

### B. Insolvenční rejstřík (ISIR) — přímý XML feed
Task #109 už hotový přes Hlídač státu, ale plný XML feed dává **víc detailu** (datumy úkonů, věřitelé, výše dluhů). ISIR má open feed (https://isir.justice.cz).

### C. Beneficial owners EU (BORIS / OpenCorporates)
Když má CZ firma SK / EU dceřinku, propojit. SK Obchodný register má JSON. **Cross-border holding discovery** = killer pro internacionální klienty.

### D. Soudní rozhodnutí (NSoud, ÚS)
Volně dostupné PDFs. Plné texty soudních rozhodnutí spojené s IČO/jménem. Skvělé pro reputational DD.

### E. TED (EU veřejné zakázky)
SIMAP TED je open data. CZ firma vyhrála EU tender? Cross-border procurement.

---

## 🧠 AI / ML

### 1. Konverzační DD asistent (chat UI)
„Najdi mi všechny firmy v energetice s OSVČ majitelem, dotacemi >5 mil. Kč, sídlem v Praze." → LLM transformuje na strukturovaný SQL/API query. **Killer demo pro investory.**

### 2. Anomaly detection
Heuristic + ML: rychlá výměna jednatelů, IČO bez webu + shared address s 50 firmami, založeno před týdnem + okamžitě fakturuje 10 mil. → flag „suspicious". Trained na FAÚ AML případech.

### 3. Auto-categorize firmy podle NACE + historie
NACE číselník je hrubý. LLM přečte web + popis činnosti + RŽP licence → přesnější kategorizace (e.g. „solar EPC contractor" místo „46.7 Velkoobchod s ostatními výrobky"). Bonus: konkurenční mapa odvětví.

### 4. OCR faktury → DD
Drop faktura PDF → extrahuj IČO → instant prověrka. Use case: účetní firma kontroluje 100 faktur denně. **Měsíční předplatné.**

---

## 💼 B2B / monetizace

### Reálný funnel

**Free tier:**
- 10 DD / den
- Profil firmy + risk score
- Bez watchlistu, bez API

**Pro (390 Kč/měs):**
- Unlimited DD
- Watchlist + e-mail alerty
- PDF prověrka neomezeně
- API token (1k volání/měs)

**Enterprise (custom, ~10k Kč/měs):**
- White-label (banky, advokáti pod vlastní doménou)
- SSO (SAML, OIDC)
- SLA + audit trail per user
- Compliance reporting pro AML/KYC
- API neomezeně

**Cílovky:**
1. Solo advokáti / účetní — 200–500 zákazníků za 390 Kč → 100k/měs MRR realistic
2. Banky / pojišťovny — KYC compliance, malé partnerships
3. VC / M&A advisors — quick DD pre-deal

### Implementace
- Stripe + portál pro správu subscription
- Per-user limity v DB (`users` tabulka už máš multi-tenant začátek)
- API key management UI

---

## 🎨 UX směry

### 1. Časová osa firmy (task #92) — rozšířit
Story view: „2019 — založení", „2021 — změna jednatele Babiš → X", „2023 — registrace značky Y", „2024 — insolvence". **Storytelling profilu**.

### 2. GIS mapa adres
Sídlo firmy na mapě + okolní firmy v 100 m. Detekuje shared business centers, virtuální adresy. Free Leaflet.js + OpenStreetMap. Bonus: katastr overlay.

### 3. Power broker graf
Kdo sedí ve 30+ firmách = vlivová osoba. Top 100 power brokerů v ČR jako landing stránka — **SEO magnet**.

### 4. Influence network animation
Při expand holding postupně vykresluj graf → vizuální „wow effect" pro klientskou prezentaci.

---

## 🛠️ Tech investice (jen pokud rostete)

| Co | Kdy řešit | Důvod |
|---|---|---|
| Postgres migrace | 1k+ DAU | SQLite WAL má concurrency limity |
| Typesense / Meilisearch | hned | Full-text search napříč 17k firem + 300k značek — SQLite LIKE už škrtí |
| Redis cache | multi-instance deploy | Sdílená cache mezi nodes |
| CF Pages pro statiku | hned | Origin offload, edge cache |
| Sentry / OpenTelemetry | hned | R2 už máš, ale dokresli |
| Hetzner → CZ provider | po VR řešení | Lokální compliance + odpadne VR proxy |

---

## 🌟 Moonshots (ambitiózní, ale impakt)

### „Czech business intelligence" platforma
Postupně se posouváš z „prověrka firmy" k **plnému BI / market intelligence**:
- Sektorové dashboardy (energetika, stavebnictví — kdo roste, kdo padá)
- M&A radar (změny vlastnictví v real-time)
- Investorský feed (nové startupy s VC funding přes registr akcionářů)
- Lobby tracker (kdo dává peníze koho)

### Slovenská expanze
SK má podobný stack (Obchodný register, FinStat). Tvůj kód je modulární → druhá doména `icovazby.sk` za pár týdnů. **Trh 2× větší.**

### Open-source AGPL community
Web je AGPL-3.0 — můžeš to vyhrát jako **„Sentry of Czech business data"**. Nadšenci přispějí integrace (justice, FÚ), ty držíš hosted verzi. Github star magnet.

---

## Doporučený postup (kdybych dělal já)

**Příští 2 týdny:**
1. Watchlist + e-mail alerty na single subjects (extend existing alerty) — 2 dny, vysoký retention
2. LLM auto-summary profilu — 1 den, killer demo feature
3. Embed widget — 2 dny, marketing distribution

**Příští měsíc:**
4. Katastr nemovitostí (task #95) — task už máš naplánovaný, ČÚZK API ready
5. Stripe + Pro tier — 3 dny, začni vybírat peníze (i kdyby jen za PDF prověrku 50 Kč)

**Příští kvartál:**
6. Konverzační AI search — strategic differentiator
7. API + dokumentace — partneři už budou volat

---

## Otevřená strategická otázka

**Chceš to dělat jako produkt (vlastní byznys), nebo nástroj (free pro public good)?**

- **Produkt** → freemium + Stripe, B2B sales, marketing, SaaS metrics. Priorita: monetizace + retention.
- **Nástroj** → AGPL community, donations, akademická hodnota. Priorita: open data + společenský dopad.

Z toho se odvíjí všechno ostatní (priority features, tech investice, hosting, marketing).

---

## 📜 Legal infrastructure (status 2026-06-09)

Připraveno v `docs/`:
- ✅ [CLA.md](CLA.md) — Contributor License Agreement
- ✅ [TERMS.md](TERMS.md) — Podmínky služby
- ✅ [DISCLAIMER.md](DISCLAIMER.md) — Omezení odpovědnosti
- ✅ [LICENSE_FAQ.md](LICENSE_FAQ.md) — FAQ pro komerční klienty
- ✅ [TRADEMARK.md](TRADEMARK.md) — Checklist registrace ochranné známky u ÚPV

**Licence: zůstává AGPL-3.0-or-later** — nepřechází se. Důvod: kryje záda proti freerider konkurenci + neblokuje monetizaci (klient platí za hosted service, ne za kód).

**Pending akce:**
- ✅ Servírovat `TERMS.md` + `DISCLAIMER.md` jako `/terms.html` + `/disclaimer.html` (0.7.1, live)
- ✅ Rešerše konfliktů „icovazby" — viz [TRADEMARK_RESEARCH.md](TRADEMARK_RESEARCH.md), **cesta je volná**
- [ ] User-side manuální ověření ÚPV ISDV + EUIPO TMView (10 min)
- [ ] Rezervace GitHub/npm/PyPI username `icovazby` (10 min, zdarma)
- [ ] Rezervace domén `.com`, `.eu`, `.sk` (~1 tis. Kč/rok)
- [ ] Podání přihlášky ochranné známky u ÚPV (~9 tis. Kč, ~6 měsíců)
- [ ] Příprava komerční licence template (až přijde první enterprise klient)

---

## Living document

Když dotáhneme položku:
- Označit zde ~~strikethrough~~ s odkazem na task / commit
- Přidat do CHANGELOG.md
- Případně rozšířit memory (`reference_*.md`) pokud je to nový persistent zdroj dat

Když objevíme nový směr:
- Přidat do příslušné sekce
- Pokud je to velký kus, vytvořit task přes TaskCreate s odkazem sem

Pointer v memory: `~/.claude/projects/-home-milos-work-ares-mcp/memory/project_icovazby_roadmap.md`
