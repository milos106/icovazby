# VR Proxy — Cloudflare Worker

Worker, který proxyuje volání na `verejnerejstriky.msp.gov.cz`. Slouží k obejití
IP blokace cloud providerů (MSP blokuje Hetzner; Cloudflare edge IP zatím ne).

## Co dělá

- Backend (icovazby na Hetzner) zavolá `https://vr-proxy.tvuj-subdomain.workers.dev/api/rejstriky/navrhy?hledanyText=...`
- Worker pošle ten samý request na `https://verejnerejstriky.msp.gov.cz/api/rejstriky/navrhy?...` z CF edge
- Vrátí JSON 1:1
- Cache 5 min na CF edge (méně zátěž MSP serverům + nižší latence)

## Bezpečnost

- Pouze `GET` na cesty `/api/rejstriky/*` (proxy NENÍ open relay)
- Vyžaduje header `X-Proxy-Token` matching `PROXY_TOKEN` secret
- Bez tokenu → 401

## Deploy přes Cloudflare Dashboard (žádný CLI)

### 1. Vytvoř Worker

1. Přihlas se na **https://dash.cloudflare.com**
2. V levém menu klikni **Workers & Pages** → **Create application** → **Create Worker**
3. **Name**: `vr-proxy` (subdoména bude `vr-proxy.tvuj-account.workers.dev`)
4. Klikni **Deploy** (s default Hello World — nahradíme za chvíli)

### 2. Nahraj kód

1. Po deployi klikni **Edit code** (vpravo nahoře)
2. V editoru SMAŽ vše a zkopíruj obsah `worker.js` z tohoto adresáře
3. Klikni **Deploy** (vpravo nahoře v editoru)

### 3. Nastav PROXY_TOKEN secret

1. Vrať se zpět na detail Workeru (šipka vlevo nahoře)
2. Záložka **Settings** → **Variables and Secrets**
3. **Add variable** → typ **Secret** → name `PROXY_TOKEN`, value libovolný náhodný řetězec
   (např. `openssl rand -hex 32` v terminálu — vygeneruje 64 znaků)
4. **Save and deploy**

> Stejný token musíš dát do `.env` na Hetzner serveru jako `VR_PROXY_TOKEN`.

### 4. (Volitelné) Vlastní subdoména

Default `vr-proxy.tvuj-account.workers.dev` funguje hned. Pokud chceš `vr-proxy.icovazby.cz`:

1. V Dashboard pro Worker → **Settings** → **Triggers** → **Add Custom Domain**
2. Zadej `vr-proxy.icovazby.cz` → CF automaticky přidá CNAME do DNS

## Konfigurace icovazby backendu

V `/opt/icovazby/.env` na Hetzner serveru přidej:

```bash
VR_PROXY_URL=https://vr-proxy.tvuj-account.workers.dev
VR_PROXY_TOKEN=<stejný token jaký jsi zadal do Workeru>
```

Restart:

```bash
ssh root@10.7.0.1 systemctl restart icovazby
```

## Test

Z Hetzner serveru (kde jinak dostává 403):

```bash
ssh root@10.7.0.1
curl -H "X-Proxy-Token: <token>" \
  "https://vr-proxy.tvuj-account.workers.dev/api/rejstriky/navrhy?hledanyText=26185610&rejstriky=VR"
```

Pokud Worker funguje, vrátí JSON. Pak otestuj přes icovazby API:

```bash
curl https://icovazby.cz/api/vr/26185610
```

Mělo by vrátit reálná data VR (statutární orgán, akcionář, atd.) namísto
`{"ok":false,"reason":"vr_blocked",...}`.

## Limity (Free plán)

- 100 000 requestů/den
- 10 ms CPU time / request (proxy nepoužívá CPU, jen network — bohatě stačí)
- Žádný storage poplatek

Pokud bys jednou překonal free limit, paid tier $5/měs dá 10M requestů. Pro
icovazby.cz reálný použití (desítky/stovky DD denně) je 100k/den nedosažitelný.

## Rollback

Pokud se Worker rozbije, prostě v `.env` smaž `VR_PROXY_URL` a restart — backend
spadne na přímé volání MSP (403 → graceful degradation s fallback hláškou v UI).
Žádné data loss, žádný downtime.
