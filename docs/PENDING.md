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

## Možné další features čekající

Žádné aktuálně. F4 (Katastr) a F1–F8 dokončené nebo dokumentované.
