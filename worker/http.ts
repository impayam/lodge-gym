import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { ZodType } from "zod";

export class ApiError extends Error {
  constructor(
    public status: ContentfulStatusCode,
    public code: string,
    public messageFa: string
  ) {
    super(code);
  }
}

export function errorBody(code: string, message_fa: string) {
  return { error: { code, message_fa } };
}

export function fail(c: Context, status: ContentfulStatusCode, code: string, message_fa: string) {
  return c.json(errorBody(code, message_fa), status);
}

/** Parses the JSON body with Zod; throws ApiError(400) with a Persian message on failure. */
export async function readJson<T>(c: Context, schema: ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new ApiError(400, "invalid_json", "داده‌ی ارسالی قابل خواندن نیست.");
  }
  const r = schema.safeParse(raw);
  if (!r.success) {
    const where = r.error.issues[0]?.path.join(".") || "body";
    throw new ApiError(400, "invalid_input", `داده‌ی ارسالی معتبر نیست (${where}).`);
  }
  return r.data;
}

export const nowISO = () => new Date().toISOString();
