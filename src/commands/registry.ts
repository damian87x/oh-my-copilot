import type { CommandModule } from "./types.js";
import { suggestCommand } from "./suggest.js";
import { modelsCommand } from "./models.js";

const COMMANDS: CommandModule[] = [suggestCommand, modelsCommand];

export function findRegisteredCommand(name: string | undefined): CommandModule | undefined {
  if (!name) return undefined;
  return COMMANDS.find((command) => command.name === name || command.aliases?.includes(name));
}

export function registeredCommandHelpLines(): string[] {
  return COMMANDS.map((command) => `  ${command.name.padEnd(44)} ${command.summary}`);
}
