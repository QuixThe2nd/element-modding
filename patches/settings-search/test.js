// Self-check for the settings-search patch's pure logic (matching, filtering, debounce, restore set).
// Run: node patches/settings-search/test.js
import assert from "node:assert";
import fs from "node:fs";
import vm from "node:vm";

const src = fs.readFileSync(new URL("./index.js", import.meta.url), "utf8");

let registered = null;
const sandbox = {
    window: {
        mods: {
            registerPatch(id, def) {
                registered = { id, def };
            },
        },
    },
    console,
};
sandbox.window.window = sandbox.window;
vm.createContext(sandbox);
vm.runInContext(src, sandbox);

assert.ok(registered, "patch should register");
assert.strictEqual(registered.id, "settings-search");
assert.strictEqual(typeof registered.def.start, "function");
assert.strictEqual(typeof registered.def.stop, "function");

// stop() before start() must not throw.
assert.doesNotThrow(() => registered.def.stop());

const t = registered.def._test;

// --- matchesQuery ---
assert.strictEqual(t.matchesQuery("Display name", "name"), true);
assert.strictEqual(t.matchesQuery("Display name", "NAME"), true, "case-insensitive");
assert.strictEqual(t.matchesQuery("DISPLAY NAME", "display"), true, "haystack case too");
assert.strictEqual(t.matchesQuery("Display name", "  name  "), true, "query trimmed");
assert.strictEqual(t.matchesQuery("Display name", "avatar"), false, "exact substring required");
assert.strictEqual(t.matchesQuery("Display name", ""), true, "empty query matches everything");
assert.strictEqual(t.matchesQuery("Display name", "   "), true, "whitespace query matches everything");
assert.strictEqual(t.matchesQuery("", ""), true);
assert.strictEqual(t.matchesQuery(undefined, "x"), false, "no text, no match");

// --- filterPlan ---
const a = { id: "a" };
const b = { id: "b" };
const c = { id: "c" };

const subsections = [
    { el: a, text: "Display name" },
    { el: b, text: "Email address" },
    { el: c, text: "Flair Display" },
];

const plan1 = t.filterPlan({ subsectionTexts: subsections, query: "display" });
assert.deepEqual(plan1.hide, [b], "hides non-matching subsections");
assert.strictEqual(plan1.visibleCount, 2, "overlapping query matches both");

const plan1b = t.filterPlan({ subsectionTexts: subsections, query: "name" });
assert.deepEqual(plan1b.hide, [b, c]);

const plan2 = t.filterPlan({ subsectionTexts: subsections, query: "   " });
assert.deepEqual(plan2.hide, [], "whitespace query hides nothing");
assert.strictEqual(plan2.visibleCount, 3);

const plan3 = t.filterPlan({ subsectionTexts: subsections, query: "email" });
assert.deepEqual(plan3.hide, [a, c]);
assert.strictEqual(plan3.visibleCount, 1);

const plan4 = t.filterPlan({ subsectionTexts: subsections, query: "nosuchthing" });
assert.deepEqual(plan4.hide, [a, b, c]);
assert.strictEqual(plan4.visibleCount, 0, "zero-match case for the hint path");

// --- sectionsToHide ---
const s1 = { id: "s1" };
const s2 = { id: "s2" };
const hidden = { __settingsSearchHidden: true };
const visible = { __settingsSearchHidden: false };
assert.deepEqual(t.sectionsToHide([{ el: s1, subsections: [hidden, hidden] }]), [s1], "all hidden -> hide section");
assert.deepEqual(t.sectionsToHide([{ el: s2, subsections: [hidden, visible] }]), [], "any visible -> keep section");
assert.deepEqual(t.sectionsToHide([{ el: s1, subsections: [] }]), [], "no subsections -> keep section");
assert.deepEqual(t.sectionsToHide([]), []);

// --- createRestoreSet ---
function fakeNode() {
    return { style: { display: "" }, __settingsSearchHidden: false };
}
const n1 = fakeNode();
const n2 = fakeNode();
const set = t.createRestoreSet();
set.add(n1);
set.add(n2);
assert.strictEqual(n1.style.display, "none");
assert.strictEqual(n1.__settingsSearchHidden, true);
assert.strictEqual(set.size(), 2);
set.clear();
assert.strictEqual(n1.style.display, "", "restore removes only the inline display we set");
assert.strictEqual(n1.__settingsSearchHidden, false);
assert.strictEqual(set.size(), 0);

// --- createDebounce (real short timers) ---
{
    let calls = 0;
    const timers = { setTimeout, clearTimeout };
    const debounced = t.createDebounce(() => calls++, 20, timers);
    debounced();
    debounced();
    debounced();
    await new Promise((r) => setTimeout(r, 60));
    assert.strictEqual(calls, 1, "rapid calls collapse to one invocation");

    // cancel() drops the pending call.
    let cancelled = 0;
    const debounced2 = t.createDebounce(() => cancelled++, 20, timers);
    debounced2();
    debounced2.cancel();
    await new Promise((r) => setTimeout(r, 60));
    assert.strictEqual(cancelled, 0, "cancelled pending call never fires");
}

// --- hasForeignMutation ---
{
    const linkedNode = (parent = null) => ({
        parent,
        contains(target) {
            for (let node = target; node; node = node.parent) {
                if (node === this) return true;
            }
            return false;
        },
    });
    const root = linkedNode();
    const child = linkedNode(root);
    const grandchild = linkedNode(child);
    const outside = linkedNode();
    assert.strictEqual(t.hasForeignMutation([{ target: child }, { target: grandchild }], root), false);
    assert.strictEqual(t.hasForeignMutation([{ target: child }, { target: outside }], root), true);
    assert.strictEqual(t.hasForeignMutation([{ target: child }], null), true);
    assert.strictEqual(t.hasForeignMutation([], root), false);
    assert.strictEqual(t.hasForeignMutation(undefined, root), false);
    assert.strictEqual(t.hasForeignMutation([{ target: root }], root), false, "root itself is inside");
}

// --- rightInsetFor ---
for (const [paddingRight, expected] of [
    ["100px", "100px"],
    ["24px", "24px"],
    ["12.5px", "12.5px"],
    ["0px", "100px"],
    ["", "100px"],
    [undefined, "100px"],
    ["auto", "100px"],
]) {
    assert.strictEqual(t.rightInsetFor(paddingRight), expected, `right inset for ${paddingRight}`);
}

// --- createFrameScheduler ---
{
    let nextHandle = 0;
    let calls = 0;
    const pending = new Map();
    const raf = (fn) => {
        const handle = ++nextHandle;
        pending.set(handle, fn);
        return handle;
    };
    const caf = (handle) => pending.delete(handle);
    const flush = () => {
        const callbacks = Array.from(pending.values());
        pending.clear();
        for (const callback of callbacks) callback();
    };
    const schedule = t.createFrameScheduler(() => calls++, raf, caf);
    schedule();
    schedule();
    schedule();
    assert.strictEqual(pending.size, 1, "only one frame is pending");
    flush();
    assert.strictEqual(calls, 1, "three calls before a frame run fn once");

    schedule();
    schedule.cancel();
    flush();
    assert.strictEqual(calls, 1, "cancel drops the pending frame");

    schedule();
    flush();
    assert.strictEqual(calls, 2, "a call after a flush schedules another run");
}

// --- activePanelOf ---
{
    const visible = { id: "visible" };
    const other = { id: "other" };
    const hidden = { id: "hidden" };
    assert.strictEqual(
        t.activePanelOf([{ display: "", el: visible }]),
        visible,
        "visible panel wins",
    );
    assert.strictEqual(
        t.activePanelOf([{ display: "none", el: hidden }, { display: "", el: visible }]),
        visible,
        "display:none entries are skipped",
    );
    assert.strictEqual(
        t.activePanelOf([{ display: "none", el: hidden }]),
        null,
        "all hidden -> null",
    );
    assert.strictEqual(t.activePanelOf([]), null, "empty list -> null");
    assert.strictEqual(t.activePanelOf([{ display: "", el: other }, { display: "", el: visible }]), other, "first visible wins");
}

// --- buildStatusLine ---
assert.strictEqual(t.buildStatusLine("name", { visibleCount: 2 }).startsWith("2 results for 'name'"), true);
assert.strictEqual(t.buildStatusLine("email", { visibleCount: 1 }).startsWith("1 result for 'email'"), true);
const zero = t.buildStatusLine("zzz", { visibleCount: 0 });
assert.ok(zero.startsWith("0 results for 'zzz'"), "zero-match status line");
assert.ok(zero.includes("try switching tabs"), "zero-match status hints at tab switch");

// --- observer / animation-frame integration ---
{
    let observerCallback = null;
    let onStatusWrite = null;
    const mutationRecords = [];

    class FakeNode {
        constructor(tagName, className = "") {
            this.tagName = tagName;
            this.className = className;
            this.children = [];
            this.parentNode = null;
            this.attributes = {};
            this.listeners = {};
            this.style = { cssText: "", display: "" };
            this._textContent = "";
            this.value = "";
        }

        get isConnected() {
            let node = this;
            while (node.parentNode) node = node.parentNode;
            return node.nodeType === 9;
        }

        get firstChild() {
            return this.children[0] || null;
        }

        get textContent() {
            return this._textContent;
        }

        set textContent(value) {
            this._textContent = String(value);
            if (this.attributes["aria-live"] === "polite" && onStatusWrite) onStatusWrite(this);
        }

        contains(target) {
            for (let node = target; node; node = node.parentNode) {
                if (node === this) return true;
            }
            return false;
        }

        setAttribute(name, value) {
            this.attributes[name] = String(value);
        }

        appendChild(child) {
            child.parentNode = this;
            this.children.push(child);
            return child;
        }

        insertBefore(child, before) {
            if (!before) return this.appendChild(child);
            child.parentNode = this;
            this.children.splice(this.children.indexOf(before), 0, child);
            return child;
        }

        remove() {
            if (!this.parentNode) return;
            const siblings = this.parentNode.children;
            siblings.splice(siblings.indexOf(this), 1);
            this.parentNode = null;
        }

        addEventListener(type, listener) {
            (this.listeners[type] || (this.listeners[type] = [])).push(listener);
        }

        removeEventListener(type, listener) {
            this.listeners[type] = (this.listeners[type] || []).filter((item) => item !== listener);
        }

        dispatch(type, event = {}) {
            event.target = event.target || this;
            for (const listener of this.listeners[type] || []) listener(event);
        }

        focus() {}

        querySelectorAll(selector) {
            if (selector === ":scope > [data-settings-search]") {
                return this.children.filter((child) => child.attributes["data-settings-search"] === "true");
            }
            const matches = [];
            for (const child of this.children) {
                if (child.matches(selector)) matches.push(child);
                matches.push(...child.querySelectorAll(selector));
            }
            return matches;
        }

        querySelector(selector) {
            return this.querySelectorAll(selector)[0] || null;
        }

        matches(selector) {
            if (selector === "input" || selector === "button") return this.tagName === selector;
            if (selector === '[aria-live="polite"]') return this.attributes["aria-live"] === "polite";
            if (!selector.startsWith(".")) return false;
            const className = selector.slice(1).split(":")[0];
            const classes = this.className ? this.className.split(/\s+/) : [];
            if (!classes.includes(className)) return false;
            return !selector.includes(":not([data-mods-panel])") ||
                this.attributes["data-mods-panel"] == null;
        }
    }

    const document = new FakeNode("#document");
    document.nodeType = 9;
    const body = document.appendChild(new FakeNode("body"));
    document.body = body;
    document.createElement = (tagName) => new FakeNode(tagName);
    document.querySelectorAll = (selector) => body.querySelectorAll(selector);
    document.querySelector = (selector) => body.querySelector(selector);

    const dialog = body.appendChild(new FakeNode("div", "mx_UserSettingsDialog"));
    const panel = dialog.appendChild(new FakeNode("div", "mx_TabbedView_tabPanel"));
    const tab = panel.appendChild(new FakeNode("div", "mx_SettingsTab"));
    tab.computedPaddingRight = "24px";
    const section = tab.appendChild(new FakeNode("div", "mx_SettingsSection"));
    section.appendChild(new FakeNode("div", "mx_SettingsSubsection")).textContent = "Display name";
    section.appendChild(new FakeNode("div", "mx_SettingsSubsection")).textContent = "Email address";

    let nextTimer = 0;
    let nextFrame = 0;
    const timers = new Map();
    const frames = new Map();
    const fakeSetTimeout = (fn) => {
        const handle = ++nextTimer;
        timers.set(handle, fn);
        return handle;
    };
    const fakeClearTimeout = (handle) => timers.delete(handle);
    const raf = (fn) => {
        const handle = ++nextFrame;
        frames.set(handle, fn);
        return handle;
    };
    const caf = (handle) => frames.delete(handle);
    const flushTimers = () => {
        const callbacks = Array.from(timers.values());
        timers.clear();
        for (const callback of callbacks) callback();
    };
    const flushFrames = () => {
        const callbacks = Array.from(frames.values());
        frames.clear();
        for (const callback of callbacks) callback();
    };

    let domRegistered = null;
    const domSandbox = {
        window: {
            requestAnimationFrame: raf,
            cancelAnimationFrame: caf,
            mods: {
                registerPatch(id, def) {
                    domRegistered = { id, def };
                },
            },
        },
        document,
        MutationObserver: class {
            constructor(callback) {
                observerCallback = callback;
            }
            observe() {}
            disconnect() {}
        },
        getComputedStyle: (node) => ({ paddingRight: node.computedPaddingRight || "" }),
        setTimeout: fakeSetTimeout,
        clearTimeout: fakeClearTimeout,
        console,
    };
    domSandbox.window.window = domSandbox.window;
    vm.createContext(domSandbox);
    vm.runInContext(src, domSandbox);

    onStatusWrite = (node) => mutationRecords.push({ target: node });
    let applyCount = 0;
    const panelQuerySelectorAll = panel.querySelectorAll.bind(panel);
    panel.querySelectorAll = (selector) => {
        if (selector === ".mx_SettingsSubsection") applyCount++;
        return panelQuerySelectorAll(selector);
    };

    domRegistered.def.start();
    const root = panel.querySelector(":scope > [data-settings-search]");
    const row = root.firstChild;
    const input = root.querySelector("input");
    assert.ok(observerCallback, "observer callback is captured");
    assert.strictEqual(root.style.marginRight, "24px", "root follows the settings tab's right inset");
    for (const node of [root, row]) {
        assert.ok(node.style.cssText.includes("box-sizing:border-box;"));
        assert.ok(node.style.cssText.includes("min-width:0;"));
    }
    assert.ok(input.style.cssText.includes("min-width:0;width:100%;box-sizing:border-box;"));

    input.value = "display";
    input.dispatch("input");
    flushTimers();
    for (let step = 0; step < 10 && (frames.size > 0 || mutationRecords.length > 0); step++) {
        flushFrames();
        if (mutationRecords.length > 0) {
            const records = mutationRecords.splice(0);
            observerCallback(records);
        }
        assert.ok(applyCount <= 5, "status mutations must not endlessly re-run applyNow");
    }
    assert.strictEqual(applyCount, 1, "the query is applied once without an observer loop");
    assert.strictEqual(frames.size, 0, "no animation frame remains pending");
    assert.strictEqual(mutationRecords.length, 0, "the observer mutation chain stops");
    const status = root.querySelector('[aria-live="polite"]');
    assert.ok(status.textContent.startsWith("1 result for 'display'"));

    // Enter applies the current input value even if no input event fired.
    input.value = "email";
    input.dispatch("keydown", { key: "Enter" });
    flushFrames();
    assert.ok(
        status.textContent.startsWith("1 result for 'email'"),
        "Enter applies the filter without an input event or a debounce timer flush",
    );

    // Enter cancels typing's pending debounce, so flushing timers cannot apply twice.
    const applyCountBeforeEnter = applyCount;
    input.value = "name";
    input.dispatch("input");
    assert.strictEqual(timers.size, 1, "typing still schedules a debounce timer");
    input.dispatch("keydown", { key: "Enter" });
    flushFrames();
    assert.strictEqual(applyCount, applyCountBeforeEnter + 1, "Enter applies once immediately");
    flushTimers();
    flushFrames();
    assert.strictEqual(applyCount, applyCountBeforeEnter + 1, "the cancelled debounce does not apply again");
    assert.ok(status.textContent.startsWith("1 result for 'name'"));

    input.value = "name";
    input.dispatch("input");
    flushTimers();
    assert.strictEqual(frames.size, 1, "a filter frame is pending before stop");
    domRegistered.def.stop();
    assert.strictEqual(frames.size, 0, "stop cancels the pending filter frame");
}

// --- manifest ---
const manifest = JSON.parse(fs.readFileSync(new URL("./manifest.json", import.meta.url), "utf8"));
assert.strictEqual(manifest.id, "settings-search", "manifest id matches folder");
assert.strictEqual(manifest.version, "1.0.2");
assert.strictEqual(manifest.author, "QuixThe2nd");
assert.strictEqual(manifest.main, "index.js");

console.log("settings-search self-check OK");
