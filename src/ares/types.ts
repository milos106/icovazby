/**
 * Minimal TypeScript types matching ARES v3 response shapes. ARES uses Czech
 * field names; we keep them verbatim so downstream consumers can correlate
 * with the official OpenAPI schema at
 * https://ares.gov.cz/ekonomicke-subjekty-v-be/rest/v3/api-docs.
 *
 * These types intentionally use `unknown` / index signatures for less-used
 * sub-objects so we don't have to model the entire ARES schema before MVP.
 */

export interface Adresa {
  kodStatu?: string;
  nazevStatu?: string;
  kodKraje?: number;
  nazevKraje?: string;
  kodOkresu?: number;
  nazevOkresu?: string;
  kodObce?: number;
  nazevObce?: string;
  kodCastiObce?: number;
  nazevCastiObce?: string;
  kodUlice?: number;
  nazevUlice?: string;
  cisloDomovni?: number;
  cisloOrientacni?: number;
  cisloOrientacniPismeno?: string;
  psc?: number;
  textovaAdresa?: string;
  kodAdresnihoMista?: number;
  [key: string]: unknown;
}

export interface PravniForma {
  kod?: string;
  nazev?: string;
}

export interface KategoriePoctuPracovniku {
  kod?: string;
  nazev?: string;
}

export interface CzNace {
  kod: string;
  nazev?: string;
}

export interface SeznamRegistraci {
  stavZdrojeVr?: string;
  stavZdrojeRes?: string;
  stavZdrojeRzp?: string;
  stavZdrojeNrpzs?: string;
  stavZdrojeRpsh?: string;
  stavZdrojeRcns?: string;
  stavZdrojeSzr?: string;
  stavZdrojeDph?: string;
  stavZdrojeSd?: string;
  stavZdrojeIr?: string;
  stavZdrojeCeu?: string;
  stavZdrojeRs?: string;
  stavZdrojeRed?: string;
  [key: string]: string | undefined;
}

export interface EkonomickySubjekt {
  ico: string;
  obchodniJmeno?: string;
  pravniForma?: string;
  financniUrad?: string;
  datumVzniku?: string;
  datumZaniku?: string;
  datumAktualizace?: string;
  dic?: string;
  icDph?: string;
  adresaDorucovaci?: { radekAdresy1?: string; radekAdresy2?: string; radekAdresy3?: string };
  sidlo?: Adresa;
  pravniFormaObjekt?: PravniForma;
  seznamRegistraci?: SeznamRegistraci;
  czNace?: string[];
  [key: string]: unknown;
}

export interface EkonomickeSubjektySeznam {
  pocetCelkem: number;
  ekonomickeSubjekty: EkonomickySubjekt[];
  [key: string]: unknown;
}

/**
 * The /ekonomicke-subjekty-vr/{ico} endpoint returns a wrapper around one or
 * more records: `{ icoId, zaznamy: [...] }`. Each entry in `zaznamy` is a
 * VrZaznam — typically there are two (one AKTIVNI, one HISTORICKY). Active
 * data lives in the AKTIVNI record.
 */
export interface VrOdpoved {
  icoId?: string;
  zaznamy?: VrZaznam[];
  [key: string]: unknown;
}

export interface VrObchodniJmenoZaznam {
  datumZapisu?: string;
  datumVymazu?: string;
  hodnota?: string;
}

export interface VrZaznam {
  icoId?: string | null;
  stavSubjektu?: string;
  primarniZaznam?: boolean;
  obchodniJmeno?: VrObchodniJmenoZaznam[];
  statutarniOrgany?: VrStatutarniOrgan[];
  spolecnici?: VrClenOrganu[];
  predmetPodnikani?: { hodnota?: string }[];
  predmetCinnosti?: { hodnota?: string }[];
  zakladniKapital?: VrZakladniKapital;
  [key: string]: unknown;
}

export interface VrStatutarniOrgan {
  nazevOrganu?: string;
  pocetClenu?: number;
  clenoveOrganu?: VrClenOrganu[];
  [key: string]: unknown;
}

export interface VrZakladniKapital {
  hodnota?: number;
  mena?: string;
  datumZapisu?: string;
  datumVymazu?: string;
}

export interface VrClenOrganu {
  datumZapisu?: string;
  datumVymazu?: string;
  typAngazma?: string;
  nazevAngazma?: string;
  clenstvi?: {
    funkce?: { nazev?: string; vznikFunkce?: string; zanikFunkce?: string };
    clenstvi?: { vznikClenstvi?: string; zanikClenstvi?: string };
  };
  fyzickaOsoba?: VrFyzickaOsoba;
  pravnickaOsoba?: VrPravnickaOsoba;
  [key: string]: unknown;
}

export interface VrFyzickaOsoba {
  jmeno?: string;
  prijmeni?: string;
  titulPredJmenem?: string;
  titulZaJmenem?: string;
  datumNarozeni?: string;
  textOsoba?: string;
  adresa?: Adresa;
  [key: string]: unknown;
}

export interface VrPravnickaOsoba {
  ico?: string;
  obchodniJmeno?: string;
  adresa?: Adresa;
  [key: string]: unknown;
}

/**
 * Pro fyzické osoby podnikající (OSVČ, právní forma 107/108) je v RŽP
 * uložená osobaPodnikatel — to je jediný veřejný zdroj datumNarozeni
 * podnikatele dostupný přes ARES. Bez něj nelze propojit OSVČ záznam
 * (IČO např. 49801431) se stejnou osobou, která je jednatelem jiné
 * firmy (kde DOB pochází z VR).
 */
export interface RzpOsobaPodnikatel {
  jmeno?: string;
  prijmeni?: string;
  datumNarozeni?: string;
  platnostOd?: string;
  statniObcanstvi?: string;
  typAngazma?: string;
}

export interface RzpZaznamItem {
  ico?: string;
  obchodniJmeno?: string;
  pravniForma?: string;
  typSubjektu?: "F" | "P"; // F = fyzická, P = právnická
  osobaPodnikatel?: RzpOsobaPodnikatel;
  primarniZaznam?: boolean;
  [key: string]: unknown;
}

export interface RzpZaznam {
  ico?: string;
  icoId?: string;
  /** Pro OSVČ má RŽP wrapping {zaznamy:[{osobaPodnikatel:...}]}. */
  zaznamy?: RzpZaznamItem[];
  zivnostenskeOpravneni?: ZivnostenskeOpravneni[];
  [key: string]: unknown;
}

/** /ekonomicke-subjekty-res/{ico} returns a wrapper around RES records. */
export interface ResOdpoved {
  icoId?: string;
  zaznamy?: ResZaznam[];
  [key: string]: unknown;
}

export interface ResZaznam {
  ico?: string;
  obchodniJmeno?: string;
  primarniZaznam?: boolean;
  datumVzniku?: string;
  datumAktualizace?: string;
  pravniForma?: string;
  pravniFormaRos?: string;
  financniUrad?: string;
  okresNutsLau?: string;
  zakladniUzemniJednotka?: string;
  sidlo?: Adresa;
  czNace?: string[];
  czNace2008?: string[];
  czNacePrevazujici?: string;
  czNacePrevazujici2008?: string;
  statistickeUdaje?: ResStatistickeUdaje;
  [key: string]: unknown;
}

export interface ResStatistickeUdaje {
  /** ČSÚ kód kategorie počtu pracovníků. */
  kategoriePoctuPracovniku?: string;
  /** SEC2010 / ESA 2010 institucionální sektor. */
  institucionalniSektor2010?: string;
  [key: string]: unknown;
}

export interface ZivnostenskeOpravneni {
  predmetPodnikani?: string;
  druh?: string;
  datumVzniku?: string;
  datumZaniku?: string;
  stav?: string;
  oboryCinnosti?: string[] | { nazev: string }[];
  [key: string]: unknown;
}

export interface StandardizovanaAdresa {
  kodAdresnihoMista?: number;
  textovaAdresa?: string;
  adresa?: Adresa;
  skore?: number;
  [key: string]: unknown;
}

export interface StandardizovaneAdresyOdpoved {
  pocetCelkem?: number;
  adresy?: StandardizovanaAdresa[];
  [key: string]: unknown;
}

export interface CiselnikPolozka {
  kod: string;
  nazev?: string;
  uroven?: number;
  zkratka?: string;
  [key: string]: unknown;
}

export interface CiselnikyOdpoved {
  pocetCelkem?: number;
  ciselniky?: Array<{ kod: string; polozky: CiselnikPolozka[] }>;
  polozky?: CiselnikPolozka[];
  [key: string]: unknown;
}

export interface Chyba {
  kod?: string;
  popis?: string;
  pozice?: string;
  [key: string]: unknown;
}
