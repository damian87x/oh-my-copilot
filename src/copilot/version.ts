import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { packageRootFromImportMeta, resolveProjectPaths } from "../project.js";

export interface VersionInfo {
  package: string;
  node: string;
  platform: string;
  packageRoot: string;
}

export interface VersionOptions {
  cwd?: string;
  packageRoot?: string;
  importMetaUrl?: string;
}

export function getVersionInfo(options: VersionOptions = {}): VersionInfo {
  const root = options.importMetaUrl
    ? packageRootFromImportMeta(options.importMetaUrl)
    : resolveProjectPaths({ cwd: options.cwd, packageRoot: options.packageRoot }).packageRoot;
  const pkgPath = join(root, "package.json");
  let pkgVersion = "unknown";
  if (existsSync(pkgPath)) {
    try {
      const parsed = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
      pkgVersion = parsed.version ?? "unknown";
    } catch {
      // keep "unknown" — manifest is unreadable
    }
  }
  return {
    package: pkgVersion,
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    packageRoot: root,
  };
}

export function formatVersionInfo(info: VersionInfo): string {
  return [
    `oh-my-copilot ${info.package}`,
    `node ${info.node}`,
    `platform ${info.platform}`,
    `packageRoot ${info.packageRoot}`,
  ].join("\n");
}
