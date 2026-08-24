import { PrismaClient } from "@prisma/client";

import { getEnv } from "~/adapters/config/env.server";

declare global {
  var __prisma: PrismaClient | undefined;
}

function create(): PrismaClient {
  return new PrismaClient({
    datasources: { db: { url: getEnv().DATABASE_URL } },
  });
}

// Vite reloads modules in development; without the global the dev server opens a
// new connection pool on every change.
export const prisma: PrismaClient =
  global.__prisma ?? (global.__prisma = create());

export type { Prisma } from "@prisma/client";
