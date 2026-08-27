/**
 * Plain text to the narrowest Atlassian Document Format that represents it.
 *
 * Jira's rich-text fields - a comment body, an issue description - are document
 * trees. Accepting one from a caller would mean accepting arbitrary structure
 * through a field that reads like "text": panels, mentions, embedded content,
 * links to anywhere. So JAM's contract is plain text in both places, and this
 * is the single conversion that produces the document.
 *
 * Shared rather than duplicated per field on purpose. Two copies of this would
 * be two answers to "what can an agent put in a Jira document", and the second
 * one would drift.
 *
 * Blank lines separate paragraphs; everything else is literal. No markdown is
 * interpreted, so text containing `*` or `#` says what it says.
 */
export function textToAdf(text: string): unknown {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);

  return {
    type: "doc",
    version: 1,
    content: (paragraphs.length > 0 ? paragraphs : [text]).map((block) => ({
      type: "paragraph",
      content: [{ type: "text", text: block }],
    })),
  };
}
