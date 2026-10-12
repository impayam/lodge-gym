// JSON API client. Throws ApiError for HTTP errors and NetworkError when the request never completed.

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    /** Server message (sent in the `message_fa` field of the API error shape, SPEC §11). */
    public messageText: string
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
    if (res.ok) throw new ApiError(res.status, "bad_response", "The server response could not be read.");
  }
  if (!res.ok) {
    const err = (data as { error?: { code?: string; message_fa?: string } } | null)?.error;
    throw new ApiError(res.status, err?.code ?? "http_" + res.status, err?.message_fa ?? "Could not reach the server.");
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
  if (!res.ok) throw new ApiError(res.status, data?.error?.code ?? "http_" + res.status, data?.error?.message_fa ?? "Upload failed.");
  return data as T;
}

export function errorText(e: unknown): string {
  if (e instanceof ApiError) return e.messageText;
  if (e instanceof NetworkError) return "No internet connection.";
  if (e instanceof DOMException && e.name === "NotAllowedError") return "Face ID was cancelled or not allowed.";
  if (e instanceof Error && e.name === "NotAllowedError") return "Face ID was cancelled or not allowed.";
  return "That didn't work. Try again.";
}
