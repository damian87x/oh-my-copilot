import { describe, expect, it } from "vitest";
import {
  GITHUB_COPILOT_PRICING_PAGE_URL,
  parseGitHubCopilotPricingMarkdown,
} from "../../src/skill-bench/pricing.js";

describe("GitHub Copilot public pricing", () => {
  it("parses unambiguous official model rates and excludes tiered models", () => {
    const snapshot = parseGitHubCopilotPricingMarkdown(`
### OpenAI
| Model | Release status | Category | Tier | Threshold (input tokens) | Input | Cached input | Output |
| --- | --- | --- | --- | --- | ---: | ---: | ---: |
| GPT-5.6 Luna | GA | Lightweight | Default | <= 200K | $1.00 | $0.10 | $6.00 |
| GPT-5.6 Luna | GA | Lightweight | Long context | > 200K | $2.00 | $0.20 | $9.00 |

### Microsoft
| Model | Release status | Category | Input | Cached input | Output |
| --- | --- | --- | ---: | ---: | ---: |
| MAI-Code-1-Flash | GA | Lightweight | $0.75 | $0.075 | $4.50 |
`, "2026-07-15T12:00:00.000Z");

    expect(snapshot).toMatchObject({
      source: "public-github-copilot-model-pricing",
      url: GITHUB_COPILOT_PRICING_PAGE_URL,
      retrievedAt: "2026-07-15T12:00:00.000Z",
      currency: "USD",
      completeness: "unambiguous-model-rates",
      models: {
        "mai-code-1-flash": {
          inputUsdPerMillion: 0.75,
          cacheReadUsdPerMillion: 0.075,
          outputUsdPerMillion: 4.5,
        },
      },
    });
    expect(snapshot.models).not.toHaveProperty("gpt-5.6-luna");
    expect(snapshot.unresolvedTieredModels).toEqual(["gpt-5.6-luna"]);
  });
});
