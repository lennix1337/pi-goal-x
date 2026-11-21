import type { AgentToolResult } from "@earendil-works/pi-coding-agent";

// external: Pi 0.99+ reads isError; older supported SDKs do not.
/** Goal tool result that can mark itself as an error. */
export type GoalToolResult = AgentToolResult<unknown> & { isError?: boolean };
