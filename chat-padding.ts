/**
 * Chat Padding — center the conversation and the dock with a little breathing
 * room.
 *
 * In fullscreen mode pi paints the transcript scrollbar *over* the rightmost
 * column of the content, which hides the right border of full-width blocks
 * (e.g. the tool boxes drawn by `tool-box.ts`).
 *
 * The conversation is rendered inside a `ScrollView` whose document is the
 * `child` of the primary `ScrollView` under `tui.layoutRoot`; the dock (status
 * line, editor, footer) is its sibling. This extension wraps both renders so
 * their content is laid out `PADDING_X` columns narrower and centered. The
 * scrollbar then lands in the right-hand gutter instead of on top of the
 * content. Editor mouse clicks are translated back into the inset frame.
 *
 * Adjust `PADDING_X` below to taste (columns on each side).
 */

import { visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";

/** Columns of padding on each side of the conversation and dock. */
const PADDING_X = 2;

let liveTui: TUI | undefined;
let timer: ReturnType<typeof setInterval> | null = null;

function findPrimaryScrollView(root: any): any | undefined {
  const queue: any[] = [root];
  const seen = new Set<any>();
  while (queue.length > 0) {
    const node = queue.shift();
    if (!node || typeof node !== "object" || seen.has(node)) continue;
    seen.add(node);
    if (node.primary === true && typeof node.setScrollbar === "function" && node.child) {
      return node;
    }
    if (node.layoutRoot && typeof node.layoutRoot === "object") queue.push(node.layoutRoot);
    if (node.child && typeof node.child === "object") queue.push(node.child);
    if (Array.isArray(node.children)) queue.push(...node.children);
  }
  return undefined;
}

/** Wrap a component's render so its content is inset and centered. */
function insetRender(target: any, markKey: string): boolean {
  if (!target || typeof target.render !== "function" || target[markKey]) return false;
  const origRender = target.render;
  target.render = function render(width: number): string[] {
    const inner = Math.max(1, width - PADDING_X * 2);
    const lines = origRender.call(this, inner);
    const gutter = " ".repeat(PADDING_X);
    return lines.map((line: string) => {
      const fill = Math.max(0, inner - visibleWidth(line));
      return gutter + line + " ".repeat(fill) + gutter;
    });
  };
  target[markKey] = PADDING_X;
  return true;
}

/** Find the input editor inside the dock (anything with setPaddingX). */
function findEditor(node: any): any | undefined {
  const queue: any[] = [node];
  const seen = new Set<any>();
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    if (typeof current.setPaddingX === "function" && typeof current.render === "function") {
      return current;
    }
    if (Array.isArray(current.children)) queue.push(...current.children);
  }
  return undefined;
}

/** Translate editor clicks back into the inset frame. */
function patchEditorMouse(editor: any): boolean {
  if (!editor || typeof editor.handleMouse !== "function" || editor.__piChatPaddingMouse) return false;
  const origHandleMouse = editor.handleMouse;
  editor.handleMouse = function handleMouse(event: any) {
    return origHandleMouse.call(this, {
      ...event,
      x: Math.max(0, (event.x ?? 0) - PADDING_X),
      width: Math.max(1, (event.width ?? 0) - PADDING_X * 2),
    });
  };
  editor.__piChatPaddingMouse = true;
  return true;
}

/** Layout nodes opt a component out of the direct render path (the layout
 * engine walks their children instead), so only leaves can be wrapped. */
const LAYOUT_NODE = Symbol.for("@earendil-works/pi-tui/layout-node");

/** Wrap every leaf component in a subtree so its content is inset+centered. */
function insetLeaves(node: any, seen: Set<any>): void {
  if (!node || typeof node !== "object" || seen.has(node)) return;
  seen.add(node);
  const hasLayoutNode = typeof node[LAYOUT_NODE] === "function";
  if (!hasLayoutNode) {
    if (typeof node.render === "function") insetRender(node, "__piChatPaddingLeaf");
    return;
  }
  if (Array.isArray(node.children)) {
    for (const child of node.children) insetLeaves(child, seen);
  }
}

function ensurePatched(): boolean {
  if (!liveTui) return false;
  const root = (liveTui as any).layoutRoot ?? liveTui;
  const scrollView = findPrimaryScrollView(root);
  if (!scrollView) return false;

  if (scrollView.child) insetRender(scrollView.child, "__piChatPaddingDoc");

  let dock: any;
  if (Array.isArray(root.children)) {
    dock = root.children.find((child: any) => child !== scrollView && typeof child?.render === "function");
  }
  if (dock) {
    insetLeaves(dock, new Set());
    const editor = findEditor(dock);
    if (editor) patchEditorMouse(editor);
  }
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
      // replacement can build fresh components; keep a cheap poll running.
      if (!timer) timer = setInterval(ensurePatched, 1000);
      return { render: () => [], invalidate: () => {}, dispose: () => {} };
    });
  });

  pi.on("session_shutdown", async () => {
    stopPolling();
    liveTui = undefined;
  });
}
