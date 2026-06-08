# Contributing to IČO vazby

Díky za zájem přispět! Tento projekt je AGPL-3.0 OSS, primárně jednoautorský. PR jsou vítány — drž se pravidel níže a iterace bude svižná.

## Než pošleš PR

1. **Otevři issue dřív, než píšeš kód** na cokoli většího než typo. Vyhneme se tomu, že napíšeš featuru, kterou nechci vmrgovat.
2. **Žádné velké refaktory bez domluvy.** Kód má svůj tvar; měň jednu věc po druhé.
3. **Žádné nové runtime závislosti** bez odůvodnění. Cíl je vanilla frontend + lean backend.

## Lokální setup

```sh
git clone <fork>
cd icovazby
npm install
cp .env.example .env
npm run dev       # watch mode
npm test          # vitest
```

## Code style

- **TypeScript strict.** Žádné `any` v novém kódu (use `unknown` + narrow).
- **Formatter:** Biome (`npx biome format --write src/`).
- **Comments:** popisuj WHY, ne WHAT. Žádné JSDoc na trivia.
- **SPDX hlavička:** každý nový `.ts` musí začínat `// SPDX-License-Identifier: AGPL-3.0-or-later`.

## Co PR musí splnit

- [ ] Build prochází: `npm run build`
- [ ] Testy prochází: `npm test`
- [ ] Žádné nové ESLint/Biome warningy
- [ ] Pokud měníš API, doplň README endpoint tabulku
- [ ] Pokud měníš env vars, doplň `.env.example` i README

## Co rozhodně nebrat

- **Změny licence.** AGPL-3.0 zůstává.
- **Přidávání AI/LLM vrstvy.** Projekt je deterministická agregace registrů; AI je out of scope.
- **Sledování uživatelů.** Žádný analytics, žádné cookies, žádné trackery — to je explicitní volba.
- **Vendor lock-in.** Cokoli, co tě naváže na konkrétní cloud (AWS-only, GCP-only) — refuse.

## Inspirace pro contributions

Dobré low-hanging tématy, kde by PR pomohlo:
- Další invoicing exportéry (Money S3, Helios, …)
- Doplnění CZ-NACE kódů s lidskými popisky (`public/data/cznace.json`)
- Lepší error messages přes UI
- Lokalizace do EN
- Postgres adapter pro alerty (aktuálně JSON file)
- Redis adapter pro cache (in-memory `src/cache.ts`)
- Unit testy na holding discover (aktuálně covered jen integration)

Velké tématy chce vždy zacházet přes issue:
- Auth + multi-tenant (SaaS verze)
- Mobile native app
- Změna datového stack-u

## Reportování bugů

1. Verze (`git rev-parse HEAD` nebo tag).
2. Kroky reprodukce — pokud možno s konkrétním IČO.
3. Očekávané vs. skutečné chování.
4. Server log (`LOG_LEVEL=debug`) pokud relevantní.

## Sign-off

Každý commit musí být **Signed-off-by** (= souhlasím s [DCO](https://developercertificate.org/)):

```sh
git commit -s -m "fix: …"
```

Tím prohlašuješ, že tvůj příspěvek máš právo licencovat pod AGPL-3.0.

## Komerční licence

Pokud chceš použít kód v projektu, kde AGPL-3.0 nestačí (např. uzavřená SaaS), kontaktuj maintainera pro dual licensing.
