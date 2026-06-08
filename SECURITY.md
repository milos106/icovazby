# Security Policy

## Hlášení zranitelností

Pokud najdeš zranitelnost, **neotevírej veřejný GitHub issue**. Místo toho:

1. Pošli **soukromý security advisory** přes GitHub: Repo → Security → Report a vulnerability.
2. Nebo e-mail na maintainera (kontakt v `package.json` author field).

V hlášení uveď:
- Krátký popis (1 věta).
- Dopad (kdo je ohrožen, jak vážně).
- Krok-za-krokem reprodukce.
- Verze / commit (`git rev-parse HEAD`).
- Volitelně: návrh oprav.

## Odpověď

- **Potvrzení přijetí: do 72 hodin.**
- **Triage + první fix nebo plán: do 7 dnů.**
- **Veřejné zveřejnění: po vydání opravy, koordinovaně.**

Tento projekt je jednoautorský; nemůžu garantovat 24/7 reakci, ale udělám co můžu.

## Scope

In scope:
- Vlastní kód (`src/`, `public/`).
- Konfigurační default hodnoty co můžou způsobit data leak.
- Dependency vulnerabilities, které máme přímo my (ne tranzitivně).

Out of scope:
- Známé limity ARES/HS/VR upstreams.
- DoS přes opakované volání (mitigace je rate-limiting na tvém reverse proxy, viz README).
- Self-XSS vyžadující ovládnutí browseru oběti.

## Bezpečnostní zaměření

Kód byl psán s ohledem na:

- **Žádné secrets v repu** — `.env` je v `.gitignore`, `.env.example` má jen prázdné placeholdery.
- **Rate limiting** — per-IP + per-route, defaultně zapnuto.
- **Per-request HS token přes `X-Hlidac-Token` hlavičku** — token nepouštíme do logu.
- **Input validation** — všechny user inputs přes zod schema.
- **No `eval`, no `Function(...)` constructor**.
- **No request body logging** — Pino default vynechává body.
- **CSRF: stateless, GET endpointy idempotentní** — POST endpointy nemění auth state, alerts unsubscribe vyžaduje znalost ID.
- **HTML escape** v `src/report/html.ts` (PDF report).

## Známé tradeoffs (známé, nevadí mi)

- **In-memory rate-limit** — pro single instance OK; pro multi-instance nasazení použij Redis backend (`@fastify/rate-limit` to umí).
- **Subscriptions JSON file** — single-writer; pro produkční SaaS nasazení migrace na Postgres nutná.
- **Žádný CSP header** — front je vanilla HTML s inline Alpine/Mermaid; CSP by chtělo nonce strategie. Patch welcome.
- **Žádná 2FA na alerts subscribe** — e-mailová verifikace je jediná zábrana proti spamu cizích adres.

## GDPR-related

Viz README → sekce GDPR. Aplikace neukládá DD výsledky perzistentně; jediná osobně-identifikovatelná data v úložišti jsou e-maily subscribers v `data/subscriptions.json`. Subscriber má kdykoli právo na výmaz (`DELETE /api/alerts/:id`).
