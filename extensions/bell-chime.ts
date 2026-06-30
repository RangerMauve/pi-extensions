// Plays a terminal bell when the agent finishes generating.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("agent_end", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    process.stdout.write("\x07");
  });
}
