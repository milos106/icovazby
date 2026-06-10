# icovazby embed widget

Vlož DD prověrku českých firem na jakýkoli web 1 řádkem:

```html
<script src="https://icovazby.cz/embed.js"></script>
<icovazby-card ico="26185610"></icovazby-card>
```

## Features

- ✅ **0 setup** — žádný API klíč, žádná konfigurace
- ✅ **Shadow DOM** — vlastní styly se nezasahují do hostujícího webu
- ✅ **Auto dark mode** — respektuje `prefers-color-scheme`
- ✅ **Lightweight** — < 5 kB minified, žádné dependencies
- ✅ **AGPL-3.0** — open source pod stejnou licencí jako celý projekt

## Co widget zobrazí

| Element | Příklad |
|---|---|
| Obchodní jméno | AGROFERT, a.s. |
| IČO | 26185610 |
| Risk badge | 🟢 Risk nízký / 🟡 střední / 🔴 vysoký |
| DPH stav | DPH plátce / Neplátce DPH |
| Insolvence flag | ⚠️ Insolvence (pokud platí) |
| Počet statutárů | 12 statutářů |
| Risk findings (top 3) | • PEP detekce • Velký holding • ... |
| CTA na plný profil | „Plný profil + holding mapa →" |

## Příklady použití

### Blog post o KYC

```html
<p>Než uzavřeš obchod, zkontroluj si protistranu:</p>
<icovazby-card ico="26185610"></icovazby-card>
<p>Risk red = nesmluvat. Risk green = OK.</p>
```

### Účetní e-commerce katalog (Fakturoid alternativa)

```html
<table>
  <tr>
    <td>26185610</td>
    <td>AGROFERT, a.s.</td>
    <td>
      <details>
        <summary>Quick check</summary>
        <icovazby-card ico="26185610"></icovazby-card>
      </details>
    </td>
  </tr>
</table>
```

### Server-side render (Next.js, Astro, atd.)

Widget je client-side custom element — nemusíš nic SSR-ovat. Stačí `<script>` tag v `<head>`.

```jsx
// next.js
<>
  <Script src="https://icovazby.cz/embed.js" strategy="afterInteractive" />
  <icovazby-card ico="26185610" />
</>
```

## Atributy

| Atribut | Povinný | Popis |
|---|---|---|
| `ico` | ✓ | 7–8místné IČO. Přední nuly se doplní automaticky. |

Plánujeme:
- `theme="light|dark|auto"` — explicit theme override
- `compact` — minimalistická verze bez findings list
- `lang="en|cs"` — angličtina labels

## Bezpečnost & privacy

- Widget volá `GET https://icovazby.cz/api/dd/{ico}` z prohlížeče návštěvníka
- **Žádné cookies** ani localStorage z embed.js
- Hostující stránka **netracukje** žádné user data přes nás
- IP adresa návštěvníka se zapíše do našeho audit logu (3 roky retence, AML compliance) — viz [PRIVACY.md](PRIVACY.md)

## Licence

AGPL-3.0-or-later. Pokud běžíš **modifikovanou** verzi embed.js na své doméně, máš povinnost zveřejnit zdrojový kód (§13). Pokud jen vložíš oficiální `<script src="https://icovazby.cz/embed.js">` na svůj web, tuto povinnost plníme my (icovazby.cz / GitHub source).

## Rate limit

- Free, žádný klíč, ale rate limit **60 req/min per IP**
- Pokud máš high-traffic web (> 100 widget loadů/min) → kontaktuj `info@simplesolar.cz` pro vyšší tier

## Showcase

Tvůj web embeds icovazby? Napiš nám — rádi tě zařadíme do seznamu partnerů.

---

**Verze:** 1.0 (2026-06-10) · Provozovatel: SimpleSolar s.r.o., IČO 07315520 · Kontakt: info@simplesolar.cz
