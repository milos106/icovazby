# Licence FAQ

Časté dotazy k licencování projektu **icovazby** pro komerční a interní použití.

**Aktuální licence kódu:** AGPL-3.0-or-later
**Aktuální stav komerčních licencí:** dostupné na vyžádání
**Kontakt:** info@simplesolar.cz

---

## Pro koho je tato FAQ

- Banky, pojišťovny, advokátní kanceláře a další povinné osoby zvažující **interní nasazení** kódu
- Konkurenti zvažující **fork + vlastní SaaS** na podobné téma
- Konzultantské firmy plánující používat icovazby pro klienty
- Reseller-ové (white-label nabídka)

---

## Q1: Můžeme používat icovazby.cz (hostovanou verzi) komerčně?

**Ano.** AGPL-3.0 omezuje jen **distribuci kódu**, ne použití hosted služby. Stačí dodržet Podmínky služby (TERMS.md).

Co můžeš dělat bez jakékoli licenční obavy:
- Generovat DD reporty pro klienty
- Účtovat klientům za tvé KYC procesy postavené nad icovazby
- Stahovat PDF prověrky, exportovat CSV a používat data interně
- Volat veřejné API (pokud bude k dispozici) v rámci Pro/Enterprise tieru

---

## Q2: Můžeme stáhnout kód z GitHubu a běžet ho interně?

**Ano, pod podmínkami AGPL-3.0:**

✅ Můžeš ho stáhnout, modifikovat a nasadit ve **vlastní infrastruktuře** (cloud, on-premise)
✅ Můžeš si to upravit „pro sebe"
⚠️ Pokud ho **nasadíš jako webovou službu** (i jen interně, pokud k ní mají přístup uživatelé mimo tvůj jeden právní subjekt — např. externí konzultanti, partneři) → **musíš zveřejnit svůj zdrojový kód všem uživatelům** té služby (AGPL §13)
⚠️ Pokud distribuuješ binárku/Docker image → totéž

**V praxi to znamená:**
- Banka, která nasadí icovazby pro **vlastní zaměstnance**, by **musela poskytnout zdrojový kód zaměstnancům** na vyžádání (často nepřijatelné kvůli compliance, security)
- Banka, která má jen jediný subjekt + nezveřejňuje veřejně, je v šedé zóně podle interpretace „v interakci" v §13

**Doporučení pro enterprise:** kup si **komerční licenci**. Vyhneš se právní nejistotě a získáš oprávnění distribuovat closed-source modifikace.

---

## Q3: Co je „komerční licence"?

Maintainer (Miloš Pospíšil) je **jediný copyright holder** a má právo **dual licensingu**. Komerční licence = identický kód, ale **bez AGPL podmínek**:

- ✅ Použití v closed-source produktech
- ✅ Distribuce binárek bez zveřejňování kódu
- ✅ Self-host bez §13 obligací
- ✅ Customizace bez nutnosti otevřít kód komunity
- ✅ Indemnification (kryti tě pro patentové žaloby)
- ✅ Prioritní support podle smlouvy

**Cenový rámec (orientačně, předmět individuální dohody):**

| Velikost firmy | Roční fee |
|---|---|
| Startup / SMB (<50 zaměstnanců) | 30–80 tis. Kč/rok |
| Střední (50–500) | 100–300 tis. Kč/rok |
| Enterprise (500+ nebo regulovaná) | 300+ tis. Kč/rok (na míru) |
| White-label / reseller | Custom revenue share |

Kontakt: info@simplesolar.cz s tématem **„Commercial license inquiry"**.

---

## Q4: Co když jen chceme upravit jeden malý kus kódu?

Pokud chceš:
- **Bugfix** → pošli PR, podepsání CLA (docs/CLA.md) → zařadíme do upstream zdarma
- **Vlastní integraci** s tvým interním systémem (např. CRM) → AGPL platí. Buď zveřejni úpravy (free), nebo komerční licence.

---

## Q5: Můžeme udělat fork a startovat vlastní SaaS „bisnode.cz/lite"?

**Můžete, ale:**

- Tvůj fork musí být **taky AGPL-3.0**
- Musíš zveřejňovat všechny změny
- **Nesmíš použít brand „icovazby"** (chráněn ochrannou známkou, registrace v procesu) ani vizuální identitu
- Musíš respektovat licence primárních zdrojů dat (Hlídač státu CC-BY 3.0 atd.)

Pokud chceš **proprietární fork** (vlastní úpravy closed-source, vlastní brand, vlastní SaaS) → komerční licence + Trademark license agreement.

---

## Q6: Já jsem dělal/a contribution. Můžu si to vzít a nasadit pod jinou licencí?

Tvoje contribution byla podepsána přes CLA (docs/CLA.md), což znamená:
- Zachováváš si copyright k svému Příspěvku
- Máš licenci ho použít kdekoli, jak chceš (CLA ti práva nebere)
- Maintainer ho má pod stejnou flexibilitou

Tj. **ano, můžeš svůj vlastní kód použít jinde** pod libovolnou licencí. Forky musí respektovat AGPL nebo komerční licenci pro celý projekt.

---

## Q7: Můžeme používat data, která ÚPV / ARES / Hlídač státu poskytuje přes icovazby?

icovazby je **agregátor**. Data jsou poskytována pod licencí **původních zdrojů**:

| Zdroj | Licence | Co dodržet |
|---|---|---|
| ARES, OR, ADIS, ČNB | Veřejná data | bez omezení (volné užití) |
| ÚPV ochranné známky | Veřejná data ST.96 | bez omezení (volné užití) |
| Hlídač státu (UBO, dotace, smlouvy) | **CC BY 3.0 CZ** | **musíš uvést zdroj** „© Hlídač státu, z.ú." + link na hlidacstatu.cz |
| EU sankce (FSF) | EU CFSP — public | bez omezení |
| icovazby risk score + agregace | **AGPL-3.0** | derivátní práce taky AGPL |

Pokud děláš vlastní DD report z dat icovazby, **uveď tyto zdroje**. Sdílet vlastní PDF prověrku pro vnitřní potřebu je OK. Veřejně publikovat report s daty z Hlídače = uveď CC BY atribuci.

---

## Q8: Co když chceme white-label řešení (vlastní brand)?

**Ano**, k dispozici jako **Enterprise tier**:

- Vlastní doména (dd.tvojebanka.cz)
- Vlastní logo + barvy
- Vlastní onboarding flow
- Vlastní billing (nebo na fakturu od nás)
- Optional: vlastní data zdroje (např. interní blacklist)

Vyžaduje:
- Komerční licenci pro kód (viz Q3)
- Trademark license pro „powered by" (volitelné)
- SLA dle dohody (typicky 99.5–99.9 % uptime)

Cena: na míru, typicky 300+ tis. Kč/rok + setup fee.

---

## Q9: Pro maintainera — kdy se mám obrátit na právníka?

Pro tyto situace si vezmi **právního zástupce na IP a licenční záležitosti**:

- Před uzavřením první komerční licenční smlouvy (custom SLA + indemnification)
- Před podpisem CLA s prvním externím contributor-em (předpřipravený CLA má pomoci, ale review je dobrý)
- Před white-label dealem s první bankou (typický kontrakt 30+ stránek)
- Před změnou licence projektu (např. AGPL → BSL) — vyžaduje due diligence k tomu kdo jaká práva drží

**Doporučení:** advokátní kancelář se specializací na IT/IP právo, např. Kinstellar, Havel & Partners, Holec advokáti, nebo nizozejší butiqové firmy jako Dvořák & Co.

---

## Kontakt pro licenční dotazy

**SimpleSolar s.r.o.**
IČO: 07315520
Sídlo: Regnerova 1102, Mladá Boleslav III, 293 01 Mladá Boleslav
Jednatel: Ing. Miloš Pospíšil (copyright holder kódu)
E-mail: info@simplesolar.cz
Subject prefix: „[Licence]" nebo „[Commercial]"

Odpovídám do 2 pracovních dní.

---

**Verze:** 1.1 (2026-06-09 — provozovatel SimpleSolar s.r.o.).
Living document — aktualizace s každou změnou licenčního stavu.
