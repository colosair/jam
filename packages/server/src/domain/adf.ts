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
  const paragraphs = toParagraphs(text);

  return {
    type: "doc",
    version: 1,
    content: (paragraphs.length > 0 ? paragraphs : [text]).map((block) => ({
      type: "paragraph",
      content: [{ type: "text", text: block }],
    })),
  };
}

/**
 * The text as it will exist once Jira has it.
 *
 * A write is only verified if what a direct read shows can be compared to what
 * was asked for - and for a rich-text field those two are never byte-identical.
 * The caller's string becomes a document, Jira stores the document, and reading
 * it back renders a document into text again. Blank-line runs collapse, block
 * edges lose their whitespace, a trailing newline disappears.
 *
 * None of that changes what the description says, so comparing raw strings
 * would fail every time. Comparing canonical forms fails only when the text
 * actually differs.
 *
 * Deliberately the same normalization `textToAdf` performs, from the same
 * place: "what JAM sends" and "what JAM will accept as proof it arrived" must
 * not be able to drift into two answers.
 */
export function canonicalizePlainText(text: string): string {
  return toParagraphs(text).join("\n\n");
}

/**
 * Blank lines separate paragraphs; everything else is literal.
 *
 * A single newline inside a block survives - it is a line break the author
 * wrote, and ADF round-trips it - so only the edges of each block are trimmed.
 */
function toParagraphs(text: string): string[] {
  return (
    text
      // Line endings first. A CRLF document would otherwise carry a stray \r
      // at the end of every block into ADF, and Jira renders it back as LF -
      // so a create that was correct would fail verification, on nothing more
      // than which editor the caller used. Worse, `\r\n\r\n` and `\n\n` would
      // split into paragraphs differently.
      .replace(/\r\n?/g, "\n")
      .split(/\n{2,}/)
      .map((block) => block.trim())
      .filter(Boolean)
  );
}
