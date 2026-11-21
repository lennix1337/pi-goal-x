
import { visibleWidth } from "@earendil-works/pi-tui";

/** Inner content width between the ││ borders for a dialog at termWidth. */
export function dialogInnerWidth(termWidth: number, maxInner = 64): number {
	return Math.min(termWidth, maxInner) - 2;
}

/** One bordered line: exactly innerWidth visible chars between ││. */
export function borderedLine(accent: (s: string) => string, innerWidth: number, content: string): string {
	const vis = visibleWidth(content);
	const fill = innerWidth - vis;
	return accent("│") + content + (fill > 0 ? " ".repeat(fill) : "") + accent("│");
}

/** The ── run used by ┌/├/└ borders. */
export function horizontalRule(innerWidth: number): string {
	return "─".repeat(innerWidth);
}
