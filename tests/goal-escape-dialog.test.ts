import assert from "node:assert/strict";
import test from "node:test";

import { showEscapeDialog } from "../extensions/widgets/goal-escape-dialog.ts";
import { visibleWidth, type Component } from "@earendil-works/pi-tui";
import { createMockExtensionContext, createMockTUI, createMockTheme } from "./tui-test-utils.ts";
import type { MockExtensionContext } from "./tui-test-utils.ts";


test("showEscapeDialog returns continue_working in headless context", async () => {
	const ctx = { hasUI: false } as any;
	const result = await showEscapeDialog(ctx, "Test objective");
	assert.equal(result, "continue_working");
});

test("showEscapeDialog returns continue_working for empty objective", async () => {
	const ctx = { hasUI: false } as any;
	const result = await showEscapeDialog(ctx, "");
	assert.equal(result, "continue_working");
});

test("showEscapeDialog returns continue_working for long objective", async () => {
	const ctx = { hasUI: false } as any;
	const longObjective = "A".repeat(500);
	const result = await showEscapeDialog(ctx, longObjective);
	assert.equal(result, "continue_working");
});


test("showEscapeDialog does not crash when called with hasUI=true (regression: innerWidth ReferenceError)", async () => {
	const ctx = createMockExtensionContext();

	const promise = showEscapeDialog(ctx, "Test objective");

	assert.ok(ctx._customCalls.length >= 1, "custom() was called (dialog invoked)");

	const record = ctx._customCalls[0]!;
	const { tui } = createMockTUI();
	const theme = createMockTheme();
	let doneValue: string | undefined;

	const component = record.factory(
		tui,
		theme,
		undefined,
		(result: any) => { doneValue = result; },
	) as Component;

	const lines40 = component.render(40);
	assert.ok(lines40.length > 2, "Renders at width 40");
	const lines80 = component.render(80);
	assert.ok(lines80.length > 2, "Renders at width 80");
	const lines64 = component.render(64);
	assert.ok(lines64.length > 2, "Renders at width 64");
});

test("escape dialog component renders correct structure and content", async () => {
	const ctx = createMockExtensionContext();
	const promise = showEscapeDialog(ctx, "Test objective");

	const record = ctx._customCalls[0]!;
	const { tui } = createMockTUI();
	const theme = createMockTheme();
	let doneValue: string | undefined;

	const component = record.factory(
		tui,
		theme,
		undefined,
		(result: any) => { doneValue = result; },
	) as Component;

	const lines = component.render(80);
	const text = lines.join("\n");

	assert.ok(lines[0]!.includes("┌"), "Top border present");
	assert.ok(lines[lines.length - 1]!.includes("└"), "Bottom border present");

	assert.ok(text.includes("Audit interrupted by Escape"), "Shows header");
	assert.ok(text.includes("Mark complete without audit"), "Shows complete option");
	assert.ok(text.includes("Continue working"), "Shows continue option");
	assert.ok(text.includes("Test objective"), "Shows objective");
	assert.ok(text.includes("Enter to select"), "Shows footer instructions");

	assert.ok(text.includes("↑↓"), "Shows navigation hint");
	assert.ok(text.includes("Esc"), "Shows escape hint");
});

test("escape dialog handleInput: escape returns continue_working", async () => {
	const ctx = createMockExtensionContext();
	const promise = showEscapeDialog(ctx, "Test objective");

	const record = ctx._customCalls[0]!;
	const { tui, state: tuiState } = createMockTUI();
	const theme = createMockTheme();
	let doneValue: string | undefined;

	const component = record.factory(
		tui,
		theme,
		undefined,
		(result: any) => { doneValue = result; },
	) as Component;

	const beforeUp = tuiState.requestRenderCalls;
	component.handleInput!("\u001b[A");
	assert.ok(tuiState.requestRenderCalls > beforeUp, "Up triggers re-render");

	const beforeDown = tuiState.requestRenderCalls;
	component.handleInput!("\u001b[B");
	assert.ok(tuiState.requestRenderCalls > beforeDown, "Down triggers re-render");

	component.handleInput!("\u001b");
	assert.equal(doneValue, "continue_working", "Escape returns continue_working");
});

test("escape dialog handleInput: enter selects focused option", async () => {
	const ctx = createMockExtensionContext();
	const promise = showEscapeDialog(ctx, "Test objective");

	const record = ctx._customCalls[0]!;
	const { tui } = createMockTUI();
	const theme = createMockTheme();

	let doneValue: string | undefined;
	const component = record.factory(
		tui,
		theme,
		undefined,
		(result: any) => { doneValue = result; },
	) as Component;

	component.handleInput!("\r");
	assert.equal(doneValue, "continue_working", "Default enter selects continue_working");
});

test("escape dialog handleInput: up + enter selects complete_without_audit", async () => {
	const ctx = createMockExtensionContext();
	const promise = showEscapeDialog(ctx, "Test objective");

	const record = ctx._customCalls[0]!;
	const { tui } = createMockTUI();
	const theme = createMockTheme();

	let doneValue: string | undefined;
	const component = record.factory(
		tui,
		theme,
		undefined,
		(result: any) => { doneValue = result; },
	) as Component;

	component.handleInput!("\u001b[A");
	component.handleInput!("\r");
	assert.equal(doneValue, "complete_without_audit", "Up+enter selects complete_without_audit");
});

test("escape dialog handleInput: navigation wraps around", async () => {
	const ctx = createMockExtensionContext();
	const promise = showEscapeDialog(ctx, "Test objective");

	const record = ctx._customCalls[0]!;
	const { tui } = createMockTUI();
	const theme = createMockTheme();

	let doneValue: string | undefined;
	const component = record.factory(
		tui,
		theme,
		undefined,
		(result: any) => { doneValue = result; },
	) as Component;

	component.handleInput!("\u001b[A");
	component.handleInput!("\u001b[A");
	component.handleInput!("\r");
	assert.equal(doneValue, "continue_working", "Navigation wraps around correctly");

	doneValue = undefined;
	const component2 = record.factory(
		tui,
		theme,
		undefined,
		(result: any) => { doneValue = result; },
	) as Component;

	component2.handleInput!("\u001b[B");
	component2.handleInput!("\r");
	assert.equal(doneValue, "complete_without_audit", "Down wraps around correctly");
});

test("escape dialog component dispose restores hardware cursor", async () => {
	const ctx = createMockExtensionContext();
	const promise = showEscapeDialog(ctx, "Test objective");

	const record = ctx._customCalls[0]!;
	const { tui, state: tuiState } = createMockTUI();
	const theme = createMockTheme();

	const component = record.factory(
		tui,
		theme,
		undefined,
		() => {},
	) as any;
	assert.ok(tuiState.setShowHardwareCursorCalls.length >= 1);
	assert.equal(tuiState.setShowHardwareCursorCalls[0], false);

	component.dispose?.();
	const lastCall = tuiState.setShowHardwareCursorCalls[tuiState.setShowHardwareCursorCalls.length - 1];
	assert.equal(lastCall, false, "Hardware cursor restored after dispose");
});

for (const testWidth of [50, 60, 70, 80, 90, 109]) {
	test(`escape dialog renders without overflow at width ${testWidth}`, async () => {
		const ctx1 = createMockExtensionContext();
		const p1 = showEscapeDialog(ctx1, "Short");
		const rec1 = ctx1._customCalls[0]!;
		const { tui } = createMockTUI();
		const theme = createMockTheme();
		const comp1 = rec1.factory(tui, theme, undefined, () => {}) as Component;
		const lines = comp1.render(testWidth);
		for (let i = 0; i < lines.length; i++) {
			if (lines[i]) {
				const w = visibleWidth(lines[i]!);
				assert.ok(
					w <= testWidth,
					`Short objective at width ${testWidth}, line ${i}: visibleWidth=${w} > ${testWidth}`,
				);
			}
		}
	});
}

test("escape dialog with extreme-length objective at various widths", async () => {
	const { tui } = createMockTUI();
	const theme = createMockTheme();

	for (const testWidth of [50, 60, 70, 80, 90, 109]) {
		const ctx = createMockExtensionContext();
		const p = showEscapeDialog(ctx, "A very long objective that should definitely overflow at narrow terminal widths if there's a bug in the rendering code. ".repeat(10));
		const rec = ctx._customCalls[0]!;
		const comp = rec.factory(tui, theme, undefined, () => {}) as Component;

		const lines = comp.render(testWidth);
		for (let i = 0; i < lines.length; i++) {
			if (lines[i]) {
				const w = visibleWidth(lines[i]!);
				assert.ok(
					w <= testWidth,
					`Long objective at width ${testWidth}, line ${i}: visibleWidth=${w} > ${testWidth}`,
				);
			}
		}
	}
});

test("escape dialog renders various objective lengths without error", async () => {
	const ctx1 = createMockExtensionContext();
	const p1 = showEscapeDialog(ctx1, "Short");
	const rec1 = ctx1._customCalls[0]!;
	const { tui } = createMockTUI();
	const theme = createMockTheme();
	const comp1 = rec1.factory(tui, theme, undefined, () => {}) as Component;
	assert.doesNotThrow(() => comp1.render(40));
	assert.doesNotThrow(() => comp1.render(80));

	const ctx2 = createMockExtensionContext();
	const p2 = showEscapeDialog(ctx2, "A".repeat(200));
	const rec2 = ctx2._customCalls[0]!;
	const comp2 = rec2.factory(tui, theme, undefined, () => {}) as Component;
	const longLines = comp2.render(80);
	assert.ok(longLines.length > 0, "Long objective renders");

	const ctx3 = createMockExtensionContext();
	const p3 = showEscapeDialog(ctx3, "");
	const rec3 = ctx3._customCalls[0]!;
	const comp3 = rec3.factory(tui, theme, undefined, () => {}) as Component;
	const emptyLines = comp3.render(80);
	assert.ok(emptyLines.length > 0, "Empty objective renders");
});
