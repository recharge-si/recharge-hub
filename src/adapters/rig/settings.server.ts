import { getRigAiProvider } from "~/adapters/ai/rig-provider.server";
import {
  loadRigSource,
  recentPlainShare,
  setRigBuilderEnabled,
} from "~/adapters/db/repositories/rig.server";
import { rigReadiness, type RigReadiness } from "~/domain/rig/candidates";
import { RIG_ROLES, READINESS_ROLES, type RigRole } from "~/domain/rig/keys";
import { placeholderRules } from "~/domain/rig/rules";
import type { Principal } from "~/domain/types";

/**
 * The Rig builder card on the Product setup settings page (docs/rig-builder.md
 * § Readiness): the readiness line per role, the switch, and how often the
 * last explanations fell back to plain wording.
 */

export interface RigSettings {
  enabled: boolean;
  ready: boolean;
  placeholderRules: boolean;
  roles: Array<{
    role: RigRole;
    gates: boolean;
    products: number;
    complete: number;
    missing: Array<{ key: string; count: number }>;
  }>;
  minComplete: number;
  notReady: RigRole[];
  /** Plain-mode share of the last 50 explained requests. */
  plain: { plain: number; of: number };
}

function describe(readiness: RigReadiness): RigSettings["roles"] {
  return RIG_ROLES.map((role) => ({
    role,
    gates: READINESS_ROLES.includes(role),
    products: readiness.roles[role].products,
    complete: readiness.roles[role].complete,
    missing: readiness.roles[role].missing.slice(0, 3),
  }));
}

export async function rigSettingsFor(principal: Principal): Promise<RigSettings> {
  const source = await loadRigSource(principal);
  const readiness = rigReadiness(source.plan, source.products);
  return {
    enabled: source.enabled,
    ready: readiness.ready,
    placeholderRules: placeholderRules().placeholder,
    roles: describe(readiness),
    minComplete: readiness.minComplete,
    notReady: readiness.notReady,
    plain: await recentPlainShare(source.shopId),
  };
}

const ROLE_WORDS: Record<RigRole, string> = {
  board: "boards",
  sail: "sails",
  mast: "masts",
  extension: "extensions",
  base: "bases",
  boom: "booms",
  fin: "fins",
};

export function roleWord(role: RigRole): string {
  return ROLE_WORDS[role];
}

export type ToggleResult = { ok: true; message: string } | { ok: false; message: string };

/** Turning it on needs a ready catalogue and a claude that can run with tools off. */
export async function setRigEnabled(
  principal: Principal,
  enabled: boolean,
): Promise<ToggleResult> {
  if (!enabled) {
    await setRigBuilderEnabled(principal, false);
    return { ok: true, message: "Rig builder turned off." };
  }
  const source = await loadRigSource(principal);
  const readiness = rigReadiness(source.plan, source.products);
  if (!readiness.ready) {
    const names = readiness.notReady.map(roleWord).join(", ");
    return {
      ok: false,
      message: `Not ready: each of boards, sails, masts, booms and fins needs at least ${readiness.minComplete} complete products in stock (short on ${names}).`,
    };
  }
  if (!(await getRigAiProvider().ready())) {
    return {
      ok: false,
      message:
        "The installed claude cannot run with tools off, so the builder will not be enabled. Check the claude CLI in the image.",
    };
  }
  await setRigBuilderEnabled(principal, true);
  return { ok: true, message: "Rig builder turned on." };
}
