# Podmínky služby (Terms of Service)

**Verze:** 1.1
**Účinnost od:** 2026-06-09
**Provozovatel:** SimpleSolar s.r.o., IČO 07315520, sídlem Regnerova 1102, Mladá Boleslav III, 293 01 Mladá Boleslav, zapsaná v obchodním rejstříku vedeném Krajským soudem v Praze
**E-mail:** info@simplesolar.cz
**Web:** https://icovazby.cz

Používáním webu icovazby.cz souhlasíš s těmito podmínkami. Pokud nesouhlasíš, službu nepoužívej.

## 1. Co služba dělá

icovazby.cz agreguje veřejně dostupná data o českých podnikatelských subjektech z 13+ veřejných zdrojů (ARES, Veřejný rejstřík, ADIS DPH, ISIR, ČNB JERRS, EU sankce, Hlídač státu, ÚPV ochranné známky a další). Slouží k **informativní prověrce** českých firem (due diligence, KYC podpora, ověření obchodního partnera).

## 2. Charakter dat

- **Data jsou informativní.** Zobrazované informace pocházejí z veřejných registrů a jsou zpracovány automaticky. Mohou obsahovat chyby, opoždění nebo neúplnosti.
- Služba **nenahrazuje** výpis z obchodního rejstříku, právní due diligence ani AML/KYC povinnosti podle zákona č. 253/2008 Sb.
- Pro úřední účely vždy ověř informace přímo u zdroje.
- Detail viz [DISCLAIMER.md](DISCLAIMER.md).

## 3. Tiers a omezení

### Free tier (anonymní použití)
- 10 prověrek za den z jedné IP adresy
- Žádný garantovaný uptime (best-effort)
- Žádná podpora

### Pro tier (pokud bude spuštěn — viz aktuální nabídka na webu)
- Specifický limit DD podle plánu
- Watchlist + e-mail alerty
- PDF prověrky
- API přístup s tokenem
- E-mailová podpora s reakcí do 2 pracovních dní

### Enterprise (na míru)
- Vlastní SLA, support, white-label, on-premise nasazení podle smlouvy

## 4. Tvoje povinnosti

Souhlasíš, že **NEBUDEŠ**:

- **Scrapovat** službu automatizovanými nástroji nad rámec běžného použití (max 60 req/min z jedné IP, max 10 IČO za hodinu v Bulk DD pro Free)
- Sdílet svoje API tokeny s třetími stranami
- Používat data ke spamování, telemarketingu bez souhlasu nebo k diskriminaci
- Pokoušet se obejít omezení (rate limity, paywall, autentizaci)
- Reverse-engineerovat backend nad rámec práv daných AGPL-3.0 licencí
- Používat službu k nelegálním účelům podle českého a unijního práva

Porušení znamená okamžité ukončení přístupu bez nároku na refund.

## 5. Tvoje data v naší databázi

Pokud používáš Pro tier (po registraci), ukládáme:

- E-mail (pro alerty + login)
- IČO seznam tvého watchlistu
- Historii dotazů (audit log dle čl. 8)
- Stripe payment ID (pokud platíš)
- API tokeny (hashované)

Účel: provoz služby. Právní základ: smlouva (čl. 6 odst. 1 b) GDPR).

**Můžeš kdykoli požádat o:** export, opravu nebo smazání tvých dat. Napiš na milospospisil68@gmail.com. Lhůta: 30 dní.

Detail v Privacy Policy (`/privacy.html`).

## 6. Údaje o třetích osobách

Služba zobrazuje údaje o **fyzických osobách v rolích statutárů, společníků a skutečných majitelů** (jméno, datum narození, adresa). Tato data pocházejí z veřejných rejstříků kde mají zákonný základ ke zveřejnění (z. č. 304/2013 Sb. — veřejný rejstřík, z. č. 37/2021 Sb. — UBO).

Používáš-li tato data, **jsi sám odpovědný** za soulad s GDPR (zejména omezení účelu, právní základ tvého zpracování, retention). Provozovatel je **správce** vůči vlastní službě, **zpracovatel** v rolích kde tě obsluhuje.

## 7. Změny dat z veřejných zdrojů

- Data zobrazujeme tak, jak je publikují primární zdroje
- **Nemáme oprávnění** je měnit nebo opravovat
- Pokud najdeš chybu, **kontaktuj primární zdroj**:
  - ARES: ares.gov.cz
  - Veřejný rejstřík: justice.cz
  - ÚPV: upv.gov.cz
  - atd.

## 8. Audit log

Z důvodů AML compliance a bezpečnosti **logujeme každý dotaz na konkrétní IČO** (kdy, odkud IP, jaký IČO). Logy uchováváme **3 roky** podle § 16 AML zákona.

Logy se nezveřejňují ani neprodávají třetím stranám. Slouží jen pro:
- Vyšetřování zneužití (rate limit abuse, scraping)
- Compliance s AML reporting povinnostmi (na vyžádání FAÚ)
- Soudní/policejní vyžádání podle zákona

## 9. Dostupnost

- Free tier: **best-effort**, žádné SLA
- Pro tier: 99 % měsíčně (pokud bude spuštěn)
- Enterprise: smluvní SLA

Plánované odstávky oznamujeme v patičce webu min. 24 h předem (pokud to umožní okolnosti).

## 10. Omezení odpovědnosti

- **Nepřebíráme odpovědnost** za škodu způsobenou rozhodnutím na základě dat ze služby
- Maximální výše náhrady škody je **omezena na výši zaplaceného předplatného za posledních 12 měsíců** (pro Free tier = 0 Kč)
- Vyloučení neplatí pro úmyslné nebo hrubě nedbalé jednání podle § 2898 občanského zákoníku

## 11. Ukončení

- Můžeš kdykoli přestat službu používat
- Pro Pro tier: výpověď ke konci aktuálního zúčtovacího období
- Při hrubém porušení (čl. 4) ukončíme přístup okamžitě

## 12. Změny podmínek

- Aktualizujeme tyto podmínky podle potřeby
- Změny oznamujeme **30 dní předem** na webu a e-mailem (pokud máš účet)
- Pokud nesouhlasíš, můžeš službu opustit. Pokračování v používání = souhlas s novou verzí.

## 13. Licence

- Kód: **AGPL-3.0-or-later** (viz [LICENSE](../LICENSE))
- Brand „icovazby" + logo: chráněno ochrannou známkou (registrace v procesu)
- Data: licence dle primárních zdrojů (viz [zdroje dat](../README.md#zdroje-dat))

## 14. Rozhodné právo + spory

- Smlouva se řídí **právem České republiky**
- Pro spory je věcně příslušný obecný soud ČR podle sídla provozovatele (Praha)
- Spotřebitel může využít **ČOI** (coi.cz) pro mimosoudní řešení sporu

## 15. Kontakt

SimpleSolar s.r.o.
IČO: 07315520
Sídlo: Regnerova 1102, Mladá Boleslav III, 293 01 Mladá Boleslav
E-mail: info@simplesolar.cz
Web: https://icovazby.cz

---

**Aktuální verze:** 1.1 (2026-06-09 — provozovatel SimpleSolar s.r.o. místo FO).
Verzování: každá změna dostane nové číslo + datum, předchozí verze archivovány v Git historii.
