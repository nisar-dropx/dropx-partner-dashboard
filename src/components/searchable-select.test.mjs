import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";

const compiled = ts.transpileModule(readFileSync(new URL("./searchable-select.tsx", import.meta.url), "utf8"), {
  compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText;
const jsx = (type, props, key) => ({ type, props, key });
const nodes = root => Array.isArray(root) ? root.flatMap(nodes) : root && typeof root === "object" ? [root, ...nodes(root.props?.children)] : [];

function selectHarness(props) {
  const slots = [];
  let cursor = 0;
  let tree;
  const hooks = {
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
      return [slots[index], value => { slots[index] = typeof value === "function" ? value(slots[index]) : value; }];
    },
    useMemo(fn) { cursor++; return fn(); },
    useRef(initial) {
      const index = cursor++;
      return slots[index] ?? (slots[index] = { current: initial });
    },
    useEffect() { cursor++; }
  };
  const mocks = {
    react: hooks,
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "lucide-react": { ChevronDown: "icon", X: "icon" }
  };
  const module = { exports: {} };
  new Function("require", "module", "exports", compiled)(name => mocks[name], module, module.exports);
  const render = () => { cursor = 0; tree = module.exports.SearchableSelect(props); };
  const all = predicate => nodes(tree).filter(predicate);
  const one = predicate => { const found = all(predicate); assert.equal(found.length, 1); return found[0]; };
  render();
  return { render, all, one };
}

const options = [
  { value: "a", label: "Asha Devi" },
  { value: "b", label: "Bina Das" }
];

test("allowClear false preserves a selected value while still permitting replacement", () => {
  const changes = [];
  const ui = selectHarness({ name: "worker", options, value: "a", placeholder: "Select", allowClear: false, onValueChange: value => changes.push(value) });
  assert.equal(ui.all(node => node.props?.["aria-label"] === "Clear selected option").length, 0);

  ui.one(node => node.props?.className === "searchable-input").props.onChange({ target: { value: "" } });
  ui.render();
  assert.equal(ui.one(node => node.props?.type === "hidden").props.value, "a");
  assert.deepEqual(changes, []);

  ui.one(node => node.props?.className === "searchable-input").props.onChange({ target: { value: "Bina" } });
  ui.render();
  ui.one(node => node.props?.className?.includes("searchable-option") && node.props.children?.[0]?.props?.children === "Bina Das").props.onClick();
  ui.render();
  assert.equal(ui.one(node => node.props?.type === "hidden").props.value, "b");
  assert.deepEqual(changes, ["b"]);
});

test("allowClear defaults to enabled", () => {
  const changes = [];
  const ui = selectHarness({ name: "worker", options, value: "a", placeholder: "Select", onValueChange: value => changes.push(value) });
  ui.one(node => node.props?.["aria-label"] === "Clear selected option").props.onClick();
  ui.render();
  assert.equal(ui.one(node => node.props?.type === "hidden").props.value, "");
  assert.deepEqual(changes, [""]);
});
