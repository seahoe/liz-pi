/**
 * Chat Padding — center the conversation with a little breathing room.
 *
 * In fullscreen mode pi renders the conversation inside a `ScrollView` whose
 * scrollbar is painted *over* the rightmost column of the content. That hides
 * the right border of full-width blocks (e.g. the tool boxes drawn by
 * `tool-box.ts`).
 *
 * This extension finds the conversation's document component (the `child` of
 * the primary `ScrollView` under `tui.layoutRoot`) and wraps its `render` so
 * the content is laid out `PADDING_X` columns narrower and centered. The
 * scrollbar then lands in the right-hand gutter instead of on top of the
 * content.
 *
 * Adjust `PADDING_X` below to taste (columns on each side).
 */

import { visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";

/** Columns of padding on each side of the conversation. */
const PADDING_X = 2;

let liveTui: TUI | undefined;
let timer: ReturnType<typeof setInterval> | null = null;

function ctorName(o: any): string {
  return o?.constructor?.name || "";
}

/** Find the conversation document: the child of the primary ScrollView. */
function findChatDocument(root: any): any | undefined {
  if (!root || typeof root !== "object") return undefined;
  const queue: any[] = [root];
  const seen = new Set<any>();
  while (queue.length > 0) {
    const node = queue.shift();
    if (!node || typeof node !== "object" || seen.has(node)) continue;
    seen.add(node);
    if (
      node.primary === true &&
      typeof node.setScrollbar === "function" &&
      node.child &&
      typeof node.child.render === "function"
    ) {
      // The transcript document is a real component (Container); skip the
      // fullscreen TUI's implicit document, which is a plain object literal.
      if (ctorName(node.child) !== "Object") return node.child;
    }
    if (node.layoutRoot && typeof node.layoutRoot === "object") queue.push(node.layoutRoot);
    if (node.child && typeof node.child === "object") queue.push(node.child);
    if (Array.isArray(node.children)) queue.push(...node.children);
  }
  return undefined;
}

/** Idempotently wrap the document's render to inset + center its content. */
function patchDocument(doc: any): boolean {
  if (!doc || typeof doc.render !== "function" || doc.__piChatPadding) return false;

  const origRender = doc.render;
  const origHandleMouse = doc.handleMouse;

  doc.render = function render(width: number): string[] {
    const inner = Math.max(1, width - PADDING_X * 2);
    const lines = origRender.call(this, inner);
    const gutter = " ".repeat(PADDING_X);
    return lines.map((line: string) => {
      const fill = Math.max(0, inner - visibleWidth(line));
      return gutter + line + " ".repeat(fill) + gutter;
    });
  };

  if (typeof origHandleMouse === "function") {
    doc.handleMouse = function handleMouse(event: any) {
      if (event.x < PADDING_X) return undefined;
      return origHandleMouse.call(this, { ...event, x: event.x - PADDING_X });
    };
  }

  doc.__piChatPadding = PADDING_X;
  return true;
}

function ensurePatched(): boolean {
  if (!liveTui) return false;
  const doc = findChatDocument((liveTui as any).layoutRoot ?? liveTui);
  if (!doc) return false;
  patchDocument(doc);
  return true;
}

export default function (pi: ExtensionAPI) {
  const stopPolling = () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.setWidget("chat-padding", (tui) => {
      liveTui = tui;
      ensurePatched();
      // The layout tree may not exist yet on the first paint, and a session
      // replacement can build a fresh document; keep a cheap poll running.
      if (!timer) timer = setInterval(ensurePatched, 1000);
      return { render: () => [], invalidate: () => {}, dispose: () => {} };
    });
  });

  pi.on("session_shutdown", async () => {
    stopPolling();
    liveTui = undefined;
  });
}
