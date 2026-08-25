import { CompositeCredentialProvider } from "../adapters/credentials/composite.js";
import { ProjectConfigSchema } from "../config/schema.js";
import type { CredentialPort } from "../ports/credentials.port.js";
import type { ProjectRef } from "../ports/jira-read.port.js";

export type VisibleProjects = {
  projects: ProjectRef[];
  truncated: boolean;
  /** Set when the list could not be fetched; the caller still has to ask the user. */
  error?: string;
};

/**
 * Advisory list of Jira projects this account can see.
 *
 * Used only to help a person (or an agent's user) pick a key when none could
 * be decided safely. It never selects one - Safe Bootstrap holds regardless of
 * how many projects come back.
 */
export async function listVisibleProjects(
  credentials: CredentialPort = new CompositeCredentialProvider(),
): Promise<VisibleProjects> {
  const described = credentials.describe();
  if (!described.baseUrl || !described.email || !described.hasToken) {
    return { projects: [], truncated: false, error: "Jira credentials are not configured." };
  }

  try {
    const { JiraCloudReadAdapter } = await import("../adapters/jira-cloud/jira-read.adapter.js");
    const jira = new JiraCloudReadAdapter(credentials, ProjectConfigSchema.parse({}));
    return await jira.listProjects();
  } catch (err) {
    const { toJamError } = await import("../domain/errors.js");
    return { projects: [], truncated: false, error: toJamError(err).message };
  }
}
