// SPDX-License-Identifier: AGPL-3.0-or-later
// Mapování číselných kódů právní formy (ARES číselník) na čitelný popis.
// Použito v HTML/MD/JSON výstupech firmy. Neznámý kód → vrátí se beze změny.

const LEGAL_FORMS: Record<string, string> = {
  "101": "OSVČ (živnostník)",
  "111": "Veřejná obchodní společnost (v.o.s.)",
  "112": "Společnost s ručením omezeným (s.r.o.)",
  "113": "Komanditní společnost (k.s.)",
  "121": "Akciová společnost (a.s.)",
  "141": "Obecně prospěšná společnost (o.p.s.)",
  "145": "Společenství vlastníků jednotek (SVJ)",
  "205": "Družstvo",
  "301": "Státní podnik (s.p.)",
  "325": "Organizační složka státu",
  "331": "Příspěvková organizace",
  "421": "Odštěpný závod zahraniční právnické osoby",
  "706": "Spolek",
  "736": "Pobočný spolek",
  "751": "Zájmové sdružení právnických osob",
  "801": "Obec",
};

/** Čitelný popis právní formy. Když kód neznáme (nebo už je to text), vrátí vstup. */
export function legalFormLabel(code: string | null | undefined): string | null {
  if (!code) return code ?? null;
  return LEGAL_FORMS[String(code).trim()] ?? code;
}
