import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveCopilotPaths, type CopilotPaths, type ResolveCopilotPathsOptions } from "./paths.js";

export interface CopilotConfig {
  pluginDirMode: boolean;
  hooksEnabled: boolean;
  paths: CopilotPaths;
}

interface PartialFileConfig {
  pluginDirMode?: boolean;
  hooksEnabled?: boolean;
}

export function loadCopilotConfig(options: ResolveCopilotPathsOptions = {}): CopilotConfig {
  const paths = resolveCopilotPaths(options);
  const configFile = join(paths.projectRoot, ".omp", "config.json");
  let fileConfig: PartialFileConfig = {};
  if (existsSync(configFile)) {
    try {
      fileConfig = JSON.parse(readFileSync(configFile, "utf8")) as PartialFileConfig;
    } catch {
      // ignore unreadable config; treat as absent
    }
  }
  const pluginDirModeEnv =
    process.env.OMP_PLUGIN_DIR_MODE ?? process.env.OMC_PLUGIN_DIR_MODE;
  const hooksDisabledEnv =
    process.env.OMP_HOOKS_DISABLED ?? process.env.OMC_HOOKS_DISABLED;
  return {
    pluginDirMode: pluginDirModeEnv === "1" || Boolean(fileConfig.pluginDirMode),
    hooksEnabled: hooksDisabledEnv === "1" ? false : fileConfig.hooksEnabled ?? true,
    paths,
  };
}
