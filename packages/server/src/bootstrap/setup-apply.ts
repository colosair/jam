import { JAM_MCP_ENTRY, writeJamMcpEntry } from "./mcp-config-merger.js";
import { writeProjectBinding } from "./project-bindings.js";
import { writeBootstrapConfig } from "./project-config-bootstrapper.js";
import type { SetupChange, SetupPlan } from "./setup-plan.js";

export type AppliedChange = SetupChange & { applied: true };

export type ApplyResult = {
  applied: AppliedChange[];
  /** Mirrors plan.changes.length > 0 - useful for agents deciding what to report. */
  changesApplied: boolean;
};

export type ApplyOptions = {
  /** Project root; defaults to the root recorded in the plan. */
  root?: string;
  /** The jam entry to write. Defaults to the canonical form. */
  mcpEntry?: unknown;
  /** Injected by tests to isolate ~/.jam. */
  home?: string;
};

/**
 * Execute exactly the changes a plan listed - nothing more.
 *
 * Apply deliberately re-decides nothing. If a change is not in the plan it
 * does not happen, which is what makes `plan` a trustworthy preview and keeps
 * human and agent paths honest about what they are about to do.
 *
 * Idempotent in practice: re-detecting after an apply produces a plan with no
 * changes, so running setup twice is a no-op rather than a rewrite.
 */
export function applySetupPlan(plan: SetupPlan, options: ApplyOptions = {}): ApplyResult {
  const root = options.root ?? plan.project?.root;
  const applied: AppliedChange[] = [];

  for (const change of plan.changes) {
    switch (change.target) {
      case "project-config": {
        if (!root) throw new Error("Cannot apply a project-config change without a project root.");
        writeBootstrapConfig(root, change.key);
        applied.push({ ...change, applied: true });
        break;
      }
      case "mcp-config": {
        if (!root) throw new Error("Cannot apply an mcp-config change without a project root.");
        writeJamMcpEntry(root, options.mcpEntry ?? JAM_MCP_ENTRY);
        applied.push({ ...change, applied: true });
        break;
      }
      case "personal-binding": {
        // Everything needed is in the change. The workspace was identified and
        // the key decided at plan time, so applying cannot reach a different
        // answer than the one previewed.
        writeProjectBinding(
          {
            workspace: change.workspaceId,
            key: change.key,
            ...(root ? { path: root } : {}),
          },
          options.home,
        );
        applied.push({ ...change, applied: true });
        break;
      }
    }
  }

  return { applied, changesApplied: applied.length > 0 };
}
