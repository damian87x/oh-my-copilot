import { countTokens } from "./cost-ledger.mjs";

const ANSI_RE = /\u001b\[[0-9;]*m/g;
const DIAGNOSTIC_RE = /\b(fail(?:ed|ure)?|error|exception|assertion|traceback|expected|cannot find|no-undef|TS\d{4})\b/i;

function stripAnsi(text) {
  return text.replace(ANSI_RE, "");
}

function dedupConsecutiveLines(lines) {
  const out = [];
  let previous = "";
  let repeated = 0;
  for (const line of lines) {
    if (line === previous) {
      repeated += 1;
      continue;
    }
    if (repeated > 0) out.push(`[omp] repeated previous line ${repeated} time${repeated === 1 ? "" : "s"}`);
    out.push(line);
    previous = line;
    repeated = 0;
  }
  if (repeated > 0) out.push(`[omp] repeated previous line ${repeated} time${repeated === 1 ? "" : "s"}`);
  return out;
}

export function minifyToolOutput(value, options = {}) {
  const rawText = value == null ? "" : String(value);
  const rawTokens = countTokens(rawText);
  const thresholdTokens = options.thresholdTokens ?? 800;
  if (rawTokens <= thresholdTokens) {
    return {
      changed: false,
      text: rawText,
      rawTokens,
      modelTokens: rawTokens,
      savedTokens: 0,
    };
  }

  const headLines = options.headLines ?? 80;
  const tailLines = options.tailLines ?? 40;
  const normalized = dedupConsecutiveLines(stripAnsi(rawText).split("\n"));
  const omitted = Math.max(0, normalized.length - headLines - tailLines);
  const head = normalized.slice(0, headLines);
  const tail = omitted > 0 ? normalized.slice(-tailLines) : [];
  const tailStart = omitted > 0 ? normalized.length - tailLines : normalized.length;
  const diagnosticLines = normalized
    .map((line, index) => ({ line, index }))
    .filter(({ line, index }) => index >= headLines && index < tailStart && DIAGNOSTIC_RE.test(line))
    .slice(0, options.maxDiagnosticLines ?? 40)
    .map(({ line }) => line);
  const text = [
    `[omp] output trimmed from ${rawTokens} estimated tokens; full raw output is saved on disk.`,
    ...head,
    ...(omitted > 0 ? [`[omp] … omitted ${omitted} middle line${omitted === 1 ? "" : "s"} …`] : []),
    ...(diagnosticLines.length > 0 ? ["[omp] preserved diagnostic lines from omitted output:", ...diagnosticLines] : []),
    ...tail,
  ].join("\n");
  const modelTokens = countTokens(text);

  if (modelTokens >= rawTokens) {
    return {
      changed: false,
      text: rawText,
      rawTokens,
      modelTokens: rawTokens,
      savedTokens: 0,
    };
  }

  return {
    changed: true,
    text,
    rawTokens,
    modelTokens,
    savedTokens: rawTokens - modelTokens,
  };
}
