// Typed fetch client. Same-origin; sends the session cookie. JSON in/out with a normalized error.
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    // Phase 3 / 3.M8 — machine-readable error code (e.g. "scenario.not_found"), when the server
    // provides one. Used to look up a localized message; the message is the fallback.
    public code: string | null = null
  ) {
    super(message);
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: "include",
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  const data = text ? safeJson(text) : null;
  if (!res.ok) {
    const obj = data && typeof data === "object" ? (data as { error?: unknown; code?: unknown }) : null;
    const message = obj && "error" in obj ? String(obj.error) : text || res.statusText;
    const code = obj && typeof obj.code === "string" ? obj.code : null;
    throw new ApiError(res.status, message, code);
  }
  return data as T;
}

export const api = {
  get: <T>(url: string) => request<T>("GET", url),
  post: <T>(url: string, body?: unknown) => request<T>("POST", url, body),
  put: <T>(url: string, body?: unknown) => request<T>("PUT", url, body),
  patch: <T>(url: string, body?: unknown) => request<T>("PATCH", url, body),
  del: <T>(url: string) => request<T>("DELETE", url)
};
