// Self-check for the quick-switcher-low-priority patch's registration and
// its pure helpers.
// Run: node patches/quick-switcher-low-priority/test.js
import assert from "node:assert";
import fs from "node:fs";
import vm from "node:vm";

const src = fs.readFileSync(new URL("./index.js", import.meta.url), "utf8");

let registered = null;

// -- minimal browser mocks ------------------------------------------------
const storage = new Map();

const sandbox = {
    console,
    setInterval: () => 0,
    clearInterval: () => {},
    document: {
        querySelectorAll: () => [],
        querySelector: () => null,
        getElementById: () => null,
        createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }),
        head: { appendChild() {} },
        body: {},
    },
    window: {
        mods: {
            registerPatch(id, def) {
                registered = { id, def };
            },
        },
        localStorage: {
            getItem: (k) => (storage.has(k) ? storage.get(k) : null),
            setItem: (k, v) => storage.set(k, v),
            removeItem: (k) => storage.delete(k),
        },
        mxMatrixClientPeg: { safeGet: () => ({ getRooms: () => [] }) },
    },
};
sandbox.window.window = sandbox.window;
vm.createContext(sandbox);
vm.runInContext(src, sandbox);

assert.ok(registered, "patch should register");
assert.strictEqual(registered.id, "quick-switcher-low-priority");
assert.strictEqual(typeof registered.def.start, "function");
assert.strictEqual(typeof registered.def.stop, "function");

assert.ok(registered.def._test, "patch should expose a _test object");
const t = registered.def._test;

// -- isLowPriorityRoom ----------------------------------------------------
assert.strictEqual(typeof t.isLowPriorityRoom, "function", "_test.isLowPriorityRoom");
assert.strictEqual(t.isLowPriorityRoom({ roomId: "x", tags: { "m.lowpriority": {} } }), true);
assert.strictEqual(t.isLowPriorityRoom({ roomId: "x", tags: { "m.lowpriority": undefined } }), true, "own property even when falsy");
assert.strictEqual(t.isLowPriorityRoom({ roomId: "x", tags: {} }), false);
assert.strictEqual(t.isLowPriorityRoom({ roomId: "x", tags: { "m.favourite": {} } }), false);
assert.strictEqual(t.isLowPriorityRoom({ roomId: "x" }), false, "tags undefined");
assert.strictEqual(t.isLowPriorityRoom({ roomId: "x", tags: null }), false, "tags null");
assert.strictEqual(t.isLowPriorityRoom(null), false, "room null");
assert.strictEqual(t.isLowPriorityRoom(undefined), false, "room undefined");

// -- roomIdFromOptionId ---------------------------------------------------
assert.strictEqual(typeof t.roomIdFromOptionId, "function", "_test.roomIdFromOptionId");
assert.strictEqual(t.roomIdFromOptionId("mx_SpotlightDialog_button_result_!abc:example.com"), "!abc:example.com");
assert.strictEqual(t.roomIdFromOptionId("mx_SpotlightDialog_button_result_!x_y:server.org"), "!x_y:server.org");
assert.strictEqual(t.roomIdFromOptionId("mx_SpotlightDialog_button_result_!a_b_c:d.e"), "!a_b_c:d.e");
assert.strictEqual(t.roomIdFromOptionId("mx_SpotlightDialog_button_noResults"), null, "non-result id");
assert.strictEqual(t.roomIdFromOptionId("mx_SpotlightDialog_button_result_"), null, "empty roomId");
assert.strictEqual(t.roomIdFromOptionId(""), null, "empty id");
assert.strictEqual(t.roomIdFromOptionId(null), null, "null id");
assert.strictEqual(t.roomIdFromOptionId(undefined), null, "undefined id");
assert.strictEqual(t.roomIdFromOptionId("something-else-entirely"), null, "unrelated id");

// -- partitionOptionIds ---------------------------------------------------
assert.strictEqual(typeof t.partitionOptionIds, "function", "_test.partitionOptionIds");
const low = new Set(["!low1:x", "!low2:x"]);
const ids = [
    "mx_SpotlightDialog_button_result_!a:x",
    "mx_SpotlightDialog_button_result_!low1:x",
    "mx_SpotlightDialog_button_result_!b:x",
    "mx_SpotlightDialog_button_result_!low2:x",
    "mx_SpotlightDialog_button_result_!c:x",
];
let p = t.partitionOptionIds(ids, low);
// Copy into local-realm arrays: deepStrictEqual compares prototypes and
// the vm returns foreign-realm arrays.
p = { normal: [...p.normal], low: [...p.low] };
assert.deepStrictEqual(p.normal, [
    "mx_SpotlightDialog_button_result_!a:x",
    "mx_SpotlightDialog_button_result_!b:x",
    "mx_SpotlightDialog_button_result_!c:x",
], "normal keeps input order");
assert.deepStrictEqual(p.low, [
    "mx_SpotlightDialog_button_result_!low1:x",
    "mx_SpotlightDialog_button_result_!low2:x",
], "low keeps input order");
// Options whose id can't be parsed are never low-priority.
p = t.partitionOptionIds(["mx_SpotlightDialog_button_result_!low1:x", "mx_SpotlightDialog_button_noResults"], low);
p = { normal: [...p.normal], low: [...p.low] };
assert.deepStrictEqual(p.normal, ["mx_SpotlightDialog_button_noResults"]);
assert.deepStrictEqual(p.low, ["mx_SpotlightDialog_button_result_!low1:x"]);
p = t.partitionOptionIds([], low);
assert.deepStrictEqual([...p.normal], [], "empty input normal");
assert.deepStrictEqual([...p.low], [], "empty input low");

// -- planSections ---------------------------------------------------------
assert.strictEqual(typeof t.planSections, "function", "_test.planSections");
const sections = [
    { id: "rooms", normalCount: 3, lowCount: 0 },
    { id: "people", normalCount: 2, lowCount: 1 },
    { id: "other", normalCount: 1, lowCount: 4 },
];
let plan = t.planSections(sections, false);
assert.strictEqual(plan.collapsed, true, "collapsed when not expanded");
assert.strictEqual(plan.toggleOnSectionId, "people", "toggle goes on the first section with lowCount>0");
plan = t.planSections(sections, true);
assert.strictEqual(plan.collapsed, false, "expanded flag respected");
assert.strictEqual(plan.toggleOnSectionId, "people");
plan = t.planSections(
    [
        { id: "a", normalCount: 5, lowCount: 0 },
        { id: "b", normalCount: 1, lowCount: 0 },
    ],
    false,
);
assert.strictEqual(plan.toggleOnSectionId, null, "no toggle when no section has low-priority results");
assert.strictEqual(plan.collapsed, true);
plan = t.planSections([], false);
assert.strictEqual(plan.toggleOnSectionId, null, "no sections -> no toggle");

// -- pickVisibleTarget ----------------------------------------------------
assert.strictEqual(typeof t.pickVisibleTarget, "function", "_test.pickVisibleTarget");
const hidden = { offsetParent: null };
const firstVisible = { offsetParent: {} };
const secondVisible = { offsetParent: {} };
assert.strictEqual(t.pickVisibleTarget([hidden, firstVisible], firstVisible), null, "visible active row needs no redirect");
assert.strictEqual(t.pickVisibleTarget([hidden, firstVisible], null), null, "missing active row needs no redirect");
assert.strictEqual(
    t.pickVisibleTarget([hidden, firstVisible, secondVisible], hidden),
    firstVisible,
    "hidden active row redirects to the first visible node in DOM order",
);
assert.strictEqual(t.pickVisibleTarget([hidden, { offsetParent: null }], hidden), null, "no visible target");

// -- findRovingContext ----------------------------------------------------
assert.strictEqual(typeof t.findRovingContext, "function", "_test.findRovingContext");
const contextValue = { state: { nodes: [] }, dispatch() {} };
const nodeWithContext = {
    __reactFiber$abc: {
        return: {
            memoizedProps: { value: contextValue },
        },
    },
};
assert.strictEqual(t.findRovingContext(nodeWithContext), contextValue, "finds the roving provider up the fiber chain");
assert.strictEqual(
    t.findRovingContext({ __reactFiber$abc: { return: { memoizedProps: { value: {} } } } }),
    null,
    "ignores a chain without a roving provider",
);
assert.strictEqual(t.findRovingContext({}), null, "node without a fiber");

// -- fixActiveRow ---------------------------------------------------------
assert.strictEqual(typeof t.fixActiveRow, "function", "_test.fixActiveRow");
const dispatches = [];
const scrolls = [];
const rovingContext = {
    state: { nodes: [] },
    dispatch(action) {
        dispatches.push(action);
    },
};
const makeOption = (id, offsetParent) => ({
    id,
    offsetParent,
    __reactFiber$test: { memoizedProps: { value: rovingContext } },
    scrollIntoView(options) {
        scrolls.push({ node: this, options });
    },
});
const hiddenActive = makeOption("hidden-active", null);
const visibleTarget = makeOption("visible-target", {});
rovingContext.state.nodes = [hiddenActive, visibleTarget];
let activeId = hiddenActive.id;
sandbox.document.querySelector = (selector) => (
    selector === ".mx_SpotlightDialog input[type=text]"
        ? { getAttribute: (name) => (name === "aria-activedescendant" ? activeId : null) }
        : null
);
sandbox.document.getElementById = (id) => rovingContext.state.nodes.find((node) => node.id === id) || null;

t.fixActiveRow();
assert.strictEqual(dispatches.length, 1, "hidden active row causes exactly one SET_FOCUS dispatch");
assert.strictEqual(dispatches[0].type, "SET_FOCUS");
assert.strictEqual(dispatches[0].payload.node, visibleTarget, "redirects to the first visible row");
assert.strictEqual(scrolls.length, 1, "scrolls the visible target into view");
assert.strictEqual(scrolls[0].node, visibleTarget);
assert.deepStrictEqual({ ...scrolls[0].options }, { block: "nearest" });

activeId = visibleTarget.id;
t.fixActiveRow();
assert.strictEqual(dispatches.length, 1, "visible active row causes no additional dispatch");
assert.strictEqual(scrolls.length, 1, "visible active row causes no additional scrolling");

console.log("quick-switcher-low-priority self-check OK");
