import { existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { canonicalJson } from "./types.js";
import { ompRoot } from "../omp-root.js";
import { atomicWrite } from "../utils/fs.js";

export interface SkillBenchPaths {
  projectRoot: string;
  globalRoot: string;
  projectSpecsDir: string;
  projectRunsDir: string;
  globalSpecsDir: string;
  globalRunsDir: string;
}

export type SkillBenchScope = "project" | "global";

export function resolveSkillBenchPaths(options: { cwd?: string; home?: string } = {}): SkillBenchPaths {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const home = path.resolve(options.home ?? homedir());
  const projectRoot = path.join(ompRoot(cwd), ".omp", "skill-bench");
  const globalRoot = path.join(home, ".omp", "skill-bench");
  return {
    projectRoot,
    globalRoot,
    projectSpecsDir: path.join(projectRoot, "specs"),
    projectRunsDir: path.join(projectRoot, "runs"),
    globalSpecsDir: path.join(globalRoot, "specs"),
    globalRunsDir: path.join(globalRoot, "runs"),
  };
}

function rootFor(paths: SkillBenchPaths, scope: SkillBenchScope): string {
  return scope === "project" ? paths.projectRoot : paths.globalRoot;
}

export function resolveSkillBenchOutputPath(paths: SkillBenchPaths, scope: SkillBenchScope, relativePath: string): string {
  if (path.isAbsolute(relativePath)) throw new Error("absolute output path is not allowed");
  if (relativePath.split(/[\\/]+/).some((part) => part === ".." || part === "")) throw new Error("unsafe relative path");
  const root = rootFor(paths, scope);
  const target = path.resolve(root, relativePath);
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("output path escapes skill-bench root");
  assertNoSymlinkEscape(root, target);
  return target;
}

function assertNoSymlinkEscape(root: string, target: string): void {
  const absoluteRoot = path.resolve(root);
  const trustedBase = path.dirname(path.dirname(absoluteRoot));
  let current = trustedBase;
  const existingParts = path.relative(trustedBase, target).split(path.sep).filter(Boolean);
  for (const part of existingParts) {
    current = path.join(current, part);
    if (!existsSync(current)) break;
    if (lstatSync(current).isSymbolicLink()) {
      throw current === absoluteRoot ? new Error("symlink root blocked") : new Error("symlink escape blocked");
    }
  }

  if (!existsSync(absoluteRoot)) return;
  const realRoot = realpathSync(absoluteRoot);
  current = absoluteRoot;
  const relativeParts = path.relative(absoluteRoot, target).split(path.sep).filter(Boolean);
  for (const part of relativeParts) {
    current = path.join(current, part);
    if (!existsSync(current)) break;
    if (lstatSync(current).isSymbolicLink()) throw new Error("symlink escape blocked");
    const real = realpathSync(current);
    const rel = path.relative(realRoot, real);
    if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("symlink escape blocked");
  }
}

export function writeSkillBenchJsonAtomic(paths: SkillBenchPaths, scope: SkillBenchScope, relativePath: string, value: unknown): string {
  const target = resolveSkillBenchOutputPath(paths, scope, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  atomicWrite(target, `${canonicalJson(value)}\n`);
  return target;
}
