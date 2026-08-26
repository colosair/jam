import { mkdtempSync } from "node:fs";
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

process.env["HOME"] = sandbox;
process.env["USERPROFILE"] = sandbox;
