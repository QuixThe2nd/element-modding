// Self-check for the wa-dm-badges patch.
// Run: node patches/wa-dm-badges/test.js
import assert from "node:assert";
import fs from "node:fs";

const manifest = JSON.parse(fs.readFileSync(new URL("./manifest.json", import.meta.url), "utf8"));
assert.ok(manifest, "manifest.json should parse");
assert.strictEqual(manifest.id, "wa-dm-badges", "id should match folder name");
assert.strictEqual(manifest.author, "Quix", "author should be Quix");
assert.ok(!manifest.required, "manifest should not have a truthy \"required\" key");

const src = fs.readFileSync(new URL("./index.js", import.meta.url), "utf8");
for (const needle of [
    "mxSdkContext",
    "setInterval",
    "getNotificationState",
    "registerPatch",
    "mxSpaceStore",
]) {
    assert.ok(src.includes(needle), `index.js should reference ${needle}`);
}
assert.ok(src.includes("window.mods.registerPatch"), "index.js should call window.mods.registerPatch");

console.log("wa-dm-badges self-check OK");
