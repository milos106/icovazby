import { defineConfig } from "@playwright/test";

// E2E testy běží proti ŽIVÉMU webu (kde je nasazený kód). Mapa propojení se
// řídí stejnými custom eventy jako UI, takže test = věrná reprodukce klikání.
export default defineConfig({
  testDir: "./e2e",
  timeout: 90_000,
  fullyParallel: false,
  retries: 0,
  use: { headless: true },
});
