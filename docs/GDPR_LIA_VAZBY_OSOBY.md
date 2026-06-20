<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
# Balanční test (LIA) — funkce „Vazby osoby" (vyhledání firem podle jména + data narození)

**Posouzení oprávněného zájmu podle čl. 6 odst. 1 písm. f) GDPR**

| | |
|---|---|
| **Správce** | SimpleSolar s.r.o., IČO 07315520, Regnerova 1102, 293 01 Mladá Boleslav |
| **Kontakt (DPO/GDPR)** | info@simplesolar.cz |
| **Zpracování** | Index „jméno + datum narození → seznam firem, v nichž osoba figuruje jako statutár / společník / akcionář / skutečný majitel" a jeho vyhledávání ve webové aplikaci icovazby.cz |
| **Verze dokumentu** | 1.0 |
| **Datum** | 2026-06-16 |
| **Revize** | při změně účelu, zdroje dat nebo rozsahu vystavení; min. 1× ročně |

> Tento dokument je interní záznam o posouzení. Veřejné shrnutí pro subjekty údajů je v [`/privacy.html`](../public/privacy.html) (sekce 2.4 a 7).

---

## 0. Shrnutí (TL;DR)

Funkce umožňuje zadat **jméno, příjmení a přesné datum narození** a zobrazit seznam obchodních subjektů, v nichž daná osoba je/byla zapsána (statutár, společník, akcionář, skutečný majitel). Data pocházejí **výhradně z veřejných rejstříků**, kde jsou zveřejněna přímo ze zákona. Závěr posouzení: **zpracování je přípustné na základě oprávněného zájmu**, za podmínky dodržení technických a organizačních záruk uvedených v části 5 — zejména **povinného zadání jména I data narození** (model „potvrzuji, neobjevuji"), **nezobrazování data narození ve výstupu** a **vyloučení rodného čísla**.

---

## 1. Identifikace oprávněného zájmu (purpose test)

**Existuje legitimní zájem? Ano.** Konkrétně:

1. **Transparentnost vlastnické a řídicí struktury firem** — veřejnost má právo zjistit, kdo stojí za obchodním subjektem. Tento účel je samotným důvodem existence veřejných rejstříků (zák. 304/2013 Sb.) a evidence skutečných majitelů (zák. 37/2021 Sb.).
2. **Prevence podvodů a due-diligence (AML/KYC)** — ověření, zda protistrana nebo její statutár nefiguruje v rizikových vazbách (řetězení „bílých koní", insolvence, sankce). Slouží podnikatelům, novinářům, věřitelům, compliance pracovníkům.
3. **Investigativní a kontrolní funkce** — propojování firem přes sdílené osoby je standardní novinářský a auditní nástroj (obdobné služby: Hlídač státu „Osoby", Cribis, MERK, justice.cz hledání osoby).

Tyto zájmy jsou **oprávněné, jasně formulované a v souladu s veřejným pořádkem** (podpora transparentnosti trhu).

**Čí zájem?** Správce (provoz služby) i třetí strany (uživatelé) i širší veřejný zájem.

---

## 2. Nezbytnost (necessity test)

**Je zpracování nezbytné pro daný účel? Ano.**

- Účel (najít vazby konkrétní osoby napříč firmami) **nelze naplnit bez** propojení identifikátoru osoby s firmami. Jméno samotné nestačí — jmenovců jsou tisíce. **Datum narození je minimální nutný rozlišovací údaj**, který používá i samotný veřejný rejstřík k odlišení osob; rejstřík proto datum narození zveřejňuje.
- **Méně invazivní alternativy zváženy a zamítnuty:**
  - *Pouze jméno (bez DOB):* nepřesné a zároveň invazivnější — umožnilo by „rybaření" a vrácení dat narození jmenovců (enumerace). **Zamítnuto.**
  - *Rodné číslo místo DOB:* zvlášť chráněný údaj, nadbytečné. **Zamítnuto — RČ se nezpracovává vůbec.**
  - *Neukládat index, dotazovat se pokaždé živě:* technicky možné jen zčásti (HS API), ale pomalé a stejně by se zpracovávaly tytéž údaje; index pouze zrychluje. Není to otázka většího rozsahu údajů.
- Zpracovává se **pouze nezbytný rozsah**: jméno, příjmení, titul, datum narození, a z toho odvozené veřejné zápisy (IČO, název firmy, funkce, organ, datum zápisu/výmazu). **Žádná adresa bydliště, rodné číslo, kontaktní údaje.**

---

## 3. Posouzení zájmů a práv subjektu (balancing test)

### 3.1 Povaha údajů
- **Nejde o zvláštní kategorie** (čl. 9) — žádné údaje o zdraví, vyznání, etniku apod.
- **Nejde o rodné číslo** (zvlášť chráněný národní identifikátor) — to se nezpracovává.
- Datum narození je osobní údaj, ale **nízké citlivosti** v tomto kontextu, navíc **již zákonně zveřejněný** ve veřejném rejstříku právě pro účel identifikace.

### 3.2 Zdroj a zákonnost zveřejnění
Veškerá osobní data pocházejí z **veřejně přístupných státních registrů**, kde jsou publikována na základě právních předpisů:
| Zdroj | Právní základ zveřejnění |
|---|---|
| Veřejný rejstřík (MSp) — statutáři, společníci, akcionáři | zák. 304/2013 Sb., § 3a–3b |
| ARES (MFČR) — otevřená data | zák. 106/1999 Sb., open-data licence |
| Evidence skutečných majitelů (částečně přes HS) | zák. 37/2021 Sb. |

Re-indexace již veřejných údajů z těchto zdrojů je činnost, kterou **registry samy předpokládají** (veřejná dostupnost a dálkový přístup).

### 3.3 Rozumné očekávání subjektu
Osoba zapsaná jako statutár/společník/skutečný majitel **rozumně očekává**, že tato skutečnost je veřejně dohledatelná — je to zákonný důsledek vstupu do obchodní funkce. Služba nepřináší údaj, který by osoba mohla považovat za soukromý.

### 3.4 Dopad na subjekt a rizika
- **Hlavní riziko:** snadnější profilování / kompletace „obchodní stopy" osoby; teoreticky zneužití (stalking).
- **Zmírnění (zásadní designové rozhodnutí):** vyhledávání **vyžaduje jméno I přesné datum narození zároveň**. Uživatel tedy musí osobu **už znát** (mít oba identifikátory) — služba pouze **potvrzuje** vazby, **neumožňuje objevovat** osoby ani enumerovat jmenovce. Tím odpadá scénář „napíšu příjmení a dostanu seznam lidí i s daty narození".
- **Datum narození se nikdy nevrací ve výstupu** — uživatel ho zadal, není potřeba ho opisovat zpět; brání to potvrzování/úniku DOB cizí osoby.
- Žádné automatizované rozhodování s právními účinky (čl. 22) se neprovádí.

### 3.5 Záruky (viz též část 5)
Povinné DOB · žádné echo DOB · žádné RČ · rate-limiting (Cloudflare edge + aplikace 60/min) · audit log · open-source kód (auditovatelnost) · proces pro námitku a výmaz.

### 3.6 Závěr balancing testu
Po zvážení: **oprávněný zájem na transparentnosti a prevenci podvodů převažuje** nad omezeným zásahem do soukromí, protože (a) údaje jsou již zákonně veřejné a osoba jejich dohledatelnost rozumně očekává, (b) rozsah je minimalizován, (c) designové záruky (povinné DOB, žádné echo, žádné RČ, žádná enumerace) eliminují hlavní rizika. **Zpracování je přípustné.**

---

## 4. Práva subjektu údajů

Subjekt má (a je informován v `/privacy.html` sekce 7) právo na:
- **přístup, opravu, výmaz, omezení, přenositelnost**;
- **námitku proti zpracování (čl. 21)** — protože titulem je oprávněný zájem, lze vznést námitku; správce pak posoudí, zda závažné oprávněné důvody převažují, jinak údaje z indexu **odstraní** (mechanismus „Žádost o smazání" v `/disclaimer.html`);
- **stížnost u ÚOOÚ**.

Žádosti: **info@simplesolar.cz**, vyřízení do 30 dnů.

> Pozn.: Výmaz z *našeho indexu* neodstraní údaj ze samotného veřejného rejstříku — ten řídí příslušný soud/MSp. Můžeme odstranit pouze naši kopii/index.

---

## 5. Technické a organizační záruky (závazné pro implementaci)

Implementace funkce **musí** splňovat:

1. **Povinný vstup = jméno + příjmení + přesné datum narození** (`YYYY-MM-DD`). Server odmítne dotaz bez platného DOB (`400 INVALID_INPUT`). Hledání pouze podle jména (tentative index) **se veřejně nevystavuje**.
2. **Datum narození se nevrací ve výstupu** žádného veřejného endpointu.
3. **Žádné rodné číslo** — neukládá se ani nezpracovává.
4. **Rate-limiting** — Cloudflare edge rule + aplikační limit (60 req/min/IP); brání hromadnému sběru.
5. **Audit log** dotazů (čl. 5 odst. 2 — accountability), retence dle AML 3 roky.
6. **Žádné předávání** indexu třetím stranám pro marketing/profilování.
7. **Minimalizace výstupu** — vrací se jen: název firmy, IČO, funkce/organ, datum zápisu/výmazu, kategorie vazby. Ne adresa, ne kontaktní údaje.
8. **Auditovatelnost** — kód je open-source (AGPL-3.0), chování ověřitelné.

Pokud by se měl rozsah rozšířit (např. vystavit hledání jen podle jména, vracet DOB, přidat adresu), **je nutné toto posouzení revidovat před nasazením.**

---

## 6. Závěr

Funkce „Vazby osoby" je při dodržení záruk v části 5 **slučitelná s GDPR na základě čl. 6 odst. 1 písm. f)**. Klíčové je zachovat model **„potvrzuji, neobjevuji"** (povinné DOB, žádné echo DOB, žádná enumerace). Tento dokument se reviduje při každé změně účelu, zdroje nebo rozsahu vystavení.
