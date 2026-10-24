import type { AgentToolResult } from "@earendil-works/pi-coding-agent";

/**
 * A goal tool result that may mark itself as an error. Pi 0.99+ reads `isError` on tool results;
 * older hosts in the peer range neither type nor read it, and the result text still states the
 * refusal there. Declaring the field here keeps every supported SDK type-checking.
 */
export type GoalToolResult = AgentToolResult<unknown> & { isError?: boolean };
