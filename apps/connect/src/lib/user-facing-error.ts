export const GENERIC_TECHNICAL_ERROR = "A technical error occurred. Please try again.";

const TECHNICAL_ERROR = /(?:\bjson\b|unexpected token|syntaxerror|typeerror|referenceerror|supabase|postgres|postgrest|sqlstate|schema cache|relation\s+.+does not exist|column\s+.+does not exist|duplicate key|constraint|invalid input syntax|failed to fetch|fetch failed|networkerror|econn|enotfound|jwt|pgrst\d+|<!doctype|<html|\bat\s+[\w$.<>]+\s*\(|\/node_modules\/|\b5\d\d\b)/i;

function rawMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) return String((error as { message?: unknown }).message ?? "");
  return "";
}

export function userFacingError(error: unknown, fallback = GENERIC_TECHNICAL_ERROR) {
  const message = rawMessage(error).replace(/\s+/g, " ").trim();
  if (!message) return fallback;
  if (message.startsWith("{") || message.startsWith("[") || TECHNICAL_ERROR.test(message)) return fallback;
  return message.length > 220 ? fallback : message;
}

export async function readJsonResponse<T>(response: Response, fallback = GENERIC_TECHNICAL_ERROR): Promise<T> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error(fallback);
  }
  if (!response.ok) {
    const error = payload && typeof payload === "object" && "error" in payload
      ? (payload as { error?: unknown }).error
      : null;
    throw new Error(userFacingError(error, fallback));
  }
  return payload as T;
}
