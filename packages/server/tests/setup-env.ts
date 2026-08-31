import { mkdtempSync } from "node:fs";
import { track } from "./support/temp.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Point the home directory at a throwaway one, for every test file.
 *
 * `~/.jam` holds the user's runtime choice and their workspace bindings, and a
 * test that forgets to inject `home` would otherwise write into the machine it
 * runs on - which is exactly what happened while this feature was being built.
 * Injection stays the rule; this is the backstop for when it is missed.
 */
const sandbox = mkdtempSync(join(tmpdir(), "jam-test-home-"));
track(sandbox);

process.env["HOME"] = sandbox;
process.env["USERPROFILE"] = sandbox;

/**
 * Then make it credential-free, which repointing HOME does not do.
 *
 * Two of the three credential sources are per-user rather than per-HOME: the
 * OS secret store, and on Windows the User environment in HKCU. A suite that
 * only sandboxes HOME therefore passes or fails depending on whether the
 * developer running it once ran `setx JIRA_API_TOKEN` or `jam auth login` -
 * and "zero HOME" gets mistaken for "zero credentials". CI is credential-free
 * for real; this makes a developer machine behave the same way.
 *
 * The integration suite is the one place that must reach real credentials, and
 * it is opt-in through JAM_INTEGRATION, so it is exempt.
 */
if (!process.env["JAM_INTEGRATION"]) {
  delete process.env["JIRA_BASE_URL"];
  delete process.env["JIRA_EMAIL"];
  delete process.env["JIRA_API_TOKEN"];
  process.env["JAM_DISABLE_SECRET_STORE"] = "1";
  process.env["JAM_DISABLE_USER_ENV"] = "1";
}

