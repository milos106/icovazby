/**
 * Per-request token context pro Hlídač státu API.
 *
 * Pozadí: aplikace může běžet jako multi-user webová služba, kde každý
 * uživatel má vlastní HS token. Bez per-request kontextu by všichni
 * sdíleli token z `HLIDAC_API_TOKEN` env proměnné a rate limit by je
 * vzájemně shazoval.
 *
 * Mechanika: Fastify `onRequest` hook v server.ts extrahuje hlavičku
 * `X-Hlidac-Token` a uloží ji do AsyncLocalStorage přes `enterWith()`.
 * Kontext platí pro celou async stack následujícího request handlerů.
 * `getToken()` v hlidacstatu/client.ts pak nejdřív čte z ALS a teprve
 * jako fallback z env.
 *
 * Bezpečnost: token od uživatele nikam neukládáme, jen ho přepošleme
 * upstream. Server log token nikdy nezobrazuje (pouze délku znaků).
 */

import { AsyncLocalStorage } from "node:async_hooks";

export const hsTokenContext = new AsyncLocalStorage<string>();
