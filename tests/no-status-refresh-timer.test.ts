import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../extensions/goal-state.ts", import.meta.url), "utf8");

test("no periodic status-refresh timer is scheduled while goals are active", () => {
	// PR #5 removed the 1s status refresh interval that forced TUI redraws
	// (ui.setStatus + goalWidgetComponent.update), pulling users out of
	// terminal scrollback while reviewing long goals. Reintroducing a
	// STATUS_REFRESH_MS constant or a statusRefreshTimer would regress that.
	assert.doesNotMatch(source, /STATUS_REFRESH_MS/);
	assert.doesNotMatch(source, /statusRefreshTimer/);
	assert.doesNotMatch(source, /syncStatusRefresh/);
	assert.doesNotMatch(source, /stopStatusRefresh/);
});

test("the widget and footer status still update on state changes", () => {
	// The widget reads live values through closures; updateUI still requests
	// renders on state changes so elapsed time catches up on natural renders.
	assert.match(source, /goalWidgetComponentRef\.current\?\.update\(\)/);
	assert.match(source, /ctx\.ui\.setStatus\("goal"/);
});

test("the goal box is a footer piece: short `meta:` status, no above-editor box by default", () => {
	// The status moved to a one-line `meta: ...` footer segment (also emitted
	// on pi.events); the focused-goal footer segment is not composed from
	// footerStatus, and the unfocused banner is a plain line, not a box.
	const line = readFileSync(new URL("../extensions/goal-status-line.ts", import.meta.url), "utf8");
	assert.doesNotMatch(source, /footerStatus\(displayGoal\)/);
	assert.doesNotMatch(source, /goal: unfocused/);
	assert.match(source, /goalStatusPayload\(/);
	assert.match(line, /goal-x:status:v1/);
	assert.match(line, /meta: /);
	assert.match(line, /\/goal-focus/);
});
