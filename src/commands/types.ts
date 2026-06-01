export interface CliResult {
  ok: boolean;
  exitCode?: number;
  output?: unknown;
  message?: string;
}

export interface CliContext {
  cwd: string;
  json: boolean;
}

export interface CommandModule {
  name: string;
  aliases?: string[];
  summary: string;
  run(argv: string[], context: CliContext): Promise<CliResult> | CliResult;
}
