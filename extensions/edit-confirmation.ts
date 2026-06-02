// ~/.pi/agent/extensions/edit-confirmation.ts
// Confirms edit, write, and bash tool calls with the user before execution.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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
      const confirmed = await ctx.ui.confirm(
        `Edit: ${path}`,
        `Confirm this edit?`,
      );

      if (!confirmed) {
        return { block: true, reason: "Edit cancelled by user" };
      }
      return undefined;
    }

    // --- write tool ---
    if (event.toolName === "write") {
      const input = event.input as Record<string, unknown>;
      const path = input.path as string;

      const confirmed = await ctx.ui.confirm(
        `Write: ${path}`,
        `Confirm write?`,
      );

      if (!confirmed) {
        return { block: true, reason: "Write cancelled by user" };
      }
      return undefined;
    }

    // --- bash tool ---
    if (event.toolName === "bash") {
      const input = event.input as Record<string, unknown>;
      const command = input.command as string;

      // Auto-allow whitelisted commands
      const whitelisted = ["grep", "find", "ls", "cat", "node --test", "git diff", "npm ls", "npm show"];
      for (const cmd of whitelisted) {
        if (
          command === cmd ||
          command.startsWith(cmd + " ") ||
          command.startsWith(`cd ${ctx.cwd} && ${cmd}`)
        ) {
          return undefined;
        }
      }

      const confirmed = await ctx.ui.confirm(
        `Bash: ${command.slice(0, 120)}`,
        `Run this command?`,
      );

      if (!confirmed) {
        return { block: true, reason: "Bash command cancelled by user" };
      }
      return undefined;
    }
  });
}
