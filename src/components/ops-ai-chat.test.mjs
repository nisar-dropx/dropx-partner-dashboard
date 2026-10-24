import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import * as language from "../lib/ops-pulse/assistant-language.ts";
import * as position from "../lib/ops-pulse/assistant-position.ts";

test("launcher and panel remain visible at desktop, phone, zoom and keyboard viewport sizes", () => {
  for (const viewport of [
    { width: 1440, height: 900, left: 0, top: 0 },
    { width: 390, height: 844, left: 0, top: 0 },
    { width: 320, height: 480, left: 0, top: 0 },
    { width: 320, height: 180, left: 20, top: 260 }
  ]) {
    for (const collapsed of [true, false]) for (const side of ["left", "right"]) for (const y of [0, .5, 1]) {
      const preference = { side, y, collapsed };
      const point = position.assistantPoint(preference, viewport);
      const bounds = position.assistantBounds(viewport, collapsed);
      assert(point.x >= viewport.left && point.x + bounds.width <= viewport.left + viewport.width);
      assert(point.y >= viewport.top && point.y + bounds.height <= viewport.top + viewport.height);
      if (viewport.height >= 220) assert(point.y + bounds.height <= viewport.top + viewport.height - 88, "bottom actions stay clear");
      const panel = position.assistantPanel(preference, viewport);
      assert(panel.left >= viewport.left && panel.left + panel.width <= viewport.left + viewport.width);
      assert(panel.top >= viewport.top && panel.top + panel.height <= viewport.top + viewport.height);
    }
  }
});

test("persisted preferences reject malformed values and constrain out-of-range positions", () => {
  for (const raw of [null, "bad JSON", "null", "[]", '{"side":"bottom","y":0,"collapsed":false}', '{"side":"left","y":"0.3","collapsed":true}']) {
    assert.deepEqual(position.readAssistantPreference(raw), position.DEFAULT_ASSISTANT_POSITION);
  }
  assert.deepEqual(position.readAssistantPreference('{"side":"left","y":500,"collapsed":true}'), { side: "left", y: 1, collapsed: true });
});

const compiled = ts.transpileModule(readFileSync(new URL("./ops-ai-chat.tsx", import.meta.url), "utf8"), {
  compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText;
const jsx = (type, props, key) => ({ type, props, key });
const nodes = root => Array.isArray(root) ? root.flatMap(nodes) : root && typeof root === "object" ? [root, ...nodes(root.props?.children)] : [];

function harness({ stored = new Map(), blocked = false } = {}) {
  const previousWindow = globalThis.window;
  const events = new Map(), slots = [], effects = [];
  let cursor = 0, tree;
  const browser = {
    innerWidth: 1280, innerHeight: 720,
    location: { pathname: "/provider-id-mapping" },
    localStorage: {
      getItem: key => { if (blocked) throw Error("blocked"); return stored.get(key) ?? null; },
      setItem: (key, value) => { if (blocked) throw Error("blocked"); stored.set(key, value); }
    },
    addEventListener: (name, fn) => events.set(name, fn),
    removeEventListener: name => events.delete(name)
  };
  globalThis.window = browser;
  const hooks = {
    useState(initial) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = typeof initial === "function" ? initial() : initial;
      return [slots[i], value => { slots[i] = typeof value === "function" ? value(slots[i]) : value; }];
    },
    useRef(initial) { const i = cursor++; return slots[i] ?? (slots[i] = { current: initial }); },
    useEffect(fn, deps) {
      const i = cursor++;
      if (!slots[i] || deps.some((dep, index) => !Object.is(dep, slots[i][index]))) { slots[i] = deps; effects.push(fn); }
    }
  };
  const mocks = { "@/lib/ops-pulse/assistant-language": language, react: hooks, "react/jsx-runtime": { jsx, jsxs: jsx }, "lucide-react": { ChevronLeft: "icon", ChevronRight: "icon", GripVertical: "icon", X: "icon" }, "@/lib/ops-pulse/assistant-position": position };
  const module = { exports: {} };
  new Function("require", "module", "exports", compiled)(name => { if (!(name in mocks)) throw Error(name); return mocks[name]; }, module, module.exports);
  const render = () => { cursor = 0; tree = module.exports.OpsAiChat(); };
  const flush = () => { render(); while (effects.length) effects.shift()(); render(); };
  flush();
  return {
    browser, events, stored, render: flush,
    all: predicate => nodes(tree).filter(predicate),
    one: predicate => { const found = nodes(tree).filter(predicate); assert.equal(found.length, 1); return found[0]; },
    launcher: () => nodes(tree).find(n => n.props?.className === "ops-ai-launcher").props,
    dock: () => nodes(tree).find(n => n.props?.className?.startsWith("ops-ai-dock")).props,
    restore: () => { globalThis.window = previousWindow; }
  };
}
const pointer = (x, y, overrides = {}) => ({ pointerId: 1, button: 0, isPrimary: true, clientX: x, clientY: y, currentTarget: { setPointerCapture() {} }, ...overrides });

test("mouse and touch dragging dock to an edge, persist across pages, and never open chat on release", () => {
  for (const pointerType of ["mouse", "touch"]) {
    const stored = new Map();
    const ui = harness({ stored });
    try {
      ui.launcher().onPointerDown(pointer(1100, 300, { pointerType }));
      ui.launcher().onPointerMove(pointer(20, 200, { pointerType })); ui.render();
      assert.match(ui.dock().className, /is-dragging/);
      ui.launcher().onPointerUp(pointer(20, 200, { pointerType })); ui.render();
      ui.launcher().onClick({ detail: 1 }); ui.render();
      assert.equal(ui.all(n => n.props?.role === "dialog").length, 0);
      assert.equal(ui.dock().style.left, 12);
      assert.equal(JSON.parse(stored.get(position.ASSISTANT_POSITION_KEY)).side, "left");
      const savedPosition = ui.dock().style;
      const nextPage = harness({ stored });
      try { assert.deepEqual(nextPage.dock().style, savedPosition); } finally { nextPage.restore(); }
      // A new ordinary click still opens, including a keyboard activation.
      ui.launcher().onClick({ detail: 0 }); ui.render();
      assert.equal(ui.all(n => n.props?.role === "dialog").length, 1);
      assert.equal(ui.dock().hidden, true);
      ui.one(n => n.props?.["aria-label"] === "Close Ask OpsPulse").props.onClick(); ui.render();
      assert.equal(ui.dock().hidden, false);
    } finally { ui.restore(); }
  }
});

test("tap jitter opens normally; cancelled drags restore position without persisting", () => {
  const ui = harness();
  try {
    const initial = ui.dock().style;
    ui.launcher().onPointerDown(pointer(1100, 300));
    ui.launcher().onPointerMove(pointer(1102, 301)); ui.render();
    ui.launcher().onPointerUp(pointer(1102, 301));
    ui.launcher().onClick({ detail: 1 }); ui.render();
    assert.equal(ui.all(n => n.props?.role === "dialog").length, 1);
    ui.one(n => n.props?.["aria-label"] === "Close Ask OpsPulse").props.onClick(); ui.render();
    ui.launcher().onPointerDown(pointer(1100, 300));
    ui.launcher().onPointerMove(pointer(30, 200)); ui.render();
    ui.launcher().onPointerCancel(); ui.render();
    assert.deepEqual(ui.dock().style, initial);
    assert.equal(ui.stored.size, 0);
  } finally { ui.restore(); }
});

test("keyboard movement, minimization, resize and storage-blocked browsers remain usable", () => {
  const ui = harness({ blocked: true });
  try {
    ui.launcher().onKeyDown({ key: "ArrowLeft", preventDefault() {} }); ui.render();
    assert.equal(ui.dock().style.left, 12);
    const before = ui.dock().style.top;
    ui.launcher().onKeyDown({ key: "ArrowUp", preventDefault() {} }); ui.render();
    assert.equal(ui.dock().style.top, before - 32);
    ui.one(n => n.props?.["aria-label"] === "Minimize assistant").props.onClick(); ui.render();
    assert.match(ui.dock().className, /is-collapsed/);
    ui.browser.innerWidth = 320; ui.browser.innerHeight = 480; ui.events.get("resize")(); ui.render();
    assert(ui.dock().style.left + 76 <= 320);
    assert(ui.dock().style.top + 44 <= 480 - 88);
    ui.launcher().onKeyDown({ key: "Home", preventDefault() {} }); ui.render();
    assert.equal(ui.dock().style.left, 320 - 76 - 12);
    ui.one(n => n.props?.["aria-label"] === "Show assistant label").props.onClick(); ui.render();
    assert.equal(ui.dock().style.left, 320 - 184 - 12);
  } finally { ui.restore(); }
});
