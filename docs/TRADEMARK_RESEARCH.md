# Pre-check: rešerše konfliktů pro známku „icovazby"

**Datum rešerše:** 2026-06-09
**Zkoumaný termín:** `icovazby` (varianty: „ico vazby", „IČO vazby", samostatně „vazby")
**Cíl:** Zhodnocení rizika kolize před podáním přihlášky u ÚPV.

---

## Výsledek (TL;DR)

✅ **Cesta je volná.** Žádný konflikt v ÚPV databázi, žádný relevantní konflikt ve veřejných sociálních / package registrech, dostupné jsou všechny relevantní domény kromě `.cz` (drží uživatel).

**Doporučení:** Pokračovat s registrací podle `docs/TRADEMARK.md` (varianta B = slovní + kombinovaná známka, třídy 42, 35, 45).

---

## Detailní výsledky

### 1. ÚPV databáze (lokálně z naší SQLite, 307 051 značek, snapshot 10-02-2026 + denní DIFFy do 08-06-2026)

| Search query | Výsledek |
|---|---|
| `mark_text LIKE '%icovazby%'` | **0 záznamů** |
| `applicant_name LIKE '%icovazby%'` | **0 záznamů** |
| `mark_text LIKE '%ico vazby%'` nebo `%ičo vazby%` | **0 záznamů** |
| `mark_text LIKE '%vazby%'` (aktivní status) | **1 záznam: „SuperVazby"** — SuperThesis s.r.o., #571708, 2021-04-29, status 2 (po formálním průzkumu) |

**Závěr:** Žádný přímý konflikt. „SuperVazby" je samostatný brand v jiném sémantickém poli (vazby ≠ podnikatelské vazby) a navíc označení „vazby" samotné je ÚPV pravděpodobně odmítlo jako popisné. Naše „icovazby" je uměle vytvořené slovo bez popisných prvků → silnější ochrana.

### 2. ÚPV ISDV (online vyhledávání)

Standardní web interface (https://isdv.upv.gov.cz) — vyžaduje JavaScript pro dynamický UI. **Akce pro user:** projít manuálně před podáním:
- https://isdv.upv.gov.cz/webapp/resdb.print_seznam?xprx=ÚZNÁMKY&xs=icovazby
- 5 minut, zdarma

Toto je formalita — lokální databáze odpovídá ÚPV s 1denním delayem.

### 3. EUIPO TMView (EU ochranné známky)

API přístup z VPS blokovaný (F5 bot detection, dle dřívější analýzy v repo). **Akce pro user:** manuálně:
- https://www.tmdn.org/tmview/#/tmview/results?criteria=BASIC&page=1&pageSize=30&basicSearch=icovazby
- 5 minut, zdarma
- Pokud najdeš nějaký výskyt v třídě 9, 35, 42, 45 → potřebuje vyhodnocení patentovým zástupcem

### 4. WIPO Global Brand Database (mezinárodní)

API chráněno altcha captcha. **Akce pro user (volitelné):**
- https://branddb.wipo.int/branddb/en/#search&brandName=%22icovazby%22
- Relevantní jen pokud plánuješ mezinárodní ochranu (WIPO Madrid)
- Pro CZ + EU stačí body 2+3

### 5. Domény

| Doména | Status | Akce |
|---|---|---|
| **icovazby.cz** | Registrovaná (tvoje, NS Cloudflare, A 188.114.96.9) | ✅ máš |
| **icovazby.com** | Volná | 💡 **rezervuj** (cca 200 Kč/rok) |
| **icovazby.eu** | Volná | 💡 **rezervuj** (cca 200 Kč/rok) — důležitá při EU expanzi |
| **icovazby.sk** | Volná | 💡 **rezervuj** (cca 400 Kč/rok) — důležitá při SK expanzi |
| icovazby.io | Volná | volitelně (cca 1500 Kč/rok, pro tech-friendly brand) |
| icovazby.net | Volná | volitelně |
| icovazby.app | Volná | volitelně |
| icovazby.dev | Volná | volitelně |
| icovazby.online | Volná | volitelně |

**Doporučení:** Investovat ~1 tis. Kč/rok do `.com` + `.eu` + `.sk`. Defensive registrace. Nemusíš tam mít obsah, stačí směrovat na hlavní web.

### 6. Sociální sítě a package registry

| Platforma | Status | Akce |
|---|---|---|
| **GitHub /icovazby** | 404 | 💡 **rezervuj username** (1 min, zdarma) |
| **GitHub /icovazby-cz** | 404 | volitelně |
| **LinkedIn /company/icovazby** | 404 | 💡 **vytvoř company page** (15 min, zdarma) |
| **Twitter (X) @icovazby** | nelze ověřit guest (login wall) | manuálně z přihlášeného účtu |
| **npm icovazby** | 404 — volné | 💡 **rezervuj** (1 min, zdarma) — `npm publish` placeholder package |
| **PyPI icovazby** | 404 — volné | 💡 **rezervuj** stejně jako npm |
| **Facebook /icovazby** | nezkoumáno | manuálně |
| **Instagram @icovazby** | nezkoumáno | manuálně |

### 7. Google / obecné indikátory

Nelze přímo skenovat z tohoto prostředí. **Akce pro user:**
- https://www.google.com/search?q=%22icovazby%22 → ověř že hlavní výsledek jsi ty, ne jiný projekt
- https://www.google.com/search?q=%22ico+vazby%22 → totéž
- Web archive: https://web.archive.org/web/*/icovazby.* → kontrola jestli někdo historicky nepoužil

---

## Rizikové faktory (žádné kritické)

| Risk | Pravděpodobnost | Mitigace |
|---|---|---|
| ÚPV odmítne kvůli popisnosti („IČO" + „vazby") | **nízká** | Použij **slovní označení „icovazby"** jako uměle vytvořené slovo, ne „IČO vazby" s mezerou. „icovazby" jako celek nemá popisný charakter. |
| Konflikt s neregistrovaným brandem | nízká | Online checky výše. Lze obejít přes patentového zástupce — formální „watch service" stojí ~3 tis. Kč/rok. |
| Námitka v rámci 3měsíčního námitkového řízení | velmi nízká | Pokud nikdo nepodá námitku → automatický zápis |

---

## Doporučený postup teď

1. **Akce hned (10 minut, zdarma):**
   - Otevři GitHub a rezervuj username `icovazby` (případně i `icovazby-cz`)
   - Zaregistruj `icovazby` na npm (`npm publish` prázdný placeholder)
   - Zaregistruj `icovazby` na PyPI (analogicky)

2. **Akce do týdne (~1 tis. Kč):**
   - Rezervuj `icovazby.com`, `.eu`, `.sk` u svého preferovaného registrátoru (Wedos, GoDaddy)

3. **Akce do měsíce (~9 tis. Kč):**
   - Manuálně ověř ÚPV ISDV + EUIPO TMView z prohlížeče (10 min)
   - Připrav SVG reprodukci známky (máš ve `public/favicon.svg`)
   - Podej přihlášku přes ÚPV online portál NEBO přes patentového zástupce (preferované, ~3 tis. Kč navíc, ale snižuje riziko zamítnutí)
   - Sleduj věstník ÚPV

4. **Po zápisu (~6 měsíců):**
   - Aktualizovat `TERMS.md` čl. 13 (Licence) a footer hlavního webu o `icovazby®`
   - Případně rozšířit EU (EUIPO, ~25 tis. Kč) nebo mezinárodně (WIPO Madrid)

---

## Audit trail

- Lokální DB query: `sqlite3 data/persons-index.sqlite "SELECT ... WHERE mark_text LIKE '%icovazby%'"` — 0 výsledků
- Online checky: viz výše, zapsáno 2026-06-09 v ~17:50 UTC
- Memory pointer: `~/.claude/.../memory/project_icovazby_roadmap.md` (Legal infrastructure)

Tento dokument je **rešeršní záznam** k datu 2026-06-09. Před podáním přihlášky doporučuji **manuálně reověřit** body 2+3 z prohlížeče (5 min), protože databáze ÚPV i EUIPO mohou být aktualizované od dnešní rešerše.
