import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

import { readTranslatableResources } from "~/adapters/shopify/translations";
import {
  accumulateResource,
  coverageRows,
  newCoverage,
} from "~/domain/translations/coverage";
import type { CoverageRow } from "~/domain/translations/estimate";
import type { ResourceType } from "~/domain/translations/types";

/**
 * One pass over every translatable resource of the given types, counting
 * (docs/translations.md § Coverage). Reads only; the counts go to the cache
 * through the repository by the job that called this.
 */

const PAGE = 50;

export async function scanCoverage(
  admin: AdminApiContext,
  input: { types: readonly ResourceType[]; locales: readonly string[] },
  onProgress?: (done: { type: ResourceType; resources: number }) => void,
): Promise<CoverageRow[]> {
  const acc = newCoverage();
  if (input.locales.length === 0) return [];

  for (const type of input.types) {
    let after: string | null = null;
    let seen = 0;
    for (;;) {
      const page = await readTranslatableResources(admin, {
        type,
        first: PAGE,
        after,
        locales: input.locales,
      });
      for (const resource of page.resources) {
        accumulateResource(acc, {
          resourceType: type,
          fields: resource.fields,
          translations: resource.translations,
          locales: input.locales,
        });
      }
      seen += page.resources.length;
      if (!page.hasNextPage || !page.endCursor) break;
      after = page.endCursor;
    }
    onProgress?.({ type, resources: seen });
  }
  return coverageRows(acc);
}
