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

// --- manifest ---
const manifest = JSON.parse(fs.readFileSync(new URL("./manifest.json", import.meta.url), "utf8"));
assert.strictEqual(manifest.id, "settings-search", "manifest id matches folder");
assert.strictEqual(manifest.version, "1.0.0");
assert.strictEqual(manifest.author, "QuixThe2nd");
assert.strictEqual(manifest.main, "index.js");

console.log("settings-search self-check OK");
