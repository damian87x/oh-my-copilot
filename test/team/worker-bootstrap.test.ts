import { describe, expect, it } from "vitest";
import { buildInboxMarkdown } from "../../src/team/worker-bootstrap.js";

describe("buildInboxMarkdown", () => {
  it("renders the four-step task lifecycle with the right identifiers", () => {
    const md = buildInboxMarkdown({
      teamName: "auth-review",
      workerName: "worker-2",
      cwd: "/tmp/project",
      task: {
        id: "3",
        description: "Audit refresh-token flow",
        status: "pending",
        createdAt: "2026-05-23T12:00:00Z",
      },
    });
    expect(md).toContain("omp team api claim-task");
    expect(md).toContain("omp team api transition-task-status");
    expect(md).toContain("\"team_name\":\"auth-review\"");
    expect(md).toContain("\"task_id\":\"3\"");
    expect(md).toContain("\"worker\":\"worker-2\"");
    expect(md).toContain("\"cwd\":\"/tmp/project\"");
    expect(md).toContain("Task ID: 3");
    expect(md).toContain("Worker: worker-2");
    expect(md).toContain("Audit refresh-token flow");
  });

  it("includes a Messaging section teaching leader + peer messaging", () => {
    const md = buildInboxMarkdown({
      teamName: "auth-review",
      workerName: "worker-2",
      cwd: "/tmp/project",
      task: {
        id: "3",
        description: "Audit refresh-token flow",
        status: "pending",
        createdAt: "2026-05-23T12:00:00Z",
      },
    });
    expect(md).toContain("## Messaging");
    expect(md).toContain("omp team api send-message");
    expect(md).toContain("\"to\":\"leader\"");
    expect(md).toContain("\"to\":\"<teammate>\"");
    expect(md).toContain("\"from\":\"worker-2\"");
    expect(md).toContain("omp team api mailbox-list");
    expect(md).toContain("unknown_recipient");
  });
});
