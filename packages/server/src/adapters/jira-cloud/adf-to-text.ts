/**
 * Atlassian Document Format -> plain text.
 *
 * ADF raw JSON is mostly structural tokens the agent has to pay for and then
 * ignore. Normalizing to text is the single biggest payload win in JAM, so
 * nothing downstream of the adapter ever sees an ADF node.
 *
 * Unknown node types are surfaced as `[unsupported: <type>]` rather than
 * dropped - a silently missing paragraph is exactly the failure mode the
 * completeness rules exist to prevent.
 */

type AdfNode = {
  type?: string;
  text?: string;
  content?: AdfNode[];
  attrs?: Record<string, unknown>;
  marks?: { type?: string; attrs?: Record<string, unknown> }[];
};

const KNOWN_LEAF = new Set(["hardBreak", "rule", "emoji", "date", "status", "inlineCard", "mention", "text"]);

export function adfToText(doc: unknown): string {
  if (doc == null) return "";
  if (typeof doc === "string") return doc.trim();
  if (typeof doc !== "object") return String(doc);

  const node = doc as AdfNode;
  const out = renderNode(node, 0).replace(/\n{3,}/g, "\n\n").trim();
  return out;
}

function renderChildren(node: AdfNode, depth: number, sep = ""): string {
  if (!node.content?.length) return "";
  return node.content.map((c) => renderNode(c, depth)).join(sep);
}

function renderNode(node: AdfNode, depth: number): string {
  switch (node.type) {
    case undefined:
    case "doc":
      return renderChildren(node, depth, "\n\n");

    case "text":
      return applyMarks(node.text ?? "", node.marks);

    case "paragraph":
      return renderChildren(node, depth);

    case "heading": {
      const level = Number(node.attrs?.["level"] ?? 1);
      return `${"#".repeat(Math.min(6, Math.max(1, level)))} ${renderChildren(node, depth)}`;
    }

    case "bulletList":
    case "orderedList": {
      const ordered = node.type === "orderedList";
      const items = node.content ?? [];
      return items
        .map((item, i) => {
          const marker = ordered ? `${i + 1}.` : "-";
          const body = renderNode(item, depth + 1).trim();
          const indent = "  ".repeat(depth);
          // keep nested lines aligned under their marker
          return `${indent}${marker} ${body.split("\n").join(`\n${indent}  `)}`;
        })
        .join("\n");
    }

    case "listItem":
      return renderChildren(node, depth, "\n");

    case "taskList":
      return renderChildren(node, depth, "\n");

    case "taskItem": {
      const done = node.attrs?.["state"] === "DONE";
      return `- [${done ? "x" : " "}] ${renderChildren(node, depth)}`;
    }

    case "codeBlock": {
      const lang = typeof node.attrs?.["language"] === "string" ? node.attrs["language"] : "";
      return `\`\`\`${lang}\n${renderChildren(node, depth, "")}\n\`\`\``;
    }

    case "blockquote":
      return renderChildren(node, depth, "\n")
        .split("\n")
        .map((l) => `> ${l}`)
        .join("\n");

    case "panel":
      return renderChildren(node, depth, "\n\n");

    case "rule":
      return "---";

    case "hardBreak":
      return "\n";

    case "mention": {
      // Jira usually stores the "@" in attrs.text already - do not double it.
      const raw = String(node.attrs?.["text"] ?? node.attrs?.["displayName"] ?? "unknown");
      return raw.startsWith("@") ? raw : `@${raw}`;
    }

    case "emoji":
      return String(node.attrs?.["text"] ?? node.attrs?.["shortName"] ?? "");

    case "date":
      return String(node.attrs?.["timestamp"] ?? "");

    case "status":
      return `[${node.attrs?.["text"] ?? ""}]`;

    case "inlineCard":
    case "blockCard":
    case "embedCard":
      return String(node.attrs?.["url"] ?? "[card]");

    case "mediaSingle":
    case "mediaGroup":
    case "media":
      return "[attachment]";

    case "table":
      return (node.content ?? []).map((row) => renderNode(row, depth)).join("\n");

    case "tableRow":
      return `| ${(node.content ?? [])
        .map((cell) => renderNode(cell, depth).replace(/\n+/g, " ").trim())
        .join(" | ")} |`;

    case "tableHeader":
    case "tableCell":
      return renderChildren(node, depth, " ");

    case "expand":
    case "nestedExpand": {
      const title = node.attrs?.["title"];
      const body = renderChildren(node, depth, "\n\n");
      return title ? `${title}\n${body}` : body;
    }

    default: {
      const inner = renderChildren(node, depth, "\n");
      const label = `[unsupported: ${node.type}]`;
      if (!inner && !KNOWN_LEAF.has(node.type ?? "")) return label;
      return inner || label;
    }
  }
}

function applyMarks(text: string, marks: AdfNode["marks"]): string {
  if (!marks?.length) return text;
  let out = text;
  for (const mark of marks) {
    switch (mark.type) {
      case "code":
        out = `\`${out}\``;
        break;
      case "strong":
        out = `**${out}**`;
        break;
      case "em":
        out = `*${out}*`;
        break;
      case "strike":
        out = `~~${out}~~`;
        break;
      case "link": {
        const href = mark.attrs?.["href"];
        if (typeof href === "string" && href && href !== out) out = `[${out}](${href})`;
        break;
      }
      default:
        break;
    }
  }
  return out;
}
