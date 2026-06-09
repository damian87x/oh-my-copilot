import type { CliContext, CliResult, CommandModule } from "./types.js";

export interface AlternativeWorkflow {
  label: string;
  workflow: string[];
  reason: string;
}

export interface WorkflowSuggestion {
  ok: true;
  workflow: string[];
  reason: string;
  signals: string[];
  alternatives?: AlternativeWorkflow[];
}

interface SuggestRule {
  id: string;
  signals: string[];
  workflow: string[];
  reason: string;
  priority: number;
  patterns: RegExp[];
  alternatives?: AlternativeWorkflow[];
}

const RULES: SuggestRule[] = [
  {
    id: "debug",
    signals: ["bug", "failing", "flaky", "broken", "error", "exception"],
    workflow: ["/debug", "/ralplan", "/ralph", "/verify"],
    reason: "task appears to involve a bug or failing behavior; diagnose first, plan the fix, execute persistently, then verify.",
    priority: 100,
    patterns: [/\bbugs?\b/, /\bfail(?:ing|ed|s)?\b/, /\bflaky\b/, /\bbroken\b/, /\berrors?\b/, /\bexceptions?\b/],
  },
  {
    id: "parallel-team",
    signals: ["parallel", "multiple lanes", "independent workstreams"],
    workflow: ["/ralplan", "/team", "/code-review", "/verify"],
    reason: "task suggests independent parallel lanes; plan first, coordinate workers, review the result, then verify.",
    priority: 90,
    patterns: [/\bparallel\b/, /\bmultiple lanes\b/, /\bindependent workstreams?\b/, /\bconcurrent(?:ly)?\b/],
  },
  {
    id: "batch",
    signals: ["many files", "many independent tasks", "batch fix"],
    workflow: ["/ralplan", "/ultrawork", "/code-review", "/verify"],
    reason: "task looks like a batch of independent changes; plan the slice, fan out execution, review, then verify.",
    priority: 80,
    patterns: [/\bmany files\b/, /\bmany independent tasks\b/, /\bbatch(?: fix| fixes)?\b/, /\ball type errors\b/, /\ball lint\b/],
  },
  {
    id: "review",
    signals: ["review", "PR", "diff"],
    workflow: ["/code-review", "/verify"],
    reason: "task asks for review of an existing change; inspect the diff first, then verify the conclusion.",
    priority: 70,
    patterns: [/\breviews?\b/, /\bPR\b/i, /\bpull request\b/, /\bdiffs?\b/],
  },
  {
    id: "jira",
    signals: ["ticket", "Jira", "handoff"],
    workflow: ["/ralplan", "/jira-ticket"],
    reason: "task is about tracking or handoff; produce an implementation-ready plan, then render the ticket payload.",
    priority: 65,
    patterns: [/\btickets?\b/, /\bjira\b/, /\bhandoff\b/],
  },
  {
    id: "quality",
    signals: ["quality", "regression", "confidence", "release"],
    workflow: ["/ultraqa", "/verify"],
    reason: "task emphasizes quality or release confidence; run adversarial QA, then verify evidence.",
    priority: 60,
    patterns: [/\bquality\b/, /\bregressions?\b/, /\bconfidence\b/, /\breleases?\b/, /\bQA\b/i],
  },
  {
    id: "tdd",
    signals: ["test", "TDD", "behavior change"],
    workflow: ["/tdd", "/verify"],
    reason: "task is centered on tests or behavior change; use red-green-refactor, then verify.",
    priority: 50,
    patterns: [/\btests?\b/, /\bTDD\b/i, /\bbehavior changes?\b/, /\bbehaviour changes?\b/, /\bred-green-refactor\b/],
  },
  {
    id: "research-plan",
    signals: ["feature", "vague", "unclear scope", "architecture", "design"],
    workflow: ["/research-codebase", "/grill-me", "/ralplan", "/ralph", "/verify"],
    reason: "task appears to be a feature or broad idea; map the relevant code, clarify the shape with /grill-me, plan it, execute with one owner, then verify.",
    priority: 40,
    patterns: [/\bfeatures?\b/, /\bvague\b/, /\b(?:unclear|unknown) scope\b|\bscope\b/, /\barchitecture\b|\barchitectural\b/, /\bdesign\b/],
    alternatives: [
      {
        label: "If it is still just an idea",
        workflow: ["/grill-me", "/ralplan"],
        reason: "use /grill-me first to sharpen the idea before turning it into an implementation plan.",
      },
      {
        label: "If scope is already clear",
        workflow: ["/ralplan", "/ralph", "/verify"],
        reason: "skip discovery and clarification when you already know the desired behavior and affected area.",
      },
    ],
  },
];

const FALLBACK: WorkflowSuggestion = {
  ok: true,
  workflow: ["/ralplan", "/ralph", "/verify"],
  reason: "no specific signal matched; use the default lightweight path: plan, execute with one owner, then verify.",
  signals: ["general"],
};

function matchingSignals(task: string, rule: SuggestRule): string[] {
  const searchableTask = task.toLowerCase();
  const matches: string[] = [];
  for (let i = 0; i < rule.patterns.length; i++) {
    if (rule.patterns[i]!.test(searchableTask)) matches.push(rule.signals[i] ?? rule.id);
  }
  return [...new Set(matches)];
}

function taskArgument(argv: string[]): string {
  return argv.slice(1).find((arg) => !arg.startsWith("--")) ?? "";
}

export function suggestWorkflow(task: string): WorkflowSuggestion | { ok: false; error: string } {
  const normalized = task.trim();
  if (!normalized) return { ok: false, error: 'usage: omp suggest "<task>"' };

  let best: { rule: SuggestRule; signals: string[]; score: number } | undefined;
  for (const rule of RULES) {
    const signals = matchingSignals(normalized, rule);
    if (signals.length === 0) continue;
    const score = rule.priority + signals.length;
    if (!best || score > best.score || (score === best.score && rule.workflow.length < best.rule.workflow.length)) {
      best = { rule, signals, score };
    }
  }

  if (!best) return FALLBACK;
  return {
    ok: true,
    workflow: best.rule.workflow,
    reason: best.rule.reason,
    signals: best.signals,
    ...(best.rule.alternatives ? { alternatives: best.rule.alternatives } : {}),
  };
}

export function formatWorkflowSuggestion(suggestion: WorkflowSuggestion): string {
  const lines = [
    "Recommended workflow:",
    suggestion.workflow.join(" → "),
    "",
    "Why:",
    `- ${suggestion.reason}`,
    `- matched signals: ${suggestion.signals.join(", ")}`,
  ];

  if (suggestion.alternatives?.length) {
    lines.push("", "Also consider:");
    for (const alternative of suggestion.alternatives) {
      lines.push(`- ${alternative.label}: ${alternative.workflow.join(" → ")}`);
      lines.push(`  ${alternative.reason}`);
    }
  }

  return lines.join("\n");
}

export const suggestCommand: CommandModule = {
  name: "suggest",
  summary: 'recommend a slash-skill workflow for a task: suggest "<task>" [--json]',
  run(argv: string[], context: CliContext): CliResult {
    const task = taskArgument(argv);
    const suggestion = suggestWorkflow(task);
    if (!suggestion.ok) {
      return {
        ok: false,
        exitCode: 1,
        output: context.json ? suggestion : undefined,
        message: suggestion.error,
      };
    }
    return context.json
      ? { ok: true, output: suggestion }
      : { ok: true, message: formatWorkflowSuggestion(suggestion) };
  },
};
