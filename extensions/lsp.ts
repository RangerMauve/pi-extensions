/**
 * LSP Extension for Pi
 *
 * Provides LSP-powered tools for TypeScript/JavaScript and Rust:
 * - lsp_rename_symbol: Rename a symbol across the entire codebase
 * - lsp_find_references: Find all references to a symbol
 * - lsp_find_definition: Jump to the definition of a symbol
 */

import { spawn, type ChildProcess } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-jsonrpc/node";
import type {
  InitializeParams,
  InitializeResult,
} from "vscode-languageserver-protocol";
import type {
  Position,
  Location,
  WorkspaceEdit,
} from "vscode-languageserver-types";

// ── Types ──────────────────────────────────────────────────────────────

interface LspServer {
  process: ChildProcess;
  connection: ReturnType<typeof createMessageConnection>;
  capabilities: InitializeResult["capabilities"];
}

interface DocumentEntry {
  version: number;
  text: string;
}

// ── Configuration ──────────────────────────────────────────────────────

interface ServerConfig {
  command: string;
  args: string[];
  extensions: string[];
}

const SERVERS: Record<string, ServerConfig> = {
  typescript: {
    command: "typescript-language-server",
    args: ["--stdio"],
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
  },
  rust: {
    command: "rust-analyzer",
    args: [],
    extensions: [".rs"],
  },
};

function serverForFile(filePath: string): string | undefined {
  const ext = filePath.split(".").pop()?.toLowerCase();
  if (!ext) return undefined;
  const dotExt = `.${ext}`;
  for (const [key, config] of Object.entries(SERVERS)) {
    if (config.extensions.includes(dotExt)) return key;
  }
  return undefined;
}

// ── State ──────────────────────────────────────────────────────────────

const servers = new Map<string, LspServer>();
const documents = new Map<string, DocumentEntry>();

// ── Helpers ────────────────────────────────────────────────────────────

function fileToUri(filePath: string): string {
  const abs = resolve(filePath);
  return `file://${process.platform === "win32" ? abs.replace(/\\/g, "/") : abs}`;
}

function uriToFile(uri: string): string {
  return uri.replace(/^file:\/\//, "");
}

function findSymbolCharacter(text: string, symbolName: string): number {
  const regex = new RegExp(`\\b${symbolName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
  const match = text.match(regex);
  if (!match) {
    throw new Error(
      `Symbol "${symbolName}" not found on line (text: ${JSON.stringify(text.slice(0, 80))})`,
    );
  }
  return match.index!;
}

function readLine(doc: DocumentEntry, line: number): string {
  return doc.text.split("\n")[line] ?? "";
}

async function readLinesAround(filePath: string, line: number, before = 2, after = 1): string[] {
  const content = await readFile(filePath, "utf-8");
  const lines = content.split("\n");
  const start = Math.max(0, line - before);
  const end = Math.min(lines.length - 1, line + after);
  const result: string[] = [];
  for (let i = start; i <= end; i++) {
    result.push(lines[i] ?? "");
  }
  return result;
}

function formatReference(
  filePath: string,
  line: number,
  linesAround: string[],
  startLine: number,
  contextBefore: number,
): string {
  const actualLine = startLine + contextBefore;
  const markerLine = `> ${actualLine} | ${linesAround[contextBefore]}`;
  const parts: string[] = [];
  for (let i = 0; i < linesAround.length; i++) {
    const num = startLine + i;
    parts.push(i === contextBefore ? markerLine : `  ${num} | ${linesAround[i]}`);
  }
  return [`${filePath}:${line}`, ...parts].join("\n");
}

// ── Server Lifecycle ───────────────────────────────────────────────────

async function ensureServer(serverKey: string, cwd: string): Promise<LspServer> {
  let server = servers.get(serverKey);

  if (server) {
    try {
      server.process.kill(0);
      return server;
    } catch {
      servers.delete(serverKey);
    }
  }

  const config = SERVERS[serverKey];
  if (!config) {
    throw new Error(`No LSP server configured for: ${serverKey}`);
  }

  const child = spawn(config.command, config.args, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const reader = new StreamMessageReader(child.stdout!);
  const writer = new StreamMessageWriter(child.stdin!);
  const connection = createMessageConnection(reader, writer);
  connection.listen();

  child.stderr!.on("data", (data) => {
    console.error(`[lsp] ${serverKey}:`, data.toString().trim());
  });
  child.on("error", (err) => {
    console.error(`[lsp] ${serverKey} server error:`, err.message);
    servers.delete(serverKey);
  });
  child.on("close", (code) => {
    if (code !== 0 && code !== null) {
      console.error(`[lsp] ${serverKey} exited with code ${code}`);
    }
    servers.delete(serverKey);
  });

  const initResult = (await connection.sendRequest("initialize", {
    processId: process.pid,
    rootUri: fileToUri(cwd),
    capabilities: {
      textDocument: {
        definition: { dynamicRegistration: false },
        references: { dynamicRegistration: false },
        rename: { dynamicRegistration: false },
        synchronization: { didSave: true, willSave: false, didChange: true },
      },
      workspace: { workspaceEdit: { documentChanges: true } },
    },
    initializationOptions: {},
    trace: "off",
  } as InitializeParams)) as InitializeResult;

  await connection.sendNotification("initialized", {});

  server = { process: child, connection, capabilities: initResult.capabilities };
  servers.set(serverKey, server);
  return server;
}

async function shutdownServers() {
  const promises: Promise<void>[] = [];
  for (const [key, server] of servers) {
    promises.push(
      (async () => {
        try {
          // Gracefully end the JSON-RPC connection (handles shutdown + exit).
          // This is safe even if streams are already destroyed.
          server.connection.end();
        } catch { /* ignore */ }
        try {
          // Force-kill the process if it is still alive.
          server.process.kill();
        } catch { /* ignore */ }
      })(),
    );
  }
  await Promise.all(promises);
  servers.clear();
}

// ── Document Sync ──────────────────────────────────────────────────────

async function syncDocument(
  server: LspServer,
  filePath: string,
): Promise<DocumentEntry> {
  const uri = fileToUri(filePath);
  const fileContent = await readFile(filePath, "utf-8");
  let doc = documents.get(uri);

  if (!doc || doc.text !== fileContent) {
    doc = { version: (doc?.version ?? 0) + 1, text: fileContent };
    documents.set(uri, doc);

    if (doc.version === 1) {
      await server.connection.sendNotification("textDocument/didOpen", {
        textDocument: { uri, languageId: "typescript", version: doc.version, text: doc.text },
      });
    } else {
      await server.connection.sendNotification("textDocument/didChange", {
        textDocument: { uri, version: doc.version },
        contentChanges: [{ text: doc.text }],
      });
    }
  }

  return doc;
}

// ── Apply WorkspaceEdit ────────────────────────────────────────────────

function lineCharToOffset(text: string, pos: Position): number {
  const lines = text.split("\n");
  let offset = 0;
  for (let i = 0; i < pos.line && i < lines.length; i++) {
    offset += lines[i].length + 1;
  }
  offset += Math.min(pos.character, lines[pos.line]?.length ?? 0);
  return offset;
}

async function applyWorkspaceEdit(edit: WorkspaceEdit, server: LspServer): Promise<string[]> {
  const changedFiles: string[] = [];

  if (edit.changes) {
    for (const [uri, textEdits] of Object.entries(edit.changes)) {
      const filePath = uriToFile(uri);
      let content = await readFile(filePath, "utf-8");
      const sorted = [...textEdits].sort((a, b) => {
        if (b.range.start.line !== a.range.start.line) return b.range.start.line - a.range.start.line;
        return b.range.start.character - a.range.start.character;
      });
      for (const te of sorted) {
        const start = lineCharToOffset(content, te.range.start);
        const end = lineCharToOffset(content, te.range.end);
        content = content.slice(0, start) + te.newText + content.slice(end);
      }
      await writeFile(filePath, content);
      changedFiles.push(filePath);

      // Update buffer
      const doc = documents.get(uri);
      if (doc) {
        doc.text = content;
        doc.version++;
        // Notify LSP server of the change so its document state stays in sync
        await server.connection.sendNotification("textDocument/didChange", {
          textDocument: { uri, version: doc.version },
          contentChanges: [{ text: content }],
        });
      }
    }
  }

  return changedFiles;
}

// ── Shared: resolve position from line + symbolName ───────────────────

async function resolvePosition(
  serverKey: string,
  filePath: string,
  line: number,
  symbolName: string,
  cwd: string,
): Promise<{ server: LspServer; uri: string; position: Position }> {
  const server = await ensureServer(serverKey, cwd);
  const doc = await syncDocument(server, filePath);
  const uri = fileToUri(filePath);

  const lineText = readLine(doc, line);
  if (!lineText.trim()) {
    throw new Error(`Line ${line} is empty`);
  }

  const character = findSymbolCharacter(lineText, symbolName);
  return { server, uri, position: { line, character } };
}

// ── Extension Entry Point ──────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  pi.on("session_shutdown", async () => { await shutdownServers(); });

  // ── lsp_rename_symbol ──

  pi.registerTool({
    name: "lsp_rename_symbol",
    label: "LSP Rename Symbol",
    description:
      "Rename a symbol across the entire codebase using the language server. " +
      "Works with TypeScript, JavaScript, and Rust files.",
    parameters: Type.Object({
      file: Type.String({ description: "Path to the file containing the symbol" }),
      line: Type.Integer({ description: "0-indexed line number where the symbol appears" }),
      newName: Type.String({ description: "The new name for the symbol" }),
      symbolName: Type.String({
        description: "The current name of the symbol to rename (must match exactly)",
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const serverKey = serverForFile(params.file);
        if (!serverKey) return { content: [{ type: "text", text: `Unsupported file type: ${params.file}` }] };

        const { server, uri, position } = await resolvePosition(
          serverKey, params.file, params.line, params.symbolName, ctx.cwd,
        );

        if (!server.capabilities.renameProvider) {
          return { content: [{ type: "text", text: "Server does not support rename" }] };
        }

        const edit = (await server.connection.sendRequest("textDocument/rename", {
          textDocument: { uri },
          position,
          newName: params.newName,
        })) as WorkspaceEdit | null;

        if (!edit) {
          return { content: [{ type: "text", text: `No rename available for "${params.symbolName}" at line ${params.line}` }] };
        }

        const changed = await applyWorkspaceEdit(edit, server);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              message: `Renamed "${params.symbolName}" → "${params.newName}"`,
              changedFiles: changed,
            }),
          }],
        };
      } catch (err: any) {
        return { content: [{ type: "text", text: `LSP error: ${err.message}` }], isError: true };
      }
    },
  });

  // ── lsp_find_references ──

  pi.registerTool({
    name: "lsp_find_references",
    label: "LSP Find References",
    description:
      "Find all references to a symbol across the codebase using the language server. " +
      "Works with TypeScript, JavaScript, and Rust files.",
    parameters: Type.Object({
      file: Type.String({ description: "Path to the file containing the symbol" }),
      line: Type.Integer({ description: "0-indexed line number where the symbol appears" }),
      symbolName: Type.String({
        description: "The name of the symbol to find references for (must match exactly)",
      }),
      includeDeclaration: Type.Optional(Type.Boolean({
        description: "Whether to include the symbol's declaration (default: true)",
      })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const serverKey = serverForFile(params.file);
        if (!serverKey) return { content: [{ type: "text", text: `Unsupported file type: ${params.file}` }] };

        const { server, uri, position } = await resolvePosition(
          serverKey, params.file, params.line, params.symbolName, ctx.cwd,
        );

        if (!server.capabilities.referencesProvider) {
          return { content: [{ type: "text", text: "Server does not support references" }] };
        }

        const locations = (await server.connection.sendRequest("textDocument/references", {
          textDocument: { uri },
          position,
          context: { includeDeclaration: params.includeDeclaration ?? true },
        })) as Location[] | null;

        if (!locations || locations.length === 0) {
          return { content: [{ type: "text", text: `No references found for "${params.symbolName}"` }] };
        }

        const contextBefore = 2;
        const contextAfter = 1;
        const snippets: string[] = [];

        for (const l of locations) {
          const filePath = uriToFile(l.uri);
          const line = l.range.start.line;
          const linesAround = await readLinesAround(filePath, line, contextBefore, contextAfter);
          const snippet = formatReference(filePath, line, linesAround, Math.max(0, line - contextBefore), contextBefore);
          snippets.push(snippet);
        }

        return {
          content: [{
            type: "text",
            text: `Found ${locations.length} reference${locations.length === 1 ? "" : "s"} for "${params.symbolName}":\n\n${snippets.join("\n")}`,
          }],
        };
      } catch (err: any) {
        return { content: [{ type: "text", text: `LSP error: ${err.message}` }], isError: true };
      }
    },
  });

  // ── lsp_find_definition ──

  pi.registerTool({
    name: "lsp_find_definition",
    label: "LSP Find Definition",
    description:
      "Find the definition of a symbol using the language server. " +
      "Works with TypeScript, JavaScript, and Rust files.",
    parameters: Type.Object({
      file: Type.String({ description: "Path to the file containing the symbol" }),
      line: Type.Integer({ description: "0-indexed line number where the symbol appears" }),
      symbolName: Type.String({
        description: "The name of the symbol to find (must match exactly on the given line)",
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const serverKey = serverForFile(params.file);
        if (!serverKey) return { content: [{ type: "text", text: `Unsupported file type: ${params.file}` }] };

        const { server, uri, position } = await resolvePosition(
          serverKey, params.file, params.line, params.symbolName, ctx.cwd,
        );

        if (!server.capabilities.definitionProvider) {
          return { content: [{ type: "text", text: "Server does not support definitions" }] };
        }

        const result = (await server.connection.sendRequest("textDocument/definition", {
          textDocument: { uri },
          position,
        })) as Location | Location[] | null;

        if (!result) {
          return { content: [{ type: "text", text: `No definition found for "${params.symbolName}"` }] };
        }

        const locations = Array.isArray(result) ? result : [result];

        const contextBefore = 2;
        const contextAfter = 1;
        const snippets: string[] = [];

        for (const l of locations) {
          const filePath = uriToFile(l.uri);
          const line = l.range.start.line;
          const linesAround = await readLinesAround(filePath, line, contextBefore, contextAfter);
          const snippet = formatReference(filePath, line, linesAround, Math.max(0, line - contextBefore), contextBefore);
          snippets.push(snippet);
        }

        return {
          content: [{
            type: "text",
            text: `Definition of "${params.symbolName}":\n\n${snippets.join("\n")}`,
          }],
        };
      } catch (err: any) {
        return { content: [{ type: "text", text: `LSP error: ${err.message}` }], isError: true };
      }
    },
  });
}
