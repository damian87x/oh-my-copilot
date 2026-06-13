function parseMaybeJson(value) {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return value;
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function normalizeResult(raw) {
  if (!raw || typeof raw !== "object") return undefined;
  const resultType = raw.resultType ?? raw.result_type;
  const textResultForLlm = raw.textResultForLlm ?? raw.text_result_for_llm;
  if (resultType == null && textResultForLlm == null) return undefined;
  return {
    resultType: resultType ?? "success",
    textResultForLlm: textResultForLlm == null ? "" : String(textResultForLlm),
  };
}

export function normalizeHookInput(data = {}, options = {}) {
  const payload = data && typeof data === "object" ? data : {};
  const cwd = payload.cwd ?? payload.directory ?? options.cwd ?? process.cwd();
  const toolResult = normalizeResult(payload.toolResult ?? payload.tool_result ?? payload.toolOutput);
  const error = payload.error?.message ?? payload.error ?? payload.message;
  return {
    raw: payload,
    hookEventName: payload.hookEventName ?? payload.hook_event_name,
    sessionId: payload.sessionId ?? payload.session_id ?? "unknown",
    timestamp: payload.timestamp,
    cwd,
    directory: cwd,
    prompt: payload.prompt ?? payload.message?.content ?? "",
    toolName: payload.toolName ?? payload.tool_name ?? "unknown",
    toolArgs: parseMaybeJson(payload.toolArgs ?? payload.tool_input ?? payload.toolInput),
    toolResult,
    error: error == null ? undefined : String(error),
    transcriptPath: payload.transcriptPath ?? payload.transcript_path,
    stopReason: payload.stopReason ?? payload.stop_reason,
    trigger: payload.trigger,
    customInstructions: payload.customInstructions ?? payload.custom_instructions,
  };
}

export function parseHookInput(raw, options = {}) {
  const data = raw ? JSON.parse(raw) : {};
  return normalizeHookInput(data, options);
}
