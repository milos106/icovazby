# Zásady ochrany osobních údajů

Webová aplikace **IČO vazby** (icovazby.cz) · platné od 2026-06-08

## 1. Kdo je správce údajů

Provozovatel webu icovazby.cz a správce osobních údajů ve smyslu nařízení (EU) 2016/679 (GDPR):

- **SimpleSolar s.r.o.**
- IČO: 07315520
- DIČ: CZ07315520 (plátce DPH)
- Sídlo: Regnerova 1102, Mladá Boleslav III, 293 01 Mladá Boleslav
- zapsaná v obchodním rejstříku vedeném Krajským soudem v Praze
- jednatel: Ing. Miloš Pospíšil
- kontakt pro účely GDPR a žádosti subjektů údajů: [info@simplesolar.cz](mailto:info@simplesolar.cz)

## 2. Jaká data zpracováváme

### 2.1 Data o firmách a fyzických osobách (jednatelích)

Aplikace agreguje veřejně dostupná data o českých obchodních subjektech ze státních registrů:

- ARES (MFČR) — obchodní jméno, IČO, sídlo, NACE, DPH stav
- Veřejný rejstřík (MSp ČR) — statutární orgán, akcionáři, obchodní listiny
- Hlídač státu — veřejné zakázky, dotace, skuteční majitelé, insolvenční rejstřík
- EU sanctions list, ČNB JERRS, ADIS DPH
- ÚPV ochranné známky (otevřená data ST.96)

Tato data **jsou veřejně publikovaná** na základě právních předpisů (§ 304/2013 Sb. o veřejných rejstřících, § 96a z. o DPH, § 419 z. č. 182/2006 Sb. atd.). Obsahují **jména, příjmení a data narození** jednatelů a skutečných majitelů.

> ⚠ **Pokud výsledky prověrky stahujete, ukládáte nebo dále zpracováváte** (např. jako součást vlastní compliance dokumentace, faktury, archivace), stáváte se **vy správcem osobních údajů** a máte vlastní povinnosti podle GDPR (informační povinnost vůči subjektům údajů, doba uchování, právní základ zpracování).

### 2.2 Data o uživatelích webu

Při běžném používání webu zpracováváme:

- **IP adresa + User-Agent** — pouze v logu HTTP serveru a Cloudflare CDN pro účely bezpečnosti a anti-DDoS. Uchováváme po dobu 7 dnů. Právní základ: čl. 6(1)(f) GDPR (oprávněný zájem na zabezpečení služby).
- **localStorage v prohlížeči** — historie posledních 10 hledání, oblíbené záložky, nastavení tmavého režimu, váš HS API token (pokud jste ho zadal). Tyto údaje **neopouštějí váš prohlížeč** — server je nevidí.
- **E-mail (pokud aktivujete alerty)** — pokud se přihlásíte k e-mail alertům o změně statutárního orgánu, insolvence apod., váš e-mail ukládáme do souboru `data/subscriptions.json` na serveru. Použijeme ho výhradně pro odesílání notifikací o změnách u zvoleného IČO. Právní základ: čl. 6(1)(a) GDPR (souhlas — dvojí opt-in přes ověřovací odkaz). Máte kdykoli právo na výmaz přes odhlašovací link.

### 2.3 Server-side cache (sdílená napříč uživateli)

Pro zrychlení odezvy a šetření kvóty veřejných API ukládáme dočasně v paměti serveru (RAM, LRU cache, TTL 24 h) výsledky prověrek IČO. Tyto výsledky obsahují jména a data narození jednatelů (= veřejně publikovaná data ze státních registrů, viz 2.1). Cache **není sdílena s třetími stranami**, slouží výhradně pro rychlejší obsluhu opakovaných dotazů a vyprší samočinně po restartu serveru nebo 24 hodinách.

### 2.4 Lokální index osoba→firmy a SQLite databáze

Aplikace si pro funkci „Vazby osoby" udržuje na disku (SQLite databáze `data/persons-index.sqlite`) index spojení jméno + datum narození → seznam firem, ve kterých daná osoba figuruje jako jednatel. Tento index vzniká postupně z dat veřejných rejstříků (viz 2.1) a slouží k rychlejšímu nalezení vazeb mezi firmami.

Stejná databáze obsahuje i lokální index ochranných známek z ÚPV otevřených dat (`upv_trademarks`) pro rychlou DD prověrku. Index neobsahuje IČO přihlašovatelů (ÚPV ho neposkytuje), pouze jména právnických osob a anonymizovaná data fyzických.

## 3. Co NEzpracováváme

- ❌ Body HTTP požadavků (server logger Pino default nezapisuje payload)
- ❌ Cookies pro tracking, analytics ani marketing — aplikace nepoužívá žádné cookies
- ❌ Žádné third-party tracking nástroje (Google Analytics, Facebook Pixel, atd.)
- ❌ Trvalé úložiště prověrek konkrétních uživatelů (server je stateless v RAM cache)

## 4. Komu data předáváme

Žádným třetím stranám pro účely marketingu, reklamy ani profilování. Jediní zpracovatelé jsou techničtí poskytovatelé infrastruktury:

- **Hetzner Online GmbH** (Německo) — hosting serveru
- **Cloudflare, Inc.** (USA, EU-US Data Privacy Framework) — CDN, DDoS protection, TLS terminace
- **Hukot.net** (ČR) — DNS hosting a e-mailové schránky domény

Při dotazu na veřejné registry (ARES, Hlídač státu, EU sanctions, ČNB JERRS, verejnerejstriky.msp.gov.cz, ÚPV) odesíláme dotaz ze IP našeho serveru — tito poskytovatelé v rámci své činnosti zaznamenávají naše IP, nikoli vaši.

## 5. Audit log (AML compliance)

Pro účely AML compliance a bezpečnosti **logujeme každý dotaz na konkrétní IČO** (kdy, odkud IP, jaký IČO, User-Agent). Logy uchováváme **3 roky** podle § 16 AML zákona. Logy se nezveřejňují ani neprodávají třetím stranám. Slouží jen pro:

- Vyšetřování zneužití (rate limit abuse, scraping)
- Compliance s AML reporting povinnostmi (na vyžádání FAÚ)
- Soudní/policejní vyžádání podle zákona

## 6. Jak dlouho data uchováváme

- HTTP/Cloudflare logy: 7 dnů
- RAM cache (DD reporty): 24 h
- persons_index na disku: trvale (slouží k rostoucí kvalitě vazeb)
- E-mail subscribery: do doby, dokud sám neudělíte odhlášení
- Audit log: 3 roky (AML compliance)
- localStorage v prohlížeči: kontrolujete sám/sama (lze smazat v prohlížeči kdykoli)

## 7. Vaše práva

Jako subjekt údajů máte podle GDPR právo:

- požádat o přístup k vašim osobním údajům, které zpracováváme
- požádat o opravu nepřesných údajů
- požádat o výmaz („právo být zapomenut")
- požádat o omezení zpracování
- vznést námitku proti zpracování
- požádat o přenositelnost údajů
- odvolat souhlas (u e-mail alertů kdykoli přes odhlašovací link)
- podat stížnost u [Úřadu pro ochranu osobních údajů](https://www.uoou.cz/)

Žádosti zasílejte na [info@simplesolar.cz](mailto:info@simplesolar.cz). Odpovíme do 30 dnů.

## 8. Bezpečnost

Web běží na HTTPS s validním TLS certifikátem (Cloudflare). Server používá rate-limiting, sandboxing přes systemd, OOM-cap a deny-by-default firewall. Kompletní bezpečnostní politika je publikována na [GitHub SECURITY.md](https://github.com/milos106/icovazby/blob/main/SECURITY.md).

## 9. Open Source

Zdrojový kód aplikace je veřejně publikovaný pod licencí [GNU AGPL-3.0](https://www.gnu.org/licenses/agpl-3.0.html) na [github.com/milos106/icovazby](https://github.com/milos106/icovazby). Komukoli je k dispozici audit toho, jak aplikace skutečně zpracovává vaše údaje.

## 10. Změny zásad

Tyto zásady mohou být v budoucnu doplněny. Datum poslední revize je uvedeno nahoře. V případě podstatných změn (např. změna účelu zpracování, předávání novým zpracovatelům) budou stávající e-mail subscribery informováni e-mailem.
