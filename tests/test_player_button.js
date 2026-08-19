const assert = require("assert");
const btn = require("../extension/player-button.js");

const child = { id: "lvt-toggle", parentElement: null, parentNode: null };
const parent = { id: "wrap", parentElement: null, parentNode: null };
child.parentElement = parent;
child.parentNode = parent;

assert.strictEqual(btn.nodeOrAncestorHasId(child, "lvt-toggle"), true);
assert.strictEqual(btn.nodeOrAncestorHasId(parent, "lvt-toggle"), false);
assert.strictEqual(btn.eventHitsToggle({ target: child }), true);
assert.strictEqual(btn.eventHitsToggle({ target: parent }), false);
assert.strictEqual(btn.eventHitsToggle({ target: parent, composedPath: () => [child] }), true);

let n = 0;
const fire = btn.makeDebounced(function () { n += 1; }, 1000);
assert.strictEqual(fire({}), true);
assert.strictEqual(fire({}), false);
assert.strictEqual(n, 1);

const host = {
  style: { position: "" },
  child: null,
  appendChild(node) { this.child = node; node.parentNode = this; },
};
const overlay = { parentNode: null };
assert.strictEqual(btn.mountOverlay(host, overlay), true);
assert.strictEqual(overlay.parentNode, host);
assert.strictEqual(host.style.position, "relative");

const swallowed = [];
btn.swallow({
  preventDefault() { swallowed.push("p"); },
  stopPropagation() { swallowed.push("s"); },
  stopImmediatePropagation() { swallowed.push("i"); },
});
assert.deepStrictEqual(swallowed, ["p", "s", "i"]);

console.log("player-button ok");
