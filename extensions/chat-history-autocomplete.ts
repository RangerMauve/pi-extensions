// Tab-completion of words from the chat history.
// More recent words rank first. Index is incremental (new words only)
// and bucketed by first character for fast lookups.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
  AutocompleteProvider,
  AutocompleteItem,
  AutocompleteSuggestions,
} from "@earendil-works/pi-tui";

const MIN_WORD_LEN = 2;
const MAX_SUGGESTIONS = 20;

// Two-level map: first char (lowercase) → word (case-sensitive) → most recent position
type WordIndex = Map<string, Map<string, number>>;

function messageText(
  msg: { content?: string | Array<{ type: string; text?: string }> },
): string {
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content.filter((p) => p.type === "text").map((p) => p.text ?? "").join(" ");
  }
  return "";
}

// Add words from a single message into the index (incremental, no branch walk)
function indexMessage(index: WordIndex, text: string, position: number) {
  for (const word of text.split(/[^a-zA-Z0-9_]+/)) {
    const trimmed = word.trim();
    if (trimmed.length >= MIN_WORD_LEN) {
      const key = trimmed[0].toLowerCase();
      let layer = index.get(key);
      if (!layer) {
        layer = new Map();
        index.set(key, layer);
      }
      layer.set(trimmed, position); // overwrite → keeps most recent
    }
  }
}

// Find candidates for a prefix from the index
function findCandidates(
  index: WordIndex,
  partialLower: string,
): { word: string; position: number }[] {
  if (!partialLower) return [];

  const key = partialLower[0];
  const layer = index.get(key);
  if (!layer) return [];

  const candidates: { word: string; position: number }[] = [];
  for (const [word, position] of layer) {
    if (word.toLowerCase().startsWith(partialLower)) {
      candidates.push({ word, position });
    }
  }
  return candidates;
}

// ── Extension entry point ───────────────────────────────────

export default function (pi: ExtensionAPI) {
  const wordIndex: WordIndex = new Map();
  let position = 0; // Monotonically increasing counter for recency

  pi.on("session_start", (_event, ctx) => {
    // Seed index from existing session history (one-time at startup)
    const branch = ctx.sessionManager.getBranch();
    for (const entry of branch) {
      if (entry.type === "message") {
        const text = messageText(entry.message);
        if (text) indexMessage(wordIndex, text, position++);
      }
    }

    ctx.ui.addAutocompleteProvider((current) => ({
      async getSuggestions(
        lines,
        cursorLine,
        cursorCol,
        _options,
      ): Promise<AutocompleteSuggestions | null> {
        const beforeCursor = (lines[cursorLine] ?? "").slice(0, cursorCol);
        const match = beforeCursor.match(/\S+$/);
        if (!match) return null;

        const partial = match[0];
        const candidates = findCandidates(wordIndex, partial.toLowerCase());

        if (candidates.length === 0) {
          return current?.getSuggestions(lines, cursorLine, cursorCol, _options) ?? null;
        }

        // Sort: most recent first, alphabetical as tiebreaker
        candidates.sort((a, b) => {
          const diff = b.position - a.position;
          return diff !== 0 ? diff : a.word.localeCompare(b.word);
        });

        return {
          prefix: partial,
          items: candidates.slice(0, MAX_SUGGESTIONS).map(({ word }) => ({
            value: word,
            label: word,
          })),
        };
      },

      applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
        return current?.applyCompletion(
          lines,
          cursorLine,
          cursorCol,
          item,
          prefix,
        ) ?? { lines, line: cursorLine, col: cursorCol };
      },
      shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
        return current?.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
      },
    }));
  });

  // Add words from each new message (incremental — no branch walk)
  pi.on("message_end", (event) => {
    const text = messageText(event.message);
    if (text) indexMessage(wordIndex, text, position++);
  });
}
