# AI souhrn — 4-fázová strategie monetizace bez dotování ze svého

**Verze:** 1.0
**Datum:** 2026-06-10
**Účel:** Zachovat AI feature v produktu, ale nedotovat ji ze své kapsy v žádné fázi. Postupně se učit od uživatelů, validovat ochotu zaplatit, pak monetizovat.

## Klíčový princip

> **Nikdy nedotuj AI ze svého. Před přechodem do další fáze MUSÍ být měřitelný signál.**

Bez signálu nepokračuj — ušetříš si práci na features kterým chybí klienti.

---

## 🔵 Fáze 1 — BYO klíč + skrytá AI sekce (TEĎ)

**Účel:** Feature je v produktu, ale defaultně neviditelná. Tvůj náklad = 0 Kč pro běžné návštěvníky.

### Technicky

1. **AI karta defaultně skrytá v UI** — žádný náhodný návštěvník ji nevidí
2. **Settings popover dostane nové pole** „Anthropic API klíč"
3. **Backend logika:**
   - Request s hlavičkou `X-Anthropic-Key` → použije uživatelův klíč
   - Bez hlavičky → fallback na server-side env klíč (jen pro admina, ne pro public)
4. **AI karta se zobrazí jen pokud:**
   - User má vlastní klíč v Settings, NEBO
   - Má speciální „demo" localStorage flag (pro tebe + 2-3 sdílené demos)

### User journey

**Anonymní návštěvník (99 % visits):**
- Otevře profil firmy → vidí standardní karty (ARES, DPH, UBO, dotace, ÚPV...)
- AI souhrn **neexistuje** v UI
- Bez friction, bez „odemkni za peníze"
- Tvoje cena: **0 Kč** ✓

**Klient se zájmem o AI:**
- Settings popover → klikne „Anthropic API klíč"
- Tooltip: „AI souhrn vyžaduje vlastní účet u Anthropic. Zaregistruj se zdarma → $5 trial = ~600 souhrnů. Klíč vlož sem."
- Po uložení → AI karta se objeví v profilech
- Tvoje cena: **0 Kč.** Anthropic účtuje user-ovi.

**Ty:**
- Server admin klíč v `.env` (už máš)
- Vlož si vlastní klíč do Settings → vidíš AI v testech, billing přes Anthropic účet

### Cena pro tebe

| | |
|---|---|
| Provoz pro public | **0 Kč** |
| Tvoje testování | ~30 hal × 50 testů/měs ≈ **15 Kč/měs** |
| Anthropic free trial $5 | ~600 testů ≈ pár měsíců zdarma |

### Co se naučíš

1. **Kolik uživatelů přinese vlastní klíč** → demand
2. **Bounce rate u Settings popoveru** → friction
3. **Které firmy testovači generují AI souhrny pro** → market signal

### Risk

- ⚠️ BYO Anthropic key je 3-min setup → odpadnou non-tech klienti
- ✅ Ale kdo projde friction = qualified lead

### Signál pro přechod do Fáze 2

> 3+ lidé z networku řekli „chci to vyzkoušet, ale BYO Anthropic je friction"

---

## 🟡 Fáze 2 — Tokeny pro vybrané betatestery

**Účel:** Identifikované leads dostanou access bez BYO friction. Ty platíš za jejich testy, ale máš kontrolu (limit per token).

### Technicky

1. Server vygeneruje sadu tokenů: `AI-2026-7H3K`, `AI-2026-X9PM`, ...
2. SQLite tabulka `ai_access_tokens` (token, owner_email, created_at, used_count, last_used_at)
3. Settings popover dostane druhé pole „Access token" (alternativa k API klíči)
4. Backend logika: user → AI summary s `X-AI-Token` header → server ověří v DB → use_count++ → použije TVŮJ Anthropic klíč
5. Limit per token: např. 20 souhrnů/měsíc

### User journey

E-mail klientovi:
> Ahoj, vyrobil jsem AI prověrku českých firem. Tady tvůj testovací token: `AI-2026-7H3K`. Vlož ho v Settings na icovazby.cz a budeš mít 20 testů zdarma. Dej vědět co si o tom myslíš.

### Cena pro tebe

| | |
|---|---|
| 5 testerů × 20 souhrnů × 30 hal | **~30 Kč za celé bétu** |

Velmi levný user research.

### Co se naučíš

1. Kdo přijal pozvánku = engaged people
2. Kdo prošel celých 20 souhrnů = silní enthusiasti
3. Jaké firmy testovali → cílovka
4. Feedback po e-mailu: „Zaplatil bys 49 Kč / souhrn?"

### Risk

- ⚠️ Limit 20 / tester → frustrace u silných power users
- ⚠️ Token = security through obscurity (snadno se sdílí) — OK pro bétu, později Stripe login

### Signál pro přechod do Fáze 3

> 2+ testeři řekli „zaplatím za to"

---

## 🟠 Fáze 3 — Stripe pay-per-summary

**Účel:** Reálná monetizace. Klient zaplatí 49 Kč za AI souhrn s PDF.

### Technicky

1. **Stripe Checkout integration**
   - Klik „Generovat AI souhrn" → Stripe popup (49 Kč)
   - Po platbě → webhook → success token na frontend
   - Token jednorázový, server ověří → vygeneruje AI summary + uloží do cache 7 dní
   - PDF prověrka s AI souhrnem inline → ke stažení

2. **49 Kč rozdělení:**
   - 30 hal Anthropic náklad
   - ~3 Kč Stripe fee (2.5 % + 1 Kč fix)
   - 21 % DPH (~8.50 Kč pro SimpleSolar)
   - **Marže ~37 Kč na transakci**

### User journey

Klient otevře profil firmy → vidí kartu „🤖 AI souhrn" s ukázkou (paywall blur effect):
> **Plný AI souhrn s rizikovou analýzou — 49 Kč včetně PDF**
> [Zaplatit a vygenerovat →]

Klik → Stripe Checkout → karta → potvrzení → 5–10 s loading → hotový souhrn + PDF.

### Cena pro tebe

| | |
|---|---|
| Setup | **0 Kč** (Stripe pay-as-you-go) |
| Náklad/transakce | ~33 Kč |
| Příjem/transakce | 49 Kč |
| Marže | **37 Kč × N transakcí** |
| Break-even | první transakce |
| Po 10 transakcích/měs | **370 Kč/měs profit** (pokrývá Hukot hosting) |

### Co se naučíš

1. **Conversion rate** — ze 100 visitorů paywallu, kolik zaplatí (typický B2B SaaS: 1–3 %)
2. **Repeat customers** — kdo zaplatí podruhé = product-market fit signál
3. **Cena tolerance** — pokud nikdo neplatí 49 Kč → sníž na 29 Kč; pokud platí lehce → zkus 99 Kč
4. **MRR signál** pro Pro tier

### Risk

- ⚠️ Stripe setup (~30 min)
- ⚠️ Friction nutí klienta zaplatit pokaždé → frustrace u opakovaných userů (řešením je Pro tier)
- ⚠️ DPH 21 % faktury na 49 Kč transakce = admin pro účetní

### Signál pro přechod do Fáze 4

> 5+ klientů opakovaně platí pay-per-summary

---

## 🟢 Fáze 4 — Pro subscription tier

**Účel:** Subscription = předvídatelný MRR + odstranění friction pro power users.

### Technicky

1. **Stripe Subscription** „Pro tier — 390 Kč/měs"
2. User registrace s e-mailem + heslem
3. **Server-managed Anthropic quota** — Pro tier uživatelé jdou přes TVŮJ klíč
   - Limit per user: např. 100 souhrnů/měs (typical use ~20–30)
   - Nad limit → upsell na Enterprise nebo notice
4. **Multi-tenant DB schema** rozšíření (`users`, `subscriptions`, `usage_logs`)

### User journey

1. Klient → „Pro tier 390 Kč/měs" → registrace
2. Stripe subscription setup → 30denní free trial
3. Po trialu automatická fakturace
4. **Unlimited AI** souhrny + PDF + watchlist + e-mail alerty + bulk DD
5. **Bez friction** — vše v ceně

### Cena pro tebe

| | |
|---|---|
| Stripe sub fee | ~13 Kč/měs/sub |
| Anthropic per sub | ~30 hal × 30 souhrnů = ~9 Kč/měs |
| Náklad total/sub | ~22 Kč/měs |
| Příjem | 390 Kč/měs |
| Marže | **~368 Kč × N klientů** |
| Break-even hosting + Anthropic | od 1 platícího |

### Co se naučíš

1. **Churn rate** — kolik klientů ruší po měsíci
2. **ARPU** — průměrný revenue per user
3. **LTV** — lifetime value (typicky 12–24 měsíců pro B2B SaaS)
4. **Power users** — kdo > 50 souhrnů/měs = Enterprise upsell candidate

### Risk

- ⚠️ Komplexita — multi-tenant, billing, support, churn
- ⚠️ Závazek — 390 Kč/měs klient čeká support a uptime
- ⚠️ SLA — Pro tier potřebuje >99 % uptime → monitoring + on-call

---

## 🎬 Realistický harmonogram

| Týden | Fáze | Co děláš |
|---|---|---|
| Tento týden | Fáze 1 (BYO + skrýt) | 1 h práce |
| Týden 2–3 | Identifikuj 3–5 betatesterů z networku | Networking |
| Týden 4 | Fáze 2 (tokeny) | 30 min + posílání emailů |
| Týden 5–8 | Sbírej feedback, iteruj | User research |
| Měsíc 2–3 | Fáze 3 (Stripe) | 1 den implementace |
| Měsíc 4+ | Validuj conversion rate | Marketing experimenty |
| Měsíc 6+ | Fáze 4 (subscription) | 2 dny implementace |

---

## 💎 Disciplinovaný checkpoint před každou fází

**Konkrétní měřitelné signály:**

- **Fáze 1 → 2:** „3+ lidé z networku řekli `chci to vyzkoušet`"
- **Fáze 2 → 3:** „2+ testeři řekli `zaplatím za to`"
- **Fáze 3 → 4:** „5+ klientů opakovaně platí pay-per-summary"

Bez signálu **nepokračuj.**

---

## Status

| Fáze | Stav | Datum |
|---|---|---|
| Fáze 1 | ⏳ implementace | 2026-06-10 |
| Fáze 2 | 📅 čeká signál | — |
| Fáze 3 | 📅 čeká signál | — |
| Fáze 4 | 📅 čeká signál | — |

Pointer v memory: `~/.claude/projects/-home-milos-work-ares-mcp/memory/project_ai_monetization_phases.md`
