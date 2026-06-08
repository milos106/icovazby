// SPDX-License-Identifier: AGPL-3.0-or-later
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AresClient } from "../src/ares/client.js";
import type {
  EkonomickeSubjektySeznam,
  EkonomickySubjekt,
  ResOdpoved,
  RzpZaznam,
  VrOdpoved,
} from "../src/ares/types.js";
import { NotFoundError } from "../src/errors.js";

const FIXTURES = path.dirname(fileURLToPath(import.meta.url));

export function loadFixture<T>(name: string): T {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, name), "utf8")) as T;
}

export interface MockResponses {
  subjects?: Record<string, EkonomickySubjekt | null>;
  vr?: Record<string, VrOdpoved | null>;
  rzp?: Record<string, RzpZaznam | null>;
  res?: Record<string, ResOdpoved | null>;
  search?: EkonomickeSubjektySeznam;
}

export function makeMockClient(responses: MockResponses): AresClient {
  const missing = (ico: string, kind: string): never => {
    throw new NotFoundError(`Mock has no ${kind} record for ${ico}`);
  };
  return {
    async getEconomicSubject(ico: string) {
      const r = responses.subjects?.[ico];
      if (r === undefined) return missing(ico, "subject");
      if (r === null) throw new NotFoundError(`${ico} not found`);
      return r;
    },
    async getVrRecord(ico: string) {
      const r = responses.vr?.[ico];
      if (r === undefined) return missing(ico, "VR");
      if (r === null) throw new NotFoundError(`VR ${ico} not found`);
      return r;
    },
    async getRzpRecord(ico: string) {
      const r = responses.rzp?.[ico];
      if (r === undefined) return missing(ico, "RŽP");
      if (r === null) throw new NotFoundError(`RŽP ${ico} not found`);
      return r;
    },
    async getResRecord(ico: string) {
      const r = responses.res?.[ico];
      if (r === undefined) return missing(ico, "RES");
      if (r === null) throw new NotFoundError(`RES ${ico} not found`);
      return r;
    },
    async searchEconomicSubjects() {
      if (!responses.search) throw new Error("Mock has no search response");
      return responses.search;
    },
    // biome-ignore lint/suspicious/noExplicitAny: AresClient has private fields
  } as any;
}
