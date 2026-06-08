<!-- Než pošleš PR, mrkni do CONTRIBUTING.md. Otevři issue dřív než píšeš kód, pokud změna není triviální. -->

## Co měníš

<!-- 1-2 věty, focus na "proč", ne "co" — diff to ukáže -->

## Souvisí s issue

<!-- "Fixes #123" nebo "Refs #45" -->

## Jak to otestovat

<!-- Konkrétní kroky, nejlépe s IČO nebo curl příkazem -->

## Kontrolní seznam

- [ ] `npm test` prochází
- [ ] `npm run build` prochází
- [ ] `npx tsc --noEmit` bez chyb
- [ ] Pokud nové TS soubory: mají SPDX hlavičku
- [ ] Pokud nové env vars: doplněny v `.env.example` a README
- [ ] Pokud nové API endpoints: dokumentovány v README
- [ ] Commit je signed-off (`git commit -s`) per DCO
