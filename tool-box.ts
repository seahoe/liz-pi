/**
 * Tool Box Border — EVA edition
 *
 * pi's built-in tool boxes are drawn as full-width filled rectangles
 * (`theme.bg("toolPendingBg" | "toolSuccessBg" | "toolErrorBg", ...)`).
 * There is no theme token for a tool-box border, so this extension patches
 * the *live* pi-tui `Box` class inside the running process and swaps the
 * filled rectangle for a bordered one:
 *
 *   - pending (running)  → Rei Ayanami hair blue
 *   - success            → unchanged theme `success` green
 *   - error              → Asuka Langley red
 *
 * How it reaches the live class: `ctx.ui.setWidget()` hands us the real TUI
 * instance and the real Theme. We walk the component tree to find a `Box`
 * instance and patch its prototype. The bundle inlines its own copy of
 * pi-tui, so importing `Box` from `@earendil-works/pi-tui` would patch the
 * wrong class — walking the live tree is the only reliable way.
 *
 * Detection: the box's `bgFn` is a closure whose source literally contains
 * the token name (`text=>theme.bg("toolPendingBg",text)`). That lets us tell
 * tool boxes apart from user/custom message boxes, which also use `Box`.
 *
 * Tweak the palette below to taste.
 */

import { visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";

// ── Palette ────────────────────────────────────────────────────────────────

/** Asuka Langley Soryu red (Evangelion Unit-02). */
const ASUKA_RED = "#e4232a";
/** Rei Ayanami hair blue. */
const REI_BLUE = "#a8c6df";
// success / green is left as the active theme's `success` color.

// ── ANSI color helpers (respect the active theme's color mode) ───────────────

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

function rgbTo256(r: number, g: number, b: number): number {
  const CUBE = [0, 95, 135, 175, 215, 255];
  const nearest = (v: number) => {
    let bi = 0;
    let bd = Infinity;
    for (let i = 0; i < CUBE.length; i++) {
      const d = Math.abs(v - CUBE[i]);
      if (d < bd) {
        bd = d;
        bi = i;
      }
    }
    return bi;
  };
  const ri = nearest(r);
  const gi = nearest(g);
  const bi = nearest(b);
  const cr = CUBE[ri];
  const cg = CUBE[gi];
  const cb = CUBE[bi];
  const cubeIdx = 16 + 36 * ri + 6 * gi + bi;
  const cubeDist =
    (r - cr) ** 2 * 0.299 + (g - cg) ** 2 * 0.587 + (b - cb) ** 2 * 0.114;

  const gray = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
  let gidx = 0;
  let gd = Infinity;
  for (let i = 0; i < 24; i++) {
    const level = 8 + i * 10;
    const d = Math.abs(gray - level);
    if (d < gd) {
      gd = d;
      gidx = i;
    }
  }
  const gv = 8 + gidx * 10;
  const grayIdx = 232 + gidx;
  const grayDist =
    (r - gv) ** 2 * 0.299 + (g - gv) ** 2 * 0.587 + (b - gv) ** 2 * 0.114;
  const spread = Math.max(r, g, b) - Math.min(r, g, b);
  if (spread < 10 && grayDist < cubeDist) return grayIdx;
  return cubeIdx;
}

function fgAnsi(hex: string, mode: string): string {
  const [r, g, b] = hexToRgb(hex);
  if (mode === "truecolor") return `\x1b[38;2;${r};${g};${b}m`;
  return `\x1b[38;5;${rgbTo256(r, g, b)}m`;
}

// ── Runtime handles ─────────────────────────────────────────────────────────

let liveTui: TUI | undefined;
let liveTheme: Theme | undefined;

type ToolState = "pending" | "success" | "error";

function safeSource(fn: unknown): string {
  if (typeof fn !== "function") return "";
  try {
    return Function.prototype.toString.call(fn);
  } catch {
    return "";
  }
}

function toolState(box: any): ToolState | null {
  const fn = box?.bgFn;
  if (typeof fn !== "function") return null;
  // Cache the closure source per function identity.
  if (box.__piBgSrcFn !== fn) {
    box.__piBgSrcFn = fn;
    box.__piBgSrc = safeSource(fn);
  }
  const src: string = box.__piBgSrc;
  if (src.includes("toolErrorBg")) return "error";
  if (src.includes("toolSuccessBg")) return "success";
  if (src.includes("toolPendingBg")) return "pending";
  return null;
}

function borderAnsi(state: ToolState): string {
  if (state === "error") return fgAnsi(ASUKA_RED, liveTheme?.getColorMode?.() ?? "truecolor");
  if (state === "pending") return fgAnsi(REI_BLUE, liveTheme?.getColorMode?.() ?? "truecolor");
  try {
    return liveTheme?.getFgAnsi("success") ?? "\x1b[38;5;149m";
  } catch {
    return "\x1b[38;5;149m";
  }
}

// ── Locate the live Box class ───────────────────────────────────────────────

function findBoxInstance(node: any, seen: Set<any>): any | undefined {
  if (!node || typeof node !== "object" || seen.has(node)) return undefined;
  seen.add(node);
  if (
    typeof node.setBgFn === "function" &&
    Array.isArray(node.children) &&
    typeof node.render === "function"
  ) {
    return node;
  }
  const kids = node.children;
  if (Array.isArray(kids)) {
    for (const kid of kids) {
      const found = findBoxInstance(kid, seen);
      if (found) return found;
    }
  }
  return undefined;
}

const GLYPH = {
  tl: "╭",
  tr: "╮",
  bl: "╰",
  br: "╯",
  h: "─",
  v: "│",
};

function installPatch(): boolean {
  if (!liveTui) return false;
  const instance = findBoxInstance(liveTui as any, new Set());
  if (!instance) return false;

  const proto = Object.getPrototypeOf(instance);
  if (!proto || typeof proto.render !== "function") return false;

  // Keep the original methods around once, even across /reload of extensions.
  if (!proto.__piToolBoxOrig) {
    proto.__piToolBoxOrig = {
      render: proto.render,
      handleMouse: proto.handleMouse,
    };
  }
  const orig = proto.__piToolBoxOrig;

  proto.render = function render(width: number): string[] {
    const state = toolState(this);
    if (!state || width < 8) return orig.render.call(this, width);

    const paddingX = typeof this.paddingX === "number" ? this.paddingX : 1;
    const paddingY = typeof this.paddingY === "number" ? this.paddingY : 1;
    const inner = width - 2;
    const contentWidth = Math.max(1, inner - paddingX * 2);
    const ansi = borderAnsi(state);
    const paint = (s: string) => `${ansi}${s}\x1b[39m`;

    const childLines: string[] = [];
    const layout: { component: any; height: number }[] = [];
    for (const child of this.children ?? []) {
      const lines = child.render(contentWidth);
      layout.push({ component: child, height: lines.length });
      for (const line of lines) childLines.push(line);
    }
    this.mouseLayout = { width: contentWidth, children: layout };

    const out: string[] = [];
    const rule = paint(GLYPH.h.repeat(inner));
    out.push(paint(GLYPH.tl) + rule + paint(GLYPH.tr));

    const emptyRow = paint(GLYPH.v) + " ".repeat(inner) + paint(GLYPH.v);
    for (let i = 0; i < paddingY; i++) out.push(emptyRow);

    const padLeft = " ".repeat(paddingX);
    for (const line of childLines) {
      const pad = Math.max(0, contentWidth - visibleWidth(line));
      out.push(
        paint(GLYPH.v) + padLeft + line + " ".repeat(pad) + padLeft + paint(GLYPH.v),
      );
    }

    for (let i = 0; i < paddingY; i++) out.push(emptyRow);
    out.push(paint(GLYPH.bl) + rule + paint(GLYPH.br));
    return out;
  };

  if (typeof orig.handleMouse === "function") {
    proto.handleMouse = function handleMouse(event: any) {
      if (!toolState(this)) return orig.handleMouse.call(this, event);
      // The patched render adds a 1-cell border on each side, so translate
      // mouse coordinates into the inner content box.
      return orig.handleMouse.call(this, {
        ...event,
        x: event.x - 1,
        y: event.y - 1,
        width: event.width - 2,
      });
    };
  }

  try {
    (liveTui as any).requestRender?.();
  } catch {
    /* ignore */
  }
  return true;
}

// ── Extension entry ─────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  let timer: ReturnType<typeof setInterval> | null = null;

  const tryInstall = () => {
    let done = false;
    try {
      done = installPatch();
    } catch {
      done = false;
    }
    if (done && timer) {
      clearInterval(timer);
      timer = null;
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    // Capture the live TUI + Theme from the widget factory. The widget itself
    // renders nothing; it only exists to hand us the runtime objects.
    ctx.ui.setWidget("tool-box-border", (tui, theme) => {
      liveTui = tui;
      liveTheme = theme;
      // The Box class may not exist yet at first paint; poll until it does.
      if (!timer) {
        timer = setInterval(tryInstall, 250);
        // Stop polling after ~2 minutes even on an empty transcript.
        setTimeout(() => {
          if (timer) {
            clearInterval(timer);
            timer = null;
          }
        }, 120_000);
      }
      tryInstall();
      return {
        render: () => [],
        invalidate: () => {},
        dispose: () => {},
      };
    });
  });

  pi.on("session_shutdown", async () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    liveTui = undefined;
    liveTheme = undefined;
  });
}
