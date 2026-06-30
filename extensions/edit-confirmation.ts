// ~/.pi/agent/extensions/edit-confirmation.ts
// Confirms edit, write, and bash tool calls with the user before execution.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// -- Allowed commands (read-only / harmless) --
const ALLOWED_COMMANDS = [
  // shell utils
  "grep",
  "find",
  "ls",
  "cat",
  "head",
  "wc",
  "which",

  // version checks
  "go version",
  "node --version",
  "python --version",
  "ruby --version",
  "cargo --version",
  "pnpm --version",
  "yarn --version",

  // git
  "git diff",
  "git status",
  "git log",
  "git show",
  "git branch",
  "git remote -v",

  // node / js
  "node --test",
  "npm test",
  "npm run test",
  "npm run format",
  "npm run lint",
  "npm ls",
  "npm show",
  "npm search",

  // go
  "go mod verify",
  "go list",
  "go list -m -mod=mod",
  "go mod graph",

  // rust
  "cargo check",
  "cargo metadata",
  "cargo tree",

  // python / venv
  "pip list",
  "pip show",
  "poetry show",
  "uv pip list",
  "uv pip show",

  // gradle
  "gradle dependencies",
  "gradle projects",
  "gradle tasks",
];

function isAllowed(command: string, cwd: string): boolean {
  for (const cmd of ALLOWED_COMMANDS) {
    if (
      command === cmd ||
      command.startsWith(cmd + " ") ||
      command.startsWith(cmd + "\t") ||
      command.startsWith(`cd ${cwd} && ${cmd}`)
    ) {
      return true;
    }
  }
  return false;
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    if (!ctx.hasUI) {
      // In print/RPC mode, allow through (no UI to ask)
      return undefined;
    }

    // --- edit tool ---
    if (event.toolName === "edit") {
      const input = event.input as Record<string, unknown>;
      const path = input.path as string;

      const confirmed = await ctx.ui.confirm(`Edit: ${path}`, "Confirm this edit?");

      if (!confirmed) {
        return { block: true, reason: "Edit cancelled by user" };
      }

      return undefined;
    }

    // --- write tool ---
    if (event.toolName === "write") {
      const input = event.input as Record<string, unknown>;
      const path = input.path as string;

      const confirmed = await ctx.ui.confirm(`Write: ${path}`, "Confirm write?");

      if (!confirmed) {
        return { block: true, reason: "Write cancelled by user" };
      }

      return undefined;
    }

    // --- bash tool ---
    if (event.toolName === "bash") {
      const input = event.input as Record<string, unknown>;
      const command = input.command as string;

      // Auto-allow allowed commands
      if (isAllowed(command, ctx.cwd)) {
        return undefined;
      }

      // Strip the "cd cwd &&" prefix for cleaner display
      const displayPrefix = `cd ${ctx.cwd} && `;
      const displayCommand = command.startsWith(displayPrefix)
        ? command.slice(displayPrefix.length)
        : command;

      const confirmed = await ctx.ui.confirm(
        `Bash: ${displayCommand.slice(0, 120)}`,
        "Run this command?",
      );

      if (!confirmed) {
        return { block: true, reason: "Bash command cancelled by user" };
      }

      return undefined;
    }
  });
}
