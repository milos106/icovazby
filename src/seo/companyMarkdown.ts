// Strojově čitelná Markdown varianta firmy pro AI agenty / answer-enginy (AEO).
// Nízko-tokenová, bez HTML balastu. Stejná veřejná data jako /firma HTML.

import { firmaPath } from "./companyPage.js";
import { legalFormLabel } from "./legalForm.js";

const BASE_URL = process.env.PUBLIC_BASE_URL ?? "https://icovazby.cz";

interface DdLike {
  ico: string;
  obchodniJmeno: string | null;
  risk: { level: "green" | "yellow" | "red"; findings: { level: string; message: string }[] };
  identification: {
    pravniForma?: string | null;
    datumVzniku?: string | null;
    datumZaniku?: string | null;
    sidloText?: string | null;
    czNace?: string[] | null;
  };
  vat: { platceDph: boolean; dic: string | null };
  statutary: {
    aktivniCount: number;
    clenove: { funkce?: string | null; jmeno?: string | null }[];
  };
  trade_licenses: { total: number; aktivni: number; predmety: string[] };
  insolvenci: { isInsolvent: boolean; hadHistory: boolean };
}

const RISK = { green: "🟢 nízké", yellow: "🟡 střední", red: "🔴 zvýšené" } as const;

export function renderCompanyMarkdown(r: DdLike): string {
  const name = r.obchodniJmeno ?? `IČO ${r.ico}`;
  const canonical = `${BASE_URL}${firmaPath(r.ico, r.obchodniJmeno)}`;
  const id = r.identification;

  const lines: string[] = [];
  lines.push(`# ${name}`);
  lines.push("");
  const head = [`**IČO:** ${r.ico}`];
  if (id.pravniForma) head.push(`**Právní forma:** ${legalFormLabel(id.pravniForma)}`);
  if (id.sidloText) head.push(`**Sídlo:** ${id.sidloText}`);
  lines.push(head.join(" · "));
  lines.push(`**Rizikové skóre:** ${RISK[r.risk.level]}`);
  lines.push("");

  if (r.risk.findings.length) {
    lines.push("## Zjištění");
    for (const f of r.risk.findings) {
      const icon = f.level === "red" ? "🚨" : f.level === "yellow" ? "⚠️" : "✅";
      lines.push(`- ${icon} ${f.message}`);
    }
    lines.push("");
  }

  lines.push("## Identifikace");
  if (id.datumVzniku) lines.push(`- Datum vzniku: ${id.datumVzniku}`);
  if (id.datumZaniku) lines.push(`- Datum zániku: ${id.datumZaniku}`);
  if (id.czNace?.length) lines.push(`- CZ-NACE: ${id.czNace.slice(0, 8).join(", ")}`);
  lines.push(`- DPH: ${r.vat.platceDph ? `plátce${r.vat.dic ? ` (DIČ ${r.vat.dic})` : ""}` : "neplátce (dle ARES)"}`);
  lines.push(
    `- Insolvence: ${
      r.insolvenci.isInsolvent
        ? "aktivní řízení/úpadek"
        : r.insolvenci.hadHistory
          ? "v minulosti probíhalo"
          : "bez záznamu"
    }`,
  );
  lines.push(`- Živnostenská oprávnění: ${r.trade_licenses.total} celkem, ${r.trade_licenses.aktivni} aktivních`);
  lines.push("");

  lines.push(`## Statutární orgán (${r.statutary.aktivniCount})`);
  const clenove = r.statutary.clenove.filter((m) => m.jmeno);
  if (clenove.length) {
    for (const m of clenove) lines.push(`- ${m.jmeno}${m.funkce ? ` — ${m.funkce}` : ""}`);
  } else {
    lines.push("- (bez aktivních záznamů)");
  }
  lines.push("");

  lines.push("---");
  lines.push("Zdroj: veřejné rejstříky — ARES (MF ČR, CC BY 4.0), Veřejný rejstřík (MSp ČR), ISIR, ADIS. Informativní, ne autoritativní pro právní účely.");
  lines.push(`Kanonický odkaz: ${canonical}`);
  lines.push(`Citace (pro AI, s měřením prokliku): ${canonical}?utm_source=ai`);
  lines.push("MCP pro agenty: https://ares-mcp.icovazby.cz/mcp");
  return lines.join("\n");
}
