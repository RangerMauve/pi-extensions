/**
 * Chrome DevTools Protocol (CDP) Extension for Pi
 *
 * Connect to Electron (or any Chromium-based app) remote debugging ports
 * via --remote-debugging-port and interact with the running app:
 * - List targets (pages, workers, service workers)
 * - Evaluate JavaScript in page contexts
 * - Navigate pages
 * - Take screenshots
 * - Read console logs
 * - Inspect the DOM
 * - Click elements and type into inputs
 */

import { writeFile } from "node:fs/promises";
import { WebSocket } from "ws";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ── Types ──────────────────────────────────────────────────────────────

interface TargetInfo {
  targetId: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl: string;
}

interface ConsoleMessage {
  level: string;
  text: string;
  timestamp: string;
  targetId?: string;
}

interface CdpConnection {
  host: string;
  port: number;
  targets: Map<string, TargetInfo>;
  consoleMessages: ConsoleMessage[];
}

// ── State ──────────────────────────────────────────────────────────────

let connection: CdpConnection | null = null;

// ── HTTP Discovery ─────────────────────────────────────────────────────

async function fetchJson(url: string): Promise<any> {
  const http = (await import("node:http")).default;
  return new Promise<any>((resolve, reject) => {
    http.get(url, (res) => {
      let data = "";
      res.on("data", (chunk: Buffer) => data += chunk);
      res.on("end", () => {
        try { resolve(JSON.parse(data)); } catch { reject(new Error(`Invalid JSON from ${url}`)); }
      });
    }).on("error", reject);
  });
}

// ── Per-Target WebSocket Connection ────────────────────────────────────

type PendingHandler = { resolve: (v: any) => void; reject: (e: any) => void };

// Augment WebSocket with our tracking fields
declare module "ws" {
  interface WebSocket {
    _seq?: number;
    _pending?: Map<number, PendingHandler>;
  }
}

function initWs(ws: WebSocket): void {
  if (!ws._seq) ws._seq = 0;
  if (!ws._pending) ws._pending = new Map();
}

function wsSend(ws: WebSocket, method: string, params: Record<string, any> = {}): Promise<any> {
  initWs(ws);
  const id = ++ws._seq!;
  return new Promise((resolve, reject) => {
    ws._pending!.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (ws._pending!.has(id)) {
        ws._pending!.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }
    }, 30_000);
  });
}

/**
 * Open a WebSocket connection to a specific target page and execute a function.
 * Sets up message handling for CDP responses and console messages.
 */
async function withPage(ws: WebSocket, targetId: string, fn: (ws: WebSocket) => Promise<any>): Promise<any> {
  return new Promise<void>((resolveConn, rejectConn) => {
    ws.on("open", () => {
      // Set up message handler
      ws.once("message", setupHandler);
    });
    ws.on("error", rejectConn);

    function setupHandler(data: Buffer) {
      handleMsg(data);
      ws.on("message", handleMsg);
    }

    function handleMsg(data: Buffer) {
      try {
        const msg = JSON.parse(data.toString());

        if (msg.id && ws._pending?.has(msg.id)) {
          const h = ws._pending!.get(msg.id)!;
          ws._pending!.delete(msg.id);
          msg.error ? h.reject(new Error(`CDP error: ${JSON.stringify(msg.error)}`)) : h.resolve(msg.result);
        }

        // Capture console messages
        if (msg.method === "Runtime.consoleAPICalled" && msg.params && connection) {
          const p = msg.params as any;
          connection.consoleMessages.push({
            level: p.type ?? "log",
            text: p.args?.map((a: any) => a.value ?? a.description ?? "").join(" ") ?? "",
            timestamp: new Date().toISOString(),
            targetId,
          });
          if (connection.consoleMessages.length > 500) {
            connection.consoleMessages = connection.consoleMessages.slice(-500);
          }
        }
      } catch {}
    }

    // Execute the function
    fn(ws)
      .then((result) => {
        ws.close();
        resolveConn();
      })
      .catch((err) => {
        ws.close();
        rejectConn(err);
      });
  });
}

async function doWithTarget(targetId: string, fn: (ws: WebSocket) => Promise<any>): Promise<any> {
  if (!connection) throw new Error("Not connected. Run cdp_connect first.");

  const target = connection.targets.get(targetId);
  if (!target) throw new Error(`Target not found: ${targetId}`);

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  initWs(ws);

  return new Promise<any>((resolve, reject) => {
    ws.on("open", async () => {
      try {
        const result = await fn(ws);
        ws.close();
        resolve(result);
      } catch (err) {
        ws.close();
        reject(err);
      }
    });
    ws.on("error", reject);

    // Set up message handler for CDP responses
    ws.on("message", (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.id && ws._pending?.has(msg.id)) {
          const h = ws._pending!.get(msg.id)!;
          ws._pending!.delete(msg.id);
          msg.error ? h.reject(new Error(`CDP error: ${JSON.stringify(msg.error)}`)) : h.resolve(msg.result);
        }
        if (msg.method === "Runtime.consoleAPICalled" && msg.params && connection) {
          const p = msg.params as any;
          connection.consoleMessages.push({
            level: p.type ?? "log",
            text: p.args?.map((a: any) => a.value ?? a.description ?? "").join(" ") ?? "",
            timestamp: new Date().toISOString(),
            targetId,
          });
          if (connection.consoleMessages.length > 500) {
            connection.consoleMessages = connection.consoleMessages.slice(-500);
          }
        }
      } catch {}
    });
  });
}

function getActiveTarget(): TargetInfo | null {
  if (!connection) return null;
  const pages = Array.from(connection.targets.values()).filter(
    (t) => t.type === "page" && t.url &&
           !t.url.startsWith("chrome-extension") &&
           !t.url.startsWith("devtools://") &&
           !t.url.includes("app.asar")
  );
  return pages[0] ?? null;
}

function resolveTarget(id?: string): TargetInfo | null {
  if (!connection) return null;
  if (id) return connection.targets.get(id) ?? null;
  return getActiveTarget();
}

// ── Extension Entry Point ──────────────────────────────────────────────

export default function (pi: ExtensionAPI) {

  // ── cdp_connect ──

  pi.registerTool({
    name: "cdp_connect",
    label: "CDP Connect",
    description:
      "Connect to a Chrome DevTools Protocol endpoint (e.g., Electron with --remote-debugging-port). " +
      "Returns available targets (pages, workers). Use this before other CDP tools.",
    parameters: Type.Object({
      port: Type.Integer({ description: "The remote debugging port (default: 9222)" }),
      host: Type.Optional(Type.String({ description: "The host (default: localhost)" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const port = params.port ?? 9222;
      const host = params.host ?? "localhost";

      try {
        const jsonUrl = `http://${host}:${port}/json`;
        const targets: any[] = await fetchJson(jsonUrl);

        connection = {
          host,
          port,
          targets: new Map(),
          consoleMessages: [],
        };

        for (const t of targets) {
          connection.targets.set(t.id, {
            targetId: t.id,
            type: t.type,
            title: t.title || "",
            url: t.url || "",
            webSocketDebuggerUrl: t.webSocketDebuggerUrl,
          });
        }

        const pageTargets = Array.from(connection.targets.values()).filter(t => t.type === "page");
        const lines = pageTargets.slice(0, 20).map(
          (t) => `  ${t.targetId}\n    Type: ${t.type}\n    Title: ${t.title || "(untitled)"}\n    URL: ${t.url.slice(0, 120) || "(about:blank)"}`,
        );

        const note = pageTargets.length > 20 ? `\n  ... and ${pageTargets.length - 20} more` : "";

        return {
          content: [{
            type: "text",
            text: `Connected to CDP endpoint ${host}:${port}\n\nFound ${connection.targets.size} target(s) (${pageTargets.length} pages):\n\n${lines.join("\n\n")}${note}`,
          }],
        };
      } catch (err: any) {
        return {
          content: [{
            type: "text",
            text: `Failed to connect to ${host}:${port}: ${err.message}. Make sure Electron is running with --remote-debugging-port=${port}`,
          }],
          isError: true,
        };
      }
    },
  });

  // ── cdp_targets ──

  pi.registerTool({
    name: "cdp_targets",
    label: "CDP List Targets",
    description:
      "List all available CDP targets (pages, workers, service workers). " +
      "Use the targetId to specify which page to interact with in other commands.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      if (!connection) {
        return { content: [{ type: "text", text: "Not connected. Run cdp_connect first." }], isError: true };
      }

      // Refresh via HTTP
      try {
        const jsonUrl = `http://${connection.host}:${connection.port}/json`;
        const targets: any[] = await fetchJson(jsonUrl);
        connection.targets.clear();
        for (const t of targets) {
          connection.targets.set(t.id, {
            targetId: t.id,
            type: t.type,
            title: t.title || "",
            url: t.url || "",
            webSocketDebuggerUrl: t.webSocketDebuggerUrl,
          });
        }
      } catch {}

      const allTargets = Array.from(connection.targets.values());
      const targetList = allTargets.map(
        (t) => `  ${t.targetId}\n    Type: ${t.type}\n    Title: ${t.title || "(untitled)"}\n    URL: ${t.url.slice(0, 120) || "(about:blank)"}`,
      ).join("\n\n");

      return {
        content: [{
          type: "text",
          text: `Found ${allTargets.length} target(s):\n\n${targetList}`,
        }],
      };
    },
  });

  // ── cdp_evaluate ──

  pi.registerTool({
    name: "cdp_evaluate",
    label: "CDP Evaluate JavaScript",
    description:
      "Execute JavaScript in a page's context. Returns the result as a serialized value. " +
      "If targetId is not specified, uses the first available page.",
    parameters: Type.Object({
      expression: Type.String({ description: "JavaScript expression to evaluate" }),
      targetId: Type.Optional(Type.String({ description: "Target page ID (default: first page)" })),
      returnByValue: Type.Optional(Type.Boolean({ description: "Return result by value instead of by reference (default: true)" })),
      awaitPromise: Type.Optional(Type.Boolean({ description: "Whether to await the promise result (default: true)" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const target = resolveTarget(params.targetId);
      if (!target) return { content: [{ type: "text", text: "No target found. Run cdp_targets to see available pages." }], isError: true };

      try {
        const result = await doWithTarget(target.targetId, async (ws) => {
          await wsSend(ws, "Runtime.enable");
          return wsSend(ws, "Runtime.evaluate", {
            expression: params.expression,
            returnByValue: params.returnByValue ?? true,
            awaitPromise: params.awaitPromise ?? true,
            userGesture: true,
          });
        });

        if (result.exceptionDetails) {
          return { content: [{ type: "text", text: `JavaScript error:\n${JSON.stringify(result.exceptionDetails, null, 2)}` }], isError: true };
        }

        const value = result.result;
        return {
          content: [{
            type: "text",
            text: value.value !== undefined ? String(value.value) : (value.description ?? "undefined"),
          }],
        };
      } catch (err: any) {
        return { content: [{ type: "text", text: `Evaluation error: ${err.message}` }], isError: true };
      }
    },
  });

  // ── cdp_navigate ──

  pi.registerTool({
    name: "cdp_navigate",
    label: "CDP Navigate",
    description:
      "Navigate a page to a URL. If targetId is not specified, uses the first available page.",
    parameters: Type.Object({
      url: Type.String({ description: "URL to navigate to" }),
      targetId: Type.Optional(Type.String({ description: "Target page ID (default: first page)" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const target = resolveTarget(params.targetId);
      if (!target) return { content: [{ type: "text", text: "No target found. Run cdp_targets to see available pages." }], isError: true };

      try {
        const result = await doWithTarget(target.targetId, async (ws) => {
          await wsSend(ws, "Page.enable");
          return wsSend(ws, "Page.navigate", { url: params.url });
        });

        if (result.errorText) {
          return { content: [{ type: "text", text: `Navigation error: ${result.errorText}` }], isError: true };
        }

        return { content: [{ type: "text", text: `Navigated to ${params.url} (frame: ${result.frameId.slice(0, 8)}...)` }] };
      } catch (err: any) {
        return { content: [{ type: "text", text: `Navigation error: ${err.message}` }], isError: true };
      }
    },
  });

  // ── cdp_screenshot ──

  pi.registerTool({
    name: "cdp_screenshot",
    label: "CDP Screenshot",
    description:
      "Take a screenshot of the page. Saves as a PNG file. If targetId is not specified, uses the first page.",
    parameters: Type.Object({
      targetId: Type.Optional(Type.String({ description: "Target page ID (default: first page)" })),
      outputPath: Type.Optional(Type.String({ description: "Path to save screenshot (default: /tmp/cdp-screenshot.png)" })),
      quality: Type.Optional(Type.Integer({ description: "JPEG quality 0-100 if format is jpeg (default: 80)" })),
      format: Type.Optional(Type.Union([Type.Literal("png"), Type.Literal("jpeg"), Type.Literal("webp")])), // Image format (default: png)
      clip: Type.Optional(Type.Object({
        x: Type.Number(),
        y: Type.Number(),
        width: Type.Number(),
        height: Type.Number(),
        scale: Type.Optional(Type.Number()),
      }, { description: "Clip region to capture" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const target = resolveTarget(params.targetId);
      if (!target) return { content: [{ type: "text", text: "No target found. Run cdp_targets to see available pages." }], isError: true };

      try {
        const result = await doWithTarget(target.targetId, async (ws) => {
          return wsSend(ws, "Page.captureScreenshot", {
            format: params.format ?? "png",
            quality: params.quality ?? 80,
            clip: params.clip,
          });
        });

        const base64 = result.data;
        const format = params.format ?? "png";
        const mimeType = `image/${format}`;

        // Save to disk if outputPath specified
        if (params.outputPath) {
          await writeFile(params.outputPath, Buffer.from(base64, "base64"));
        }

        // Return image directly to pi so the model can see it
        return {
          content: [
            { type: "text", text: params.outputPath ? `Screenshot saved to ${params.outputPath}` : "Screenshot captured" },
            { type: "image", data: base64, mimeType },
          ],
        };
      } catch (err: any) {
        return { content: [{ type: "text", text: `Screenshot error: ${err.message}` }], isError: true };
      }
    },
  });

  // ── cdp_console ──

  pi.registerTool({
    name: "cdp_console",
    label: "CDP Console Logs",
    description:
      "Get recent console messages from the page. Optionally clear the buffer first.",
    parameters: Type.Object({
      limit: Type.Optional(Type.Integer({ description: "Number of recent messages to return (default: 50)" })),
      clear: Type.Optional(Type.Boolean({ description: "Clear the console buffer after reading (default: false)" })),
      targetId: Type.Optional(Type.String({ description: "Target page ID (default: first page)" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      if (!connection) {
        return { content: [{ type: "text", text: "Not connected. Run cdp_connect first." }], isError: true };
      }

      const target = resolveTarget(params.targetId);
      if (!target) return { content: [{ type: "text", text: "No target found." }], isError: true };

      // Enable Runtime to start capturing console
      await doWithTarget(target.targetId, async (ws) => {
        await wsSend(ws, "Runtime.enable");
        // Just enable and close - console messages will be captured
      }).catch(() => {});

      const limit = params.limit ?? 50;
      const messages = connection.consoleMessages.slice(-limit);

      if (params.clear) {
        connection.consoleMessages = [];
      }

      if (messages.length === 0) {
        return { content: [{ type: "text", text: "No console messages." }] };
      }

      const output = messages.map((m) => `[${m.level}] ${m.text}`).join("\n");
      return { content: [{ type: "text", text: `Last ${messages.length} console message(s):\n${output}` }] };
    },
  });

  // ── cdp_get_outer_html ──

  pi.registerTool({
    name: "cdp_get_outer_html",
    label: "CDP Get Outer HTML",
    description:
      "Get the full outer HTML of the page. Quick way to see the page structure. " +
      "If targetId is not specified, uses the first available page.",
    parameters: Type.Object({
      targetId: Type.Optional(Type.String({ description: "Target page ID (default: first page)" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const target = resolveTarget(params.targetId);
      if (!target) return { content: [{ type: "text", text: "No target found. Run cdp_targets to see available pages." }], isError: true };

      try {
        const result = await doWithTarget(target.targetId, async (ws) => {
          await wsSend(ws, "Runtime.enable");
          return wsSend(ws, "Runtime.evaluate", {
            expression: "document.documentElement.outerHTML",
            returnByValue: true,
            awaitPromise: true,
          });
        });

        if (result.exceptionDetails) {
          return { content: [{ type: "text", text: `Error: ${result.exceptionDetails.exception?.description ?? "unknown"}` }], isError: true };
        }

        return { content: [{ type: "text", text: result.result?.value ?? "(empty)" }] };
      } catch (err: any) {
        return { content: [{ type: "text", text: `Error getting HTML: ${err.message}` }], isError: true };
      }
    },
  });

  // ── cdp_get_dom ──

  pi.registerTool({
    name: "cdp_get_dom",
    label: "CDP Get DOM",
    description:
      "Get the DOM tree of the page. Optionally filter to a specific CSS selector.",
    parameters: Type.Object({
      targetId: Type.Optional(Type.String({ description: "Target page ID (default: first page)" })),
      cssSelector: Type.Optional(Type.String({ description: "CSS selector to find nodes (e.g., '#app')" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const target = resolveTarget(params.targetId);
      if (!target) return { content: [{ type: "text", text: "No target found. Run cdp_targets to see available pages." }], isError: true };

      try {
        const result = await doWithTarget(target.targetId, async (ws) => {
          await wsSend(ws, "Runtime.enable");

          if (params.cssSelector) {
            const evalResult = await wsSend(ws, "Runtime.evaluate", {
              expression: `(function() { const el = document.querySelector('${params.cssSelector.replace(/'/g, "\\'")}'); return el ? el.outerHTML : null; })()`,
              returnByValue: true,
              awaitPromise: true,
            });
            return evalResult.result?.value ?? null;
          }

          // Return document structure summary
          const evalResult = await wsSend(ws, "Runtime.evaluate", {
            expression: `(function() { return { title: document.title, meta: Array.from(document.querySelectorAll('meta')).map(m => m.getAttribute('name') + '=' + m.getAttribute('content')).join(', '), links: Array.from(document.querySelectorAll('a[href]')).slice(0, 20).map(a => a.href) }; })()`,
            returnByValue: true,
            awaitPromise: true,
          });
          return evalResult.result?.value;
        });

        if (result === null) {
          return { content: [{ type: "text", text: `No element found for selector "${params.cssSelector}"` }] };
        }

        return { content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result, null, 2) }] };
      } catch (err: any) {
        return { content: [{ type: "text", text: `DOM error: ${err.message}` }], isError: true };
      }
    },
  });

  // ── cdp_click ──

  pi.registerTool({
    name: "cdp_click",
    label: "CDP Click",
    description:
      "Click an element on the page using a CSS selector.",
    parameters: Type.Object({
      cssSelector: Type.String({ description: "CSS selector of the element to click (e.g., 'button.submit')" }),
      targetId: Type.Optional(Type.String({ description: "Target page ID (default: first page)" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const target = resolveTarget(params.targetId);
      if (!target) return { content: [{ type: "text", text: "No target found." }], isError: true };

      try {
        const result = await doWithTarget(target.targetId, async (ws) => {
          await wsSend(ws, "Runtime.enable");
          return wsSend(ws, "Runtime.evaluate", {
            expression: `(function() { const el = document.querySelector('${params.cssSelector.replace(/'/g, "\\'")}'); if (!el) throw new Error('Element not found: ' + '${params.cssSelector.replace(/'/g, "\\'")}'); el.click(); return 'clicked'; })()`,
            returnByValue: true,
            awaitPromise: true,
          });
        });

        if (result.exceptionDetails) {
          return { content: [{ type: "text", text: `Click failed: ${result.exceptionDetails.exception?.description ?? "unknown"}` }], isError: true };
        }

        return { content: [{ type: "text", text: `Clicked element matching "${params.cssSelector}"` }] };
      } catch (err: any) {
        return { content: [{ type: "text", text: `Click error: ${err.message}` }], isError: true };
      }
    },
  });

  // ── cdp_type ──

  pi.registerTool({
    name: "cdp_type",
    label: "CDP Type Text",
    description:
      "Type text into an input element on the page using a CSS selector.",
    parameters: Type.Object({
      cssSelector: Type.String({ description: "CSS selector of the input element" }),
      text: Type.String({ description: "Text to type into the element" }),
      targetId: Type.Optional(Type.String({ description: "Target page ID (default: first page)" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const target = resolveTarget(params.targetId);
      if (!target) return { content: [{ type: "text", text: "No target found." }], isError: true };

      try {
        const result = await doWithTarget(target.targetId, async (ws) => {
          await wsSend(ws, "Runtime.enable");
          const escapedText = params.text.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
          const escapedSelector = params.cssSelector.replace(/'/g, "\\'");
          return wsSend(ws, "Runtime.evaluate", {
            expression: `(function() { const el = document.querySelector('${escapedSelector}'); if (!el) throw new Error('Element not found'); el.value = '${escapedText}'; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return 'typed'; })()`,
            returnByValue: true,
            awaitPromise: true,
          });
        });

        if (result.exceptionDetails) {
          return { content: [{ type: "text", text: `Type failed: ${result.exceptionDetails.exception?.description ?? "unknown"}` }], isError: true };
        }

        const display = params.text.slice(0, 50) + (params.text.length > 50 ? "..." : "");
        return { content: [{ type: "text", text: `Typed "${display}" into "${params.cssSelector}"` }] };
      } catch (err: any) {
        return { content: [{ type: "text", text: `Type error: ${err.message}` }], isError: true };
      }
    },
  });

  // ── cdp_disconnect ──

  pi.registerTool({
    name: "cdp_disconnect",
    label: "CDP Disconnect",
    description: "Disconnect from the CDP endpoint and clean up resources.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      if (!connection) {
        return { content: [{ type: "text", text: "Not connected." }] };
      }
      connection = null;
      return { content: [{ type: "text", text: "Disconnected from CDP endpoint." }] };
    },
  });
}
