// Self-check for the modding-tab patch (global-pause UI wiring) and the
// loader's pause semantics. Run: node patches/modding-tab/test.js
import assert from "node:assert";
import fs from "node:fs";
import vm from "node:vm";

// ----------------------------------------------------------------------
// Minimal fake DOM used by both parts.
// ----------------------------------------------------------------------
function fakeElement(tag) {
    const node = {
        tagName: String(tag).toUpperCase(),
        children: [],
        attributes: {},
        _listeners: {},
        _text: "",
        style: {},
        className: "",
        innerHTML: "",
        id: "",
        type: "",
        checked: false,
        disabled: false,
        setAttribute(k, v) {
            this.attributes[k] = String(v);
        },
        getAttribute(k) {
            return k in this.attributes ? this.attributes[k] : null;
        },
        appendChild(child) {
            this.children.push(child);
            return child;
        },
        addEventListener(type, fn) {
            (this._listeners[type] ??= []).push(fn);
        },
        dispatch(type, event = {}) {
            for (const fn of this._listeners[type] || []) fn({ target: this, ...event });
        },
    };
    Object.defineProperty(node, "textContent", {
        get() {
            return this._text + this.children.map((c) => c.textContent).join("");
        },
        set(v) {
            this._text = String(v ?? "");
        },
    });
    return node;
}

function findAll(root, pred, out = []) {
    if (pred(root)) out.push(root);
    for (const c of root.children || []) findAll(c, pred, out);
    return out;
}

// ----------------------------------------------------------------------
// Part a: UI wiring of the "Pause all mods" toggle.
// ----------------------------------------------------------------------
{
    const patchSrc = fs.readFileSync(new URL("./index.js", import.meta.url), "utf8");

    let paused = false;
    const calls = { setPaused: [], reload: 0, setPatchEnabled: [] };
    let renderPanel = null;

    let registered = null;
    const modsStub = {
        registerPatch(id, def) {
            registered = { id, def };
        },
        getModInfo: () => ({ name: "Element Mods", version: "0.1.0" }),
        getPatches: () => [
            { id: "modding-tab", name: "Modding Tab", version: "1.0.0", required: true },
            { id: "foo", name: "Foo patch", version: "1.2.3" },
            { id: "bar", name: "Bar patch", version: "0.0.1" },
        ],
        isPaused: () => paused,
        setPaused: (v) => calls.setPaused.push(v),
        isPatchEnabled: (id) => id === "foo",
        setPatchEnabled: (id, v) => calls.setPatchEnabled.push([id, v]),
        settingsTabs: {
            register(_id, def) {
                renderPanel = def.renderPanel;
            },
            unregister() {},
        },
        reload: () => calls.reload++,
    };

    const sandbox = {
        window: { mods: modsStub },
        document: {
            createElement: (tag) => fakeElement(tag),
            querySelector: () => null,
        },
        console,
    };
    sandbox.window.window = sandbox.window;
    vm.createContext(sandbox);
    vm.runInContext(patchSrc, sandbox, { filename: "patches/modding-tab/index.js" });

    // Sanity: the existing manifest still declares this patch required.
    const manifest = JSON.parse(fs.readFileSync(new URL("./manifest.json", import.meta.url), "utf8"));
    assert.strictEqual(manifest.required, true, "modding-tab must stay required so it survives pause");

    assert.ok(registered, "patch should register");
    assert.strictEqual(registered.id, "modding-tab");
    registered.def.start();
    assert.ok(renderPanel, "patch should register a renderPanel via settingsTabs.register");

    // --- Unpaused state: pause toggle present and reflects isPaused()=false. ---
    paused = false;
    let panel = renderPanel();
    assert.ok(
        findAll(panel, (n) => n.textContent === "Pause all mods").length > 0,
        "panel should show a 'Pause all mods' label",
    );

    // First checkbox in document order is the master pause toggle (near the top).
    const checkboxes = () => findAll(panel, (n) => n.tagName === "INPUT" && n.type === "checkbox");
    let pauseToggle = checkboxes()[0];
    assert.ok(pauseToggle, "pause toggle checkbox exists");
    assert.strictEqual(pauseToggle.checked, false, "pause toggle unchecked while unpaused");

    // Toggling it on calls setPaused(true).
    pauseToggle.checked = true;
    pauseToggle.dispatch("change");
    assert.deepStrictEqual(calls.setPaused, [true], "change on pause toggle calls setPaused(true)");

    // While unpaused the normal UI is intact: per-patch switches enabled,
    // "Apply & Restart" button present.
    const fooSwitch = checkboxes().find((n) => n !== pauseToggle);
    assert.ok(fooSwitch, "per-patch switch exists");
    assert.notStrictEqual(fooSwitch.disabled, true, "per-patch switch enabled while unpaused");
    assert.ok(
        findAll(panel, (n) => n.textContent === "Apply & Restart").length > 0,
        "'Apply & Restart' button present while unpaused",
    );

    // --- Paused state: switches disabled + dimmed, restart button unpauses. ---
    paused = true;
    panel = renderPanel();
    pauseToggle = checkboxes()[0];
    assert.strictEqual(pauseToggle.checked, true, "pause toggle checked while paused");

    const dim = findAll(panel, (n) => n.style && n.style.opacity !== undefined && parseFloat(n.style.opacity) < 1);
    assert.ok(dim.length > 0, "some paused row is visually dimmed (reduced opacity)");
    for (const sw of checkboxes()) {
        if (sw === pauseToggle) continue;
        assert.strictEqual(sw.disabled, true, "per-patch switch disabled while paused");
    }

    const restartBtn = findAll(panel, (n) => n.tagName === "BUTTON" && n.textContent === "Restart with mods")[0];
    assert.ok(restartBtn, "'Restart with mods' button replaces 'Apply & Restart' while paused");
    calls.setPaused.length = 0;
    calls.reload = 0;
    restartBtn.dispatch("click");
    assert.deepStrictEqual(calls.setPaused, [false], "restart button calls setPaused(false) first");
    assert.strictEqual(calls.reload, 1, "restart button then calls reload()");

    console.log("modding-tab part a (UI wiring) OK");
}

// ----------------------------------------------------------------------
// Part b: loader pause semantics.
// ----------------------------------------------------------------------
{
    const loaderSrc = fs.readFileSync(new URL("../../src/runtime/loader.js", import.meta.url), "utf8");

    const MANIFEST = {
        mod: { name: "Element Mods", version: "0.1.0" },
        patches: [
            { id: "modding-tab", name: "Modding Tab", version: "1.0.0", required: true },
            { id: "p1", name: "Patch One", version: "1.0.0" },
            { id: "p2", name: "Patch Two", version: "1.0.0" },
        ],
    };

    async function boot({ preEnabled = [], prePaused = null } = {}) {
        const store = new Map();
        if (preEnabled.length) store.set("element-mods.enabled", JSON.stringify(preEnabled));
        if (prePaused !== null) store.set("element-mods.paused", JSON.stringify(prePaused));

        const events = { started: [], stopped: [], registered: [] };
        const sandbox = {
            console: { log() {}, error() {}, warn() {} },
            localStorage: {
                getItem: (k) => (store.has(k) ? store.get(k) : null),
                setItem: (k, v) => store.set(k, String(v)),
                removeItem: (k) => store.delete(k),
            },
            fetch: async (url) => ({
                ok: true,
                json: async () => (String(url).endsWith("manifest.json") ? MANIFEST : {}),
            }),
            document: {
                readyState: "complete",
                createElement(tag) {
                    const node = fakeElement(tag);
                    if (tag === "script") {
                        node.src = "";
                        // Simulate the browser executing the patch script on insert.
                        node.parentNode = null;
                    }
                    return node;
                },
            },
            window: {},
        };
        sandbox.document.body = {
            appendChild(child) {
                if (child.tagName === "SCRIPT") {
                    const id = String(child.src).match(/patches\/(.+)\.js$/)?.[1];
                    sandbox.window.mods.registerPatch(id, {
                        start: () => events.started.push(id),
                        stop: () => events.stopped.push(id),
                    });
                    events.registered.push(id);
                    child.onload && child.onload();
                }
                return child;
            },
        };
        sandbox.window.window = sandbox.window;
        sandbox.window.location = { reload() {} };
        vm.createContext(sandbox);
        vm.runInContext(loaderSrc, sandbox, { filename: "src/runtime/loader.js" });
        // Let the async init() chain run to completion.
        for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
        return { mods: sandbox.window.mods, store, events };
    }

    // Default: not paused.
    {
        const { mods } = await boot();
        assert.strictEqual(mods.isPaused(), false, "isPaused() defaults to false");
    }

    // Boot unpaused starts required + enabled set only.
    {
        const { events, store } = await boot({ preEnabled: ["p2"] });
        assert.deepStrictEqual(events.started.sort(), ["modding-tab", "p2"], "boot starts required + enabled only");
        assert.strictEqual(store.has("element-mods.paused"), false, "no paused key written when untouched");
    }

    // setPaused(true) stops started non-required patches and persists.
    {
        const { mods, events, store } = await boot({ preEnabled: ["p2"] });
        mods.setPaused(true);
        assert.deepStrictEqual(events.stopped, ["p2"], "pause stops started non-required patch");
        assert.strictEqual(events.started.includes("p1"), false, "pause does not start anything");
        assert.strictEqual(mods.isPaused(), true);
        assert.strictEqual(JSON.parse(store.get("element-mods.paused")), true, "paused flag persisted");
    }

    // setPatchEnabled(id, true) while paused persists WITHOUT starting.
    {
        const { mods, events, store } = await boot({ preEnabled: ["p2"] });
        mods.setPaused(true);
        events.started.length = 0;
        assert.strictEqual(mods.setPatchEnabled("p1", true), true);
        assert.deepStrictEqual(events.started, [], "no start while paused");
        assert.ok(JSON.parse(store.get("element-mods.enabled")).includes("p1"), "enabled set persisted");
        assert.strictEqual(mods.isPatchEnabled("p1"), true);
    }

    // setPaused(false) restarts exactly the enabled set.
    {
        const { mods, events } = await boot({ preEnabled: ["p2"] });
        mods.setPaused(true);
        events.started.length = 0;
        mods.setPatchEnabled("p1", true);
        mods.setPaused(false);
        assert.deepStrictEqual(events.started.sort(), ["p1", "p2"], "unpause starts exactly the enabled set");
    }

    // Boot while paused starts only the required patch.
    {
        const { mods, events } = await boot({ preEnabled: ["p2"], prePaused: true });
        assert.deepStrictEqual(events.started, ["modding-tab"], "boot while paused starts only required patch");
        assert.strictEqual(mods.isPaused(), true);
    }

    console.log("modding-tab part b (loader pause semantics) OK");
}
