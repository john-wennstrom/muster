export interface CommandProfile {
  id: string;
  executables: readonly string[];
  maximumTimeoutMs: number;
  environment: readonly string[];
}

export const HOST_EXECUTION_SECURITY_NOTICE =
  "Beta host commands are brokered and audited, but these controls do not provide operating-system process or network isolation.";

const PORTABLE_ENVIRONMENT = ["PATH", "PATHEXT", "SystemRoot", "WINDIR", "TEMP", "TMP"] as const;

export const COMMAND_PROFILES: Readonly<Record<string, CommandProfile>> = {
  verification: {
    id: "verification",
    executables: ["bun", "node", "npm", "npx", "git", "openspec"],
    maximumTimeoutMs: 120_000,
    environment: PORTABLE_ENVIRONMENT,
  },
  "git-readonly": {
    id: "git-readonly",
    executables: ["git"],
    maximumTimeoutMs: 30_000,
    environment: PORTABLE_ENVIRONMENT,
  },
};

const SHELL_EXECUTABLES = new Set([
  "bash",
  "cmd",
  "cmd.exe",
  "command",
  "csh",
  "dash",
  "fish",
  "ksh",
  "powershell",
  "powershell.exe",
  "pwsh",
  "pwsh.exe",
  "sh",
  "wsl",
  "zsh",
]);

export class CommandProfileError extends Error {
  constructor(
    readonly code:
      | "COMMAND_PROFILE_UNKNOWN"
      | "COMMAND_EXECUTABLE_DENIED"
      | "COMMAND_ARGUMENT_INVALID"
      | "COMMAND_TIMEOUT_INVALID",
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "CommandProfileError";
  }
}

export function resolveCommandProfile(
  profileId: string,
  profiles: Readonly<Record<string, CommandProfile>> = COMMAND_PROFILES,
): CommandProfile {
  const profile = profiles[profileId];
  if (!profile) {
    throw new CommandProfileError(
      "COMMAND_PROFILE_UNKNOWN",
      `Unsupported command profile ${profileId}`,
      { profileId },
    );
  }
  return profile;
}

export function validateExecutable(profile: CommandProfile, executable: string): string {
  const normalized = executable.toLocaleLowerCase();
  if (
    !executable ||
    executable.includes("/") ||
    executable.includes("\\") ||
    SHELL_EXECUTABLES.has(normalized) ||
    !profile.executables.some((allowed) => allowed.toLocaleLowerCase() === normalized)
  ) {
    throw new CommandProfileError(
      "COMMAND_EXECUTABLE_DENIED",
      `Executable ${JSON.stringify(executable)} is not allowed by profile ${profile.id}`,
      { profileId: profile.id, executable },
    );
  }
  return executable;
}

export function validateArguments(args: readonly string[]): string[] {
  return args.map((argument, index) => {
    if (typeof argument !== "string" || argument.includes("\0")) {
      throw new CommandProfileError(
        "COMMAND_ARGUMENT_INVALID",
        `Command argument ${index} is invalid`,
        { index },
      );
    }
    return argument;
  });
}

export function validateTimeout(profile: CommandProfile, timeoutMs?: number): number {
  const selected = timeoutMs ?? profile.maximumTimeoutMs;
  if (!Number.isInteger(selected) || selected <= 0 || selected > profile.maximumTimeoutMs) {
    throw new CommandProfileError(
      "COMMAND_TIMEOUT_INVALID",
      `Command timeout must be between 1 and ${profile.maximumTimeoutMs}ms`,
      { profileId: profile.id, timeoutMs: selected },
    );
  }
  return selected;
}
