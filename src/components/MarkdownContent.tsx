import type { ReactNode } from "react";

interface MarkdownContentProps {
  content: string;
}

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let index = 0;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index));
    const token = match[0];
    if (token.startsWith("**")) {
      nodes.push(<strong key={`${keyPrefix}-${index}`}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("`")) {
      nodes.push(<code key={`${keyPrefix}-${index}`}>{token.slice(1, -1)}</code>);
    } else {
      nodes.push(<em key={`${keyPrefix}-${index}`}>{token.slice(1, -1)}</em>);
    }
    lastIndex = match.index + token.length;
    index += 1;
  }

  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}

function renderBlock(block: string, index: number): ReactNode {
  const lines = block.split("\n");
  const firstLine = lines[0] ?? "";
  const heading = /^(#{1,3})\s+(.+)$/.exec(firstLine);
  if (heading && lines.length === 1) {
    const level = heading[1].length;
    const Heading = `h${level}` as "h1" | "h2" | "h3";
    return <Heading key={`heading-${index}`}>{renderInline(heading[2], `heading-${index}`)}</Heading>;
  }

  if (lines.every((line) => /^\s*[-*]\s+/.test(line))) {
    return (
      <ul key={`list-${index}`}>
        {lines.map((line, itemIndex) => (
          <li key={`list-${index}-${itemIndex}`}>
            {renderInline(line.replace(/^\s*[-*]\s+/, ""), `list-${index}-${itemIndex}`)}
          </li>
        ))}
      </ul>
    );
  }

  return (
    <p key={`paragraph-${index}`}>
      {lines.map((line, lineIndex) => (
        <span key={`line-${index}-${lineIndex}`}>
          {lineIndex > 0 ? <br /> : null}
          {renderInline(line, `paragraph-${index}-${lineIndex}`)}
        </span>
      ))}
    </p>
  );
}

/** A deliberately small, dependency-free Markdown renderer for model output. */
export default function MarkdownContent({ content }: MarkdownContentProps) {
  if (!content.trim()) return <span className="muted">（没有正文）</span>;

  const blocks = content.split(/\n{2,}/);
  const result: ReactNode[] = [];
  let index = 0;

  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
    const block = blocks[blockIndex];
    const fence = /^```([^\n]*)\n([\s\S]*?)```$/.exec(block.trim());
    if (fence) {
      result.push(
        <pre className="code-block" key={`code-${blockIndex}`}>
          <code data-language={fence[1].trim() || undefined}>{fence[2]}</code>
        </pre>,
      );
    } else {
      result.push(renderBlock(block.trim(), index));
    }
    index += 1;
  }

  return <div className="markdown">{result}</div>;
}
