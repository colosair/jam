// Release SHA integrity - finalize tags the commit the registry actually
// published, resolved from npm's signed provenance. These pin the refusal
// paths: wrong repository, torn publish, missing attestation.
import { describe, expect, it } from "vitest";
// @ts-expect-error - plain .mjs script, no type surface on purpose
import { resolvePublishedCommit } from "../../../../scripts/resolve-published-commit.mjs";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

const document = (commit: string, repository = "https://github.com/colosair/jam") => ({
  attestations: [
    {
      predicateType: "https://slsa.dev/provenance/v1",
      bundle: {
        dsseEnvelope: {
          payload: Buffer.from(
            JSON.stringify({
              predicate: {
                buildDefinition: {
                  externalParameters: { workflow: { repository } },
                  resolvedDependencies: [{ digest: { gitCommit: commit } }],
                },
              },
            }),
          ).toString("base64"),
        },
      },
    },
  ],
});

describe("resolve-published-commit - the tag target is the published commit", () => {
  it("agreeing provenance across all three packages resolves to that commit", async () => {
    await expect(resolvePublishedCommit("1.9.9", [document(SHA_A), document(SHA_A), document(SHA_A)])).resolves.toBe(SHA_A);
  });
  it("a torn publish is refused", async () => {
    await expect(resolvePublishedCommit("1.9.9", [document(SHA_A), document(SHA_B), document(SHA_A)])).rejects.toThrow(/torn publish/);
  });
  it("provenance from another repository is refused", async () => {
    await expect(resolvePublishedCommit("1.9.9", [document(SHA_A, "https://github.com/evil/jam"), document(SHA_A), document(SHA_A)])).rejects.toThrow(/names https:\/\/github.com\/evil\/jam/);
  });
  it("a missing provenance attestation is refused", async () => {
    await expect(resolvePublishedCommit("1.9.9", [{ attestations: [] }, document(SHA_A), document(SHA_A)])).rejects.toThrow(/no SLSA provenance/);
  });
  it("a malformed gitCommit is refused", async () => {
    await expect(resolvePublishedCommit("1.9.9", [document("nope"), document("nope"), document("nope")])).rejects.toThrow(/no usable gitCommit/);
  });
});
