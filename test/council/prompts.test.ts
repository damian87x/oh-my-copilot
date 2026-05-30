import { describe, expect, it } from "vitest";
import {
  balancedBlocks,
  buildMemberPrompt,
  buildSynthPrompt,
  extractJsonCandidates,
  parseMemberOutput,
  parseSynthOutput,
} from "../../src/council/prompts.js";
import type { CouncilMemberResult, ResolvedCouncilConfig } from "../../src/council/types.js";

const config: ResolvedCouncilConfig = {
  members: [],
  synthesizerModel: "auto",
  minSurvivors: 2,
  perMemberTimeoutMs: 1000,
  synthTimeoutMs: 2000,
  maxConcurrency: 4,
  probe: false,
};

describe("buildMemberPrompt", () => {
  it("injects the role and the question and asks for sentinel-wrapped JSON", () => {
    const p = buildMemberPrompt(
      { question: "Ship it?", context: "the diff", rubric: "be strict" },
      { model: "auto", role: "critic", weight: 1 },
    );
    expect(p).toContain("critic");
    expect(p).toContain("Ship it?");
    expect(p).toContain("the diff");
    expect(p).toContain("be strict");
    expect(p).toContain("<<<JSON>>>");
    expect(p).toContain("<<<END>>>");
  });
});

describe("buildSynthPrompt", () => {
  it("includes each survivor's role+weight and the weights-as-priors instruction", () => {
    const survivors: CouncilMemberResult[] = [
      {
        spec: { model: "m1", role: "critic", weight: 1.5 },
        status: "ok",
        durationMs: 1,
        output: { verdict: "no", confidence: 0.9, rationale: "risky" },
      },
    ];
    const p = buildSynthPrompt(config, { question: "Ship it?" }, survivors);
    expect(p).toContain("critic");
    expect(p).toContain("1.5");
    expect(p.toLowerCase()).toContain("prior");
    expect(p.toLowerCase()).toContain("evidence");
  });

  it("does not include shared context (members already digested it)", () => {
    const survivors: CouncilMemberResult[] = [
      {
        spec: { model: "m1", role: "critic", weight: 1 },
        status: "ok",
        durationMs: 1,
        output: { verdict: "yes", confidence: 0.8, rationale: "ok" },
      },
    ];
    const p = buildSynthPrompt(
      config,
      { question: "Ship it?", context: "THIS IS A HUGE CONTEXT BLOCK" },
      survivors,
    );
    expect(p).not.toContain("THIS IS A HUGE CONTEXT BLOCK");
    expect(p).toContain("Ship it?");
  });
});

describe("extractJsonCandidates + balancedBlocks", () => {
  it("extracts sentinel-wrapped JSON", () => {
    const out = 'noise\n<<<JSON>>>{"verdict":"ok","confidence":0.8,"rationale":"x"}<<<END>>>\nmore';
    const cands = extractJsonCandidates(out);
    expect(cands[0]).toBe('{"verdict":"ok","confidence":0.8,"rationale":"x"}');
  });

  it("enumerates balanced blocks ignoring braces inside strings", () => {
    const blocks = balancedBlocks('a {"k":"v with } brace"} b {"x":1}');
    expect(blocks).toEqual(['{"k":"v with } brace"}', '{"x":1}']);
  });
});

describe("parseMemberOutput", () => {
  it("parses fence-wrapped JSON (no sentinels)", () => {
    const out = '```json\n{"verdict":"go","confidence":0.7,"rationale":"fine"}\n```';
    const parsed = parseMemberOutput(out);
    expect(parsed?.verdict).toBe("go");
  });

  it("returns the FIRST schema-valid block, skipping a decoy", () => {
    const out =
      'Thinking... {"error":"oops"} then answer: ' +
      '<<<JSON>>>{"verdict":"real","confidence":0.6,"rationale":"because"}<<<END>>>';
    const parsed = parseMemberOutput(out);
    expect(parsed?.verdict).toBe("real");
  });

  it("returns null when nothing validates", () => {
    expect(parseMemberOutput("just prose, no json")).toBeNull();
    expect(parseMemberOutput('{"notamember":true}')).toBeNull();
  });
});

describe("parseSynthOutput", () => {
  it("parses and backfills missing optional fields", () => {
    const out = '<<<JSON>>>{"verdict":"final","confidence":0.85,"rationale":"merged"}<<<END>>>';
    const parsed = parseSynthOutput(out);
    expect(parsed?.verdict).toBe("final");
    expect(parsed?.minority_report).toBe("");
    expect(parsed?.per_member_summary).toEqual([]);
  });
});
