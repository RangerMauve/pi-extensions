import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    // Hide entire working indicator (label + spinner)
    ctx.ui.setWorkingVisible(false);

    // Replace footer with an empty renderer to remove the status bar
    ctx.ui.setFooter((_tui, _theme, _footerData) => ({
      invalidate() {},
      render(width: number): string[] {
        return [];
      },
      dispose() {},
    }));
  });
}
