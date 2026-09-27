// JSON API client. Throws ApiError for HTTP errors and NetworkError when the request never completed.

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    public messageFa: string
  ) {
    super(code);
  }
}

export class NetworkError extends Error {
  constructor() {
    super("network");
  }
}

export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      credentials: "same-origin",
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
    });
  } catch {
    throw new NetworkError();
  }
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    if (res.ok) throw new ApiError(res.status, "bad_response", "پاسخ سرور قابل خواندن نیست.");
  }
  if (!res.ok) {
    const err = (data as { error?: { code?: string; message_fa?: string } } | null)?.error;
    throw new ApiError(res.status, err?.code ?? "http_" + res.status, err?.message_fa ?? "خطا در ارتباط با سرور.");
  }
  return data as T;
}

/** Uploads a binary body (JPEG) and parses the JSON answer. */
export async function apiUpload<T>(path: string, body: Blob): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, { method: "PUT", credentials: "same-origin", headers: { "Content-Type": "image/jpeg" }, body, cache: "no-store" });
  } catch {
    throw new NetworkError();
  }
  const data = (await res.json().catch(() => null)) as { error?: { code?: string; message_fa?: string } } | null;
  if (!res.ok) throw new ApiError(res.status, data?.error?.code ?? "http_" + res.status, data?.error?.message_fa ?? "آپلود انجام نشد.");
  return data as T;
}

export function errorText(e: unknown): string {
  if (e instanceof ApiError) return e.messageFa;
  if (e instanceof NetworkError) return "اتصال اینترنت برقرار نیست.";
  if (e instanceof DOMException && e.name === "NotAllowedError") return "Face ID لغو شد یا اجازه داده نشد.";
  if (e instanceof Error && e.name === "NotAllowedError") return "Face ID لغو شد یا اجازه داده نشد.";
  return "کار انجام نشد. دوباره امتحان کن.";
}
