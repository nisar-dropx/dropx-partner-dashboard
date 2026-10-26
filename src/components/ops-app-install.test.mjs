import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const jsx = (type, props) => ({ type, props });
const nodes = (n) =>
  !n || typeof n !== "object"
    ? []
    : [n, ...[n.props?.children].flat(Infinity).flatMap(nodes)];

function mount({ userAgent = "Mozilla/5.0 (Windows NT 10.0)", maxTouchPoints = 0 } = {}) {
  const savedNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const saved = globalThis.window,
    values = [],
    events = new Map(),
    cleanups = [];
  let cursor = 0,
    started = false;
  globalThis.window = {
    matchMedia: () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }),
    addEventListener: (n, f) => events.set(n, f),
    removeEventListener: (n) => events.delete(n),
    location: { search: "" },
    navigator: { userAgent: "Mozilla/5.0 (Windows NT 10.0)" },
  };
  Object.defineProperty(globalThis, "navigator", {
    value: { userAgent, maxTouchPoints },
    configurable: true,
  });
  const hooks = {
    useState: (v) => {
      const i = cursor++;
      if (!(i in values)) values[i] = v;
      return [values[i], (x) => (values[i] = x)];
    },
    useEffect: (fn) => {
      if (!started) cleanups.push(fn());
    },
  };
  const mocks = {
    react: hooks,
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "lucide-react": {
      Download: "svg",
      Monitor: "svg",
      Smartphone: "svg",
      Check: "svg",
      ChevronDown: "svg",
    },
    "../../public/downloads/opspulse-android.json": JSON.parse(
      readFileSync(
        new URL("../../public/downloads/opspulse-android.json", import.meta.url),
        "utf8",
      ),
    ),
  };
  const m = { exports: {} };
  const code = ts.transpileModule(
    readFileSync(new URL("./ops-app-install.tsx", import.meta.url), "utf8"),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        jsx: ts.JsxEmit.ReactJSX,
        esModuleInterop: true,
      },
    },
  ).outputText;
  new Function("require", "exports", "module", code)(
    (id) => mocks[id],
    m.exports,
    m,
  );
  return {
    events,
    render() {
      cursor = 0;
      const tree = m.exports.OpsAppInstall({ compact: true });
      started = true;
      return tree;
    },
    cleanup() {
      cleanups.forEach((fn) => fn?.());
      globalThis.window = saved;
      if (savedNavigator) Object.defineProperty(globalThis, "navigator", savedNavigator);
      else delete globalThis.navigator;
    },
  };
}

const desktopInstallButton = (tree) => nodes(tree).find(
  (n) => n.type === "button" && n.props.className === "ops-install-primary",
);
const chooseDevice = (tree, label) => nodes(tree).find(
  (n) => n.type === "button" && n.props.children === label,
).props.onClick();

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("login install is collapsed while device instructions remain reachable", () => {
  const h = mount();
  try {
    const tree = h.render();
    assert.equal(tree.type, "details");
    assert(!tree.props.open);
    assert(nodes(tree).some((n) => n.type === "summary"));
    assert(nodes(tree).some((n) => n.props?.className === "ops-install-instructions"));
    assert(!nodes(tree).some((n) => n.type === "a" && n.props.download));
    chooseDevice(tree, "Android");
    const android = h.render();
    assert(nodes(android).some((n) => n.type === "a" && n.props.download?.endsWith(".apk")));
    assert(!desktopInstallButton(android), "do not offer this computer's installer for another device");
  } finally { h.cleanup(); }
});

test("Android and desktop-mode iPad pick their own instructions without expanding login", () => {
  for (const [userAgent, maxTouchPoints, selected] of [
    ["Mozilla/5.0 Android", 5, "Android"],
    ["Mozilla/5.0 Macintosh", 5, "iPhone / iPad"],
  ]) {
    const h = mount({ userAgent, maxTouchPoints });
    try {
      h.render();
      const tree = h.render();
      assert(!tree.props.open);
      assert(nodes(tree).some((n) => n.type === "button" && n.props.children === selected && n.props["aria-pressed"]));
      if (selected === "iPhone / iPad") assert(!desktopInstallButton(tree));
    } finally { h.cleanup(); }
  }
});

test("install without a browser prompt keeps platform instructions visible", () => {
  const h = mount();
  try {
    desktopInstallButton(h.render()).props.onClick();
    const tree = h.render();
    assert(
      nodes(tree).some((n) => n.props.className === "ops-install-instructions"),
    );
    assert(nodes(tree).some((n) => n.props.role === "status"));
  } finally {
    h.cleanup();
  }
});

test("native install acceptance, appinstalled state and listener cleanup", async () => {
  const h = mount();
  try {
    h.render();
    let prevented = false,
      prompts = 0;
    h.events.get("beforeinstallprompt")({
      preventDefault() {
        prevented = true;
      },
      async prompt() {
        prompts++;
      },
      userChoice: Promise.resolve({ outcome: "accepted" }),
    });
    desktopInstallButton(h.render()).props.onClick();
    await tick();
    assert(prevented);
    assert.equal(prompts, 1);
    assert(!desktopInstallButton(h.render()).props.disabled);
    h.events.get("appinstalled")();
    assert.equal(desktopInstallButton(h.render()).props.disabled, true);
  } finally {
    h.cleanup();
    assert.equal(h.events.size, 0);
  }
});

test("failed installation restores controls and exposes manual instructions", async () => {
  const h = mount();
  try {
    h.render();
    h.events.get("beforeinstallprompt")({
      preventDefault() {},
      async prompt() {
        throw Error("unsupported");
      },
      userChoice: Promise.resolve({ outcome: "dismissed" }),
    });
    desktopInstallButton(h.render()).props.onClick();
    await tick();
    const tree = h.render();
    assert(!desktopInstallButton(tree).props.disabled);
    assert(
      nodes(tree).some((n) => n.props.className === "ops-install-instructions"),
    );
    assert(nodes(tree).some((n) => n.props.role === "status"));

  } finally {
    h.cleanup();
  }
});

test("Android download is primary and uses the published release metadata", () => {
  const h = mount({ userAgent: "Mozilla/5.0 Android", maxTouchPoints: 5 });
  try {
    h.render();
    const tree = h.render();
    const release = JSON.parse(readFileSync(new URL("../../public/downloads/opspulse-android.json", import.meta.url), "utf8"));
    const link = nodes(tree).find(n => n.type === "a" && n.props.className === "ops-install-primary");
    assert.equal(link?.props.href, release.url);
    assert.equal(link?.props.download, `DropX-OpsPulse-${release.version}.apk`);
    assert(!desktopInstallButton(tree));
  } finally { h.cleanup(); }
});
