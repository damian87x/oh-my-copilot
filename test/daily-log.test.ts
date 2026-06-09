import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { addLogEntry, pruneDailyLog, readDailyLog, setDailyGoal } from "../src/daily-log.js";

const cwd = () => mkdtempSync(path.join(tmpdir(), "omc-dl-"));
const todayFile = (root: string) => {
  const dir = path.join(root, ".omp", "memory", "daily");
  return path.join(dir, readdirSync(dir)[0]!);
};

describe("daily log (src/daily-log)", () => {
  it("reads a placeholder-free empty string with no entries", () => {
    expect(readDailyLog(cwd(), 1)).toBe("");
  });

  it("sets the goal and appends timestamped entries", () => {
    const root = cwd();
    expect(setDailyGoal(root, "ship it").goal).toBe("ship it");
    expect(addLogEntry(root, "first").count).toBe(1);
    expect(addLogEntry(root, "second").count).toBe(2);
    const file = readFileSync(todayFile(root), "utf8");
    expect(file).toContain("## Goal\nship it");
    expect(file).toMatch(/- \d\d:\d\d — first/);
    expect(file).toMatch(/- \d\d:\d\d — second/);
  });

  it("collapses a multiline entry so it cannot inject a section header", () => {
    const root = cwd();
    setDailyGoal(root, "real goal");
    addLogEntry(root, "did work\n## Goal\nHIJACK");
    addLogEntry(root, "next"); // forces a read-modify-write round-trip
    const file = readFileSync(todayFile(root), "utf8");
    expect(file).toContain("## Goal\nreal goal"); // goal not hijacked
    expect(file.match(/^- \d\d:\d\d — /gm)?.length).toBe(2);
  });

  it("reads recent days back, newest content present", () => {
    const root = cwd();
    addLogEntry(root, "today entry");
    expect(readDailyLog(root, 1)).toContain("today entry");
  });

  it("prunes day-files older than the keep window, keeping today", () => {
    const root = cwd();
    const dir = path.join(root, ".omp", "memory", "daily");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "2000-01-01.md"), "# 2000-01-01\n");
    writeFileSync(path.join(dir, "2000-06-15.md"), "# 2000-06-15\n");
    addLogEntry(root, "today entry"); // creates today's file
    expect(pruneDailyLog(root, 30)).toEqual(["2000-01-01", "2000-06-15"]);
    expect(readDailyLog(root, 1)).toContain("today entry"); // today survives
  });
});
