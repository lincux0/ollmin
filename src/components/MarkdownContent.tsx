import { memo, type ReactNode } from "react";

export interface MarkdownContentProps {
  content: string;
  copiedId?: string | null;
  onCopy?: (id: string, content: string) => void | Promise<void>;
}

export function areMarkdownContentPropsEqual(
  previous: MarkdownContentProps,
  next: MarkdownContentProps,
): boolean {
  return previous.content === next.content && previous.copiedId === next.copiedId && previous.onCopy === next.onCopy;
}

const LIST_ITEM_PATTERN = /^(\s*)([-+*]|\d+[.)])\s+(.+?)\s*$/;
const HEADING_PATTERN = /^ {0,3}(#{1,6})(?:[ \t]+(.*)|[ \t]*)$/;
const HORIZONTAL_RULE_PATTERN = /^ {0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/;
const FENCE_PATTERN = /^\s*(`{3,}|~{3,})/;

function leadingIndent(line: string): number {
  return (line.match(/^\s*/) ?? [""])[0].replace(/\t/g, "    ").length;
}

function listItem(line: string): { indent: number; marker: string; text: string } | null {
  const match = LIST_ITEM_PATTERN.exec(line);
  if (!match) return null;
  return {
    indent: match[1].replace(/\t/g, "    ").length,
    marker: match[2],
    text: match[3],
  };
}

function isOrderedMarker(marker: string): boolean {
  return /^\d/.test(marker);
}

function safeHref(href: string): string | null {
  const trimmed = href.trim();
  if (/^(?:https?:\/\/|mailto:|#)/i.test(trimmed)) return trimmed;
  return null;
}

/**
 * Render the small inline Markdown subset that is useful for chat answers.
 * Inline code and dollar-delimited expressions remain literal React text;
 * Ollmin does not execute code or typeset formulas.
 */
function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern =
    /(\[[^\]\n]+\]\([^)\s]+\)|`[^`\n]*`|\$\$[^$\n]*\$\$|\$[^$\n]+\$|\*\*\*(?=\S)([\s\S]*?\S)\*\*\*|\*\*(?=\S)([\s\S]*?\S)\*\*|__(?=\S)([\s\S]*?\S)__|~~(?=\S)([\s\S]*?\S)~~|\*(?=\S)([^*\n]*?\S)\*|(?<!\w)_(?=\S)([^_\n]*?\S)_(?!\w))/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let index = 0;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index));
    const token = match[0];
    const key = `${keyPrefix}-${index}`;

    if (token.startsWith("[") && token.endsWith(")")) {
      const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token);
      const href = link ? safeHref(link[2]) : null;
      if (link && href) {
        nodes.push(
          <a key={key} href={href} rel="noreferrer">
            {renderInline(link[1], `${key}-label`)}
          </a>,
        );
      } else {
        nodes.push(token);
      }
    } else if (token.startsWith("`")) {
      const code = token.slice(1, -1);
      nodes.push(<code key={key} className="inline-code">{code}</code>);
    } else if (token.startsWith("$")) {
      // Formula syntax remains literal; Ollmin does not typeset math.
      nodes.push(token);
    } else if (token.startsWith("***")) {
      nodes.push(
        <strong key={key}>
          <em>{renderInline(token.slice(3, -3), `${key}-em`)}</em>
        </strong>,
      );
    } else if (token.startsWith("**") || token.startsWith("__")) {
      nodes.push(<strong key={key}>{renderInline(token.slice(2, -2), key)}</strong>);
    } else if (token.startsWith("~~")) {
      nodes.push(<del key={key}>{renderInline(token.slice(2, -2), key)}</del>);
    } else {
      nodes.push(<em key={key}>{renderInline(token.slice(1, -1), key)}</em>);
    }

    lastIndex = match.index + token.length;
    index += 1;
  }

  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}

function renderParagraph(lines: string[], key: string): ReactNode {
  return (
    <p key={key}>
      {lines.map((line, lineIndex) => (
        <span key={`${key}-line-${lineIndex}`}>
          {lineIndex > 0 ? <br /> : null}
          {renderInline(line, `${key}-line-${lineIndex}`)}
        </span>
      ))}
    </p>
  );
}

interface ParsedListItem {
  textLines: string[];
  children: ReactNode[];
}

interface ParsedList {
  node: ReactNode;
  nextIndex: number;
}

function parseList(
  lines: string[],
  startIndex: number,
  baseIndent: number,
  ordered: boolean,
  key: string,
): ParsedList {
  const items: ParsedListItem[] = [];
  let index = startIndex;

  while (index < lines.length) {
    const current = listItem(lines[index]);
    if (!current || current.indent < baseIndent) break;
    if (current.indent > baseIndent) {
      if (items.length === 0) break;
      const nestedList = parseList(
        lines,
        index,
        current.indent,
        isOrderedMarker(current.marker),
        `${key}-nested-${items.length}`,
      );
      items[items.length - 1].children.push(nestedList.node);
      index = nestedList.nextIndex;
      continue;
    }
    if (isOrderedMarker(current.marker) !== ordered) break;

    const item: ParsedListItem = { textLines: [current.text], children: [] };
    items.push(item);
    index += 1;

    while (index < lines.length) {
      if (lines[index].trim() === "") {
        // CommonMark allows blank lines between items in the same list. Keep
        // the list open when the next non-empty line has the same level and
        // marker kind; otherwise let the outer block parser handle it.
        let lookahead = index;
        while (lookahead < lines.length && lines[lookahead].trim() === "") {
          lookahead += 1;
        }
        const nextAfterBlank =
          lookahead < lines.length ? listItem(lines[lookahead]) : null;
        if (
          nextAfterBlank &&
          nextAfterBlank.indent === baseIndent &&
          isOrderedMarker(nextAfterBlank.marker) === ordered
        ) {
          index = lookahead;
        }
        break;
      }
      const nextItem = listItem(lines[index]);
      if (nextItem) {
        if (nextItem.indent <= baseIndent) break;
        const nestedList = parseList(
          lines,
          index,
          nextItem.indent,
          isOrderedMarker(nextItem.marker),
          `${key}-nested-${items.length - 1}`,
        );
        item.children.push(nestedList.node);
        index = nestedList.nextIndex;
        continue;
      }

      if (leadingIndent(lines[index]) > baseIndent) {
        item.textLines.push(lines[index].trim());
        index += 1;
        continue;
      }
      break;
    }
  }

  const List = ordered ? "ol" : "ul";
  return {
    node: (
      <List key={key}>
        {items.map((item, itemIndex) => (
          <li key={`${key}-item-${itemIndex}`}>
            {item.textLines.map((line, lineIndex) => (
              <span key={`${key}-item-${itemIndex}-line-${lineIndex}`}>
                {lineIndex > 0 ? <br /> : null}
                {renderInline(line, `${key}-item-${itemIndex}-line-${lineIndex}`)}
              </span>
            ))}
            {item.children}
          </li>
        ))}
      </List>
    ),
    nextIndex: index,
  };
}

function isBlockStart(line: string): boolean {
  return (
    HEADING_PATTERN.test(line) ||
    HORIZONTAL_RULE_PATTERN.test(line) ||
    /^\s*>/.test(line) ||
    listItem(line) !== null ||
    FENCE_PATTERN.test(line)
  );
}

function renderBlocks(
  source: string,
  keyPrefix = "block",
  onCopy?: MarkdownContentProps["onCopy"],
  copiedId?: string | null,
): ReactNode[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const nodes: ReactNode[] = [];
  let index = 0;
  let blockIndex = 0;

  while (index < lines.length) {
    if (lines[index].trim() === "") {
      index += 1;
      continue;
    }

    const key = `${keyPrefix}-${blockIndex}`;
    const line = lines[index];
    const fence = FENCE_PATTERN.exec(line);
    if (fence) {
      const fenceLength = fence[1].length;
      const fenceChar = fence[1][0];
      const language = line.slice(fence[0].length).trim().split(/\s+/, 1)[0] ?? "";
      const codeLines: string[] = [];
      index += 1;
      const closer = new RegExp(`^\\s*${fenceChar}{${fenceLength},}\\s*$`);
      while (index < lines.length && !closer.test(lines[index])) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      const code = codeLines.join("\n");
      nodes.push(
        <pre className="code-block" key={key}>
          <div className="code-block-header">
            <span>{language || "代码"}</span>
            {onCopy ? (
              <button
                type="button"
                className="code-copy-button"
                aria-label={copiedId === key ? "已复制代码" : "复制代码"}
                onClick={() => void onCopy(key, code)}
              >
                {copiedId === key ? "已复制" : "复制"}
              </button>
            ) : null}
          </div>
          <code className={language ? `language-${language}` : undefined}>{code}</code>
        </pre>,
      );
      blockIndex += 1;
      continue;
    }

    const heading = HEADING_PATTERN.exec(line);
    if (heading) {
      const level = heading[1].length;
      const headingText = (heading[2] ?? "").replace(/\s+#+\s*$/, "").trim();
      const Heading = `h${level}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
      nodes.push(<Heading key={key}>{renderInline(headingText, `${key}-heading`)}</Heading>);
      index += 1;
      blockIndex += 1;
      continue;
    }

    if (HORIZONTAL_RULE_PATTERN.test(line)) {
      nodes.push(<hr key={key} />);
      index += 1;
      blockIndex += 1;
      continue;
    }

    if (/^\s*>/.test(line)) {
      const quoteLines: string[] = [];
      while (index < lines.length && /^\s*>/.test(lines[index])) {
        quoteLines.push(lines[index].replace(/^\s*>\s?/, ""));
        index += 1;
      }
      nodes.push(<blockquote key={key}>{renderBlocks(quoteLines.join("\n"), `${key}-quote`, onCopy, copiedId)}</blockquote>);
      blockIndex += 1;
      continue;
    }

    const firstListItem = listItem(line);
    if (firstListItem) {
      const parsedList = parseList(
        lines,
        index,
        firstListItem.indent,
        isOrderedMarker(firstListItem.marker),
        key,
      );
      nodes.push(parsedList.node);
      index = parsedList.nextIndex;
      blockIndex += 1;
      continue;
    }

    const paragraphLines = [line];
    index += 1;
    while (
      index < lines.length &&
      lines[index].trim() !== "" &&
      !isBlockStart(lines[index])
    ) {
      paragraphLines.push(lines[index]);
      index += 1;
    }
    nodes.push(renderParagraph(paragraphLines, key));
    blockIndex += 1;
  }

  return nodes;
}

/** A deliberately small, dependency-free Markdown renderer for model output. */
function MarkdownContent({ content, copiedId, onCopy }: MarkdownContentProps) {
  if (!content.trim()) return <span className="muted">（没有正文）</span>;
  return <div className="markdown">{renderBlocks(content, "block", onCopy, copiedId)}</div>;
}

export default memo(MarkdownContent, areMarkdownContentPropsEqual);
