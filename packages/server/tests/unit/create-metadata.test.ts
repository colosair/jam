import { describe, expect, it } from "vitest";
import { JiraCloudCreateMetadataAdapter } from "../../src/adapters/jira-cloud/jira-create-metadata.adapter.js";
import { FakeCredentials } from "../helpers.js";

/**
 * The create schema as Jira actually reports it.
 *
 * Two things are under test here and nothing else: that JAM asks the
 * non-deprecated per-project endpoints, and that a response it cannot fully
 * understand is narrowed rather than guessed at. An entry JAM keeps but has
 * misread is worse than one it drops - the required-field gate will refuse a
 * plan for a required field it cannot see, which is the safe direction.
 */

type Call = { url: string; method: string };

function fakeFetch(bodies: unknown[]): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  let i = 0;
  const impl = (async (url: URL | string, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? "GET" });
    const body = bodies[Math.min(i, bodies.length - 1)];
    i += 1;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetch: impl, calls };
}

describe("JiraCloudCreateMetadataAdapter.getIssueTypes", () => {
  it("asks the per-project issue types endpoint, and maps what it gets", async () => {
    const { fetch, calls } = fakeFetch([
      {
        issueTypes: [
          { id: "10001", name: "Task", subtask: false },
          { id: "10003", name: "Subtask", subtask: true },
        ],
      },
    ]);
    const adapter = new JiraCloudCreateMetadataAdapter(new FakeCredentials(), fetch);

    const types = await adapter.getIssueTypes("PROJECT");

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain("/rest/api/3/issue/createmeta/PROJECT/issuetypes");
    expect(calls[0]!.method).toBe("GET");
    expect(types).toEqual([
      { id: "10001", name: "Task", subtask: false },
      { id: "10003", name: "Subtask", subtask: true },
    ]);
  });

  it("drops an issue type with no id or no name rather than inventing one", async () => {
    const { fetch } = fakeFetch([
      { issueTypes: [{ name: "Nameless id" }, { id: "10004" }, { id: "10005", name: "Story" }] },
    ]);
    const adapter = new JiraCloudCreateMetadataAdapter(new FakeCredentials(), fetch);

    expect(await adapter.getIssueTypes("PROJECT")).toEqual([
      { id: "10005", name: "Story", subtask: false },
    ]);
  });

  it("treats a response with no issue types as no issue types, not a failure", async () => {
    const { fetch } = fakeFetch([{}]);
    const adapter = new JiraCloudCreateMetadataAdapter(new FakeCredentials(), fetch);

    expect(await adapter.getIssueTypes("PROJECT")).toEqual([]);
  });
});

describe("JiraCloudCreateMetadataAdapter.getCreateFields", () => {
  it("asks the per-issue-type fields endpoint, and maps required and default flags", async () => {
    const { fetch, calls } = fakeFetch([
      {
        fields: [
          { fieldId: "summary", name: "Summary", required: true },
          { fieldId: "priority", name: "Priority", required: false, hasDefaultValue: true },
        ],
      },
    ]);
    const adapter = new JiraCloudCreateMetadataAdapter(new FakeCredentials(), fetch);

    const fields = await adapter.getCreateFields("PROJECT", "10001");

    expect(calls[0]!.url).toContain("/rest/api/3/issue/createmeta/PROJECT/issuetypes/10001");
    expect(fields).toEqual([
      { id: "summary", name: "Summary", required: true, hasDefaultValue: false },
      { id: "priority", name: "Priority", required: false, hasDefaultValue: true },
    ]);
  });

  it("accepts `key` where Jira sends it instead of `fieldId`", async () => {
    const { fetch } = fakeFetch([{ fields: [{ key: "customfield_1", name: "Team", required: true }] }]);
    const adapter = new JiraCloudCreateMetadataAdapter(new FakeCredentials(), fetch);

    expect(await adapter.getCreateFields("PROJECT", "10001")).toEqual([
      { id: "customfield_1", name: "Team", required: true, hasDefaultValue: false },
    ]);
  });

  it("drops a field it cannot identify, so nothing is matched against a guess", async () => {
    const { fetch } = fakeFetch([{ fields: [{ name: "No id at all", required: true }] }]);
    const adapter = new JiraCloudCreateMetadataAdapter(new FakeCredentials(), fetch);

    expect(await adapter.getCreateFields("PROJECT", "10001")).toEqual([]);
  });

  it("reads allowed values from `name` and from `value`", async () => {
    const { fetch } = fakeFetch([
      {
        fields: [
          {
            fieldId: "priority",
            name: "Priority",
            allowedValues: [{ id: "1", name: "High" }, { id: "9", value: "Trivial" }, { id: "x" }],
          },
        ],
      },
    ]);
    const adapter = new JiraCloudCreateMetadataAdapter(new FakeCredentials(), fetch);

    const [priority] = await adapter.getCreateFields("PROJECT", "10001");

    expect(priority?.allowedValues).toEqual([
      { id: "1", name: "High" },
      { id: "9", name: "Trivial" },
      { id: "x" },
    ]);
  });

  it("keeps an unconstrained field distinct from one constrained to nothing", async () => {
    // Absent means Jira did not constrain the field; empty means it constrains
    // it and offers nothing. The first permits any value, the second permits
    // none, so collapsing them would either refuse valid input or accept
    // input Jira will reject.
    const { fetch } = fakeFetch([
      {
        fields: [
          { fieldId: "summary", name: "Summary" },
          { fieldId: "components", name: "Components", allowedValues: [] },
        ],
      },
    ]);
    const adapter = new JiraCloudCreateMetadataAdapter(new FakeCredentials(), fetch);

    const fields = await adapter.getCreateFields("PROJECT", "10001");

    expect(fields[0]).not.toHaveProperty("allowedValues");
    expect(fields[1]?.allowedValues).toEqual([]);
  });
});
