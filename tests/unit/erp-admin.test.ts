import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as CredentialRepo from "~/adapters/db/repositories/metakocka-credential.server";
import type * as ExportPortalRepo from "~/adapters/db/repositories/export-portal-connection.server";
import type * as ShopRepo from "~/adapters/db/repositories/shop.server";
import { isErpAdminUser, parseErpAdminEmails } from "~/domain/erp-admin";

/**
 * docs/BUILD_SPEC.md section 9: who may view and change the MetaKocka
 * connection. The matching is pure; the routes are held to refusing a
 * non-admin before any repository is asked for the key.
 */

const SHOP = "erp-admin-test.myshopify.com";

const spy = vi.hoisted(() => ({
  user: undefined as { email: string; account_owner: boolean } | undefined,
  calls: [] as string[],
}));

vi.mock("~/adapters/shopify/shopify.server", () => ({
  authenticate: {
    admin: async () => ({
      admin: {},
      session: {
        shop: SHOP,
        onlineAccessInfo: spy.user ? { associated_user: spy.user } : undefined,
      },
    }),
  },
}));

vi.mock(
  "~/adapters/db/repositories/metakocka-credential.server",
  async (importOriginal) => {
    const real = await importOriginal<typeof CredentialRepo>();
    const record =
      (name: string) =>
      async (..._args: unknown[]): Promise<never> => {
        spy.calls.push(name);
        throw new Error(`${name} must not be reached by a non-admin`);
      };
    return {
      ...real,
      getCredentialSummary: record("getCredentialSummary"),
      getCredential: record("getCredential"),
      saveCredential: record("saveCredential"),
      markVerified: record("markVerified"),
      assertMayDisconnect: () => {
        spy.calls.push("assertMayDisconnect");
      },
    };
  },
);

vi.mock(
  "~/adapters/db/repositories/export-portal-connection.server",
  async (importOriginal) => {
    const real = await importOriginal<typeof ExportPortalRepo>();
    const record =
      (name: string) =>
      async (..._args: unknown[]): Promise<never> => {
        spy.calls.push(name);
        throw new Error(`${name} must not be reached by a non-admin`);
      };
    return {
      ...real,
      getExportPortalSummary: record("getExportPortalSummary"),
      saveExportPortalApiKey: record("saveExportPortalApiKey"),
      disconnectExportPortal: record("disconnectExportPortal"),
    };
  },
);

vi.mock("~/adapters/db/repositories/shop.server", async (importOriginal) => {
  const real = await importOriginal<typeof ShopRepo>();
  return {
    ...real,
    resetShop: async () => {
      spy.calls.push("resetShop");
    },
  };
});

beforeEach(() => {
  spy.user = undefined;
  spy.calls = [];
});

describe("parseErpAdminEmails", () => {
  it("splits on commas, trims and lower-cases", () => {
    expect(parseErpAdminEmails(" Ana@Example.com ,bor@example.com")).toEqual([
      "ana@example.com",
      "bor@example.com",
    ]);
  });

  it("drops blank entries and duplicates", () => {
    expect(parseErpAdminEmails("a@x.si,, ,A@X.SI,")).toEqual(["a@x.si"]);
  });

  it("is empty when unset or blank", () => {
    expect(parseErpAdminEmails(undefined)).toEqual([]);
    expect(parseErpAdminEmails(null)).toEqual([]);
    expect(parseErpAdminEmails("")).toEqual([]);
    expect(parseErpAdminEmails("  ,  ")).toEqual([]);
  });
});

describe("isErpAdminUser", () => {
  const allowlist = parseErpAdminEmails("ana@example.com");

  it("lets the store owner in, with or without an allowlist", () => {
    expect(isErpAdminUser({ email: "o@x.si", account_owner: true }, [])).toBe(
      true,
    );
    expect(isErpAdminUser({ email: "", account_owner: true }, allowlist)).toBe(
      true,
    );
  });

  it("matches a listed email regardless of case and surrounding space", () => {
    for (const email of [
      "ana@example.com",
      "ANA@Example.COM",
      "  ana@example.com ",
    ]) {
      expect(
        isErpAdminUser({ email, account_owner: false }, allowlist),
        email,
      ).toBe(true);
    }
  });

  it("matches an allowlist that was not normalized", () => {
    expect(
      isErpAdminUser({ email: "ana@example.com", account_owner: false }, [
        " Ana@Example.com ",
      ]),
    ).toBe(true);
  });

  it("refuses a staff user who is not listed", () => {
    expect(
      isErpAdminUser(
        { email: "bor@example.com", account_owner: false },
        allowlist,
      ),
    ).toBe(false);
    expect(
      isErpAdminUser(
        { email: "ana@example.com.evil", account_owner: false },
        allowlist,
      ),
    ).toBe(false);
  });

  it("refuses a staff user with an empty or missing email", () => {
    expect(isErpAdminUser({ email: "", account_owner: false }, allowlist)).toBe(
      false,
    );
    expect(
      isErpAdminUser({ email: "   ", account_owner: false }, allowlist),
    ).toBe(false);
    expect(
      isErpAdminUser({ email: null, account_owner: false }, allowlist),
    ).toBe(false);
    expect(isErpAdminUser({ account_owner: false }, allowlist)).toBe(false);
  });

  it("stays locked for a non-owner when the allowlist is empty", () => {
    expect(
      isErpAdminUser({ email: "ana@example.com", account_owner: false }, []),
    ).toBe(false);
  });

  it("refuses when Shopify gave no user", () => {
    expect(isErpAdminUser(undefined, allowlist)).toBe(false);
    expect(isErpAdminUser(null, allowlist)).toBe(false);
  });
});

describe("principalFromSession", () => {
  it("reads the online session's associated user", async () => {
    const { principalFromSession } = await import("~/web/lib/principal.server");
    const session = (user: unknown) =>
      ({
        shop: SHOP,
        onlineAccessInfo: user ? { associated_user: user } : undefined,
      }) as never;

    expect(
      principalFromSession(
        session({ email: "Ana@example.com", account_owner: false }),
        ["ana@example.com"],
      ).isErpAdmin,
    ).toBe(true);
    expect(
      principalFromSession(
        session({ email: "bor@example.com", account_owner: false }),
        ["ana@example.com"],
      ).isErpAdmin,
    ).toBe(false);
    expect(
      principalFromSession(session(undefined), ["ana@example.com"]).isErpAdmin,
    ).toBe(false);
  });

  it("uses an empty allowlist when ERP_ADMIN_EMAILS is unset", async () => {
    const { getEnv } = await import("~/adapters/config/env.server");
    expect(getEnv().ERP_ADMIN_EMAILS).toEqual([]);
  });
});

function post(path: string, fields: Record<string, string>) {
  return {
    request: new Request(`https://app.test${path}`, {
      method: "POST",
      body: new URLSearchParams(fields),
    }),
    params: {},
    context: {},
  } as never;
}

const STAFF = { email: "staff@example.com", account_owner: false };

describe("the MetaKocka settings route", () => {
  it("closes the loader to a non-admin without reading the summary", async () => {
    spy.user = STAFF;
    const { loader } = await import("~/web/routes/app.settings.metakocka");
    const data = await loader({
      request: new Request("https://app.test/app/settings/metakocka"),
      params: {},
      context: {},
    } as never);
    expect(data).toMatchObject({
      allowed: false,
      userKnown: true,
      summary: null,
    });
    expect(spy.calls).toEqual([]);
  });

  it("refuses save, test and disconnect from a non-admin", async () => {
    spy.user = STAFF;
    const { action } = await import("~/web/routes/app.settings.metakocka");
    for (const intent of ["save", "test", "disconnect"] as const) {
      const out = await action(
        post("/app/settings/metakocka", {
          intent,
          companyId: "1234",
          secretKey: "new-secret",
          webhookClientSecret: "hook",
          apiUserEmail: "api@example.com",
          confirmCompanyId: "1234",
        }),
      );
      expect(out, intent).toEqual({
        ok: false,
        intent,
        message: "Only ERP admins can change the MetaKocka connection.",
      });
    }
    expect(spy.calls).toEqual([]);
  });

  it("refuses a request with no online user", async () => {
    const { action } = await import("~/web/routes/app.settings.metakocka");
    const out = await action(
      post("/app/settings/metakocka", { intent: "save", companyId: "1" }),
    );
    expect(out).toMatchObject({ ok: false });
    expect(spy.calls).toEqual([]);
  });
});

describe("the setup connect step", () => {
  it("refuses a non-admin before saving anything", async () => {
    spy.user = STAFF;
    const { action } = await import("~/web/routes/app.setup");
    const out = await action(
      post("/app/setup", {
        intent: "connect",
        step: "connect",
        companyId: "1234",
        secretKey: "new-secret",
        apiUserEmail: "api@example.com",
      }),
    );
    expect(out).toEqual({
      ok: false,
      message: "Only ERP admins can change the MetaKocka connection.",
    });
    expect(spy.calls).toEqual([]);
  });
});

describe("the export portal connection route", () => {
  it("refuses save, test and disconnect from a non-admin", async () => {
    spy.user = STAFF;
    const { action } = await import("~/web/routes/app.sources.connection");
    for (const intent of ["save", "test", "disconnect"] as const) {
      const out = await action(
        post("/app/sources/connection", { intent, apiKey: "key" }),
      );
      expect(out, intent).toEqual({
        ok: false,
        intent,
        message: "Only ERP admins can change the export portal connection.",
      });
    }
    expect(spy.calls).toEqual([]);
  });
});
