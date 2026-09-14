// These are model selection refusals, not account authentication, billing,
// quota, or capacity failures. They authorize one request-local account retry.
const MODEL_ACCESS_CODES = new Set([
  "model_not_found", "model_not_supported", "unsupported_model",
  "model_access_denied", "model_not_allowed", "model_unavailable",
]);

export function nativeModelAccessError(error, model) {
  if (!error || typeof error !== "object") return false;
  if (MODEL_ACCESS_CODES.has(error.code)) return true;
  if (error.code && error.code !== "invalid_request_error") return false;
  if (error.type && error.type !== "invalid_request_error") return false;
  const message = typeof error.message === "string" ? error.message.toLowerCase() : "";
  return Boolean(model) && message.includes(String(model).toLowerCase()) &&
    /\bmodel\b/.test(message) &&
    /not supported|not available|do not have access|does not have access|access denied|not authorized/.test(message);
}

// Only complete, structured pre-output frames may authorize a retry. A model
// quoting an error in its answer (or a failure after output) cannot do so.
export function nativeModelAccessSse(text, model) {
  const frames = text.replaceAll("\r\n", "\n").split("\n\n");
  frames.pop();
  for (const frame of frames) {
    const data = frame.split("\n").filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart()).join("\n");
    if (!data) continue;
    let event;
    try { event = JSON.parse(data); } catch { return "output"; }
    if (!event || typeof event !== "object" || event.output?.length || event.response?.output?.length) return "output";
    const type = event.type || frame.split("\n").find((line) => line.startsWith("event:"))?.slice(6).trim();
    if (type === "response.created" || type === "response.in_progress") continue;
    if (type === "error" || type === "response.failed") {
      return nativeModelAccessError(event.error || event.response?.error || event, model)
        ? "denied" : "failure";
    }
    return "output";
  }
  return "pending";
}
