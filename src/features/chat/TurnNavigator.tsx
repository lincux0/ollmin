import { useState } from "react";
import "./reading.css";

export interface TurnNavigatorMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
}

export interface TurnNavigatorProps {
  messages: readonly TurnNavigatorMessage[];
  currentId: string | null;
  onSelect: (id: string) => void;
}

function summary(content: string): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  const characters = Array.from(normalized);
  return characters.length > 10 ? `${characters.slice(0, 10).join("")}……` : normalized || "空消息";
}

/** Navigates only user turns already present in the loaded message list. */
export default function TurnNavigator({ messages, currentId, onSelect }: TurnNavigatorProps) {
  const turns = messages.filter((message) => message.role === "user");
  const [preview, setPreview] = useState("");
  if (turns.length < 2) return null;

  return (
    <nav className="turn-navigator" aria-label="会话回合">
      <div className="turn-navigator-list">
        {turns.map((turn, index) => {
          const text = summary(turn.content);
          return (
            <button
              type="button"
              className="turn-navigator-item"
              key={turn.id}
              aria-label={`第 ${index + 1} 个问题：${text}`}
              aria-current={turn.id === currentId ? "location" : undefined}
              aria-describedby={preview ? "turn-navigator-preview" : undefined}
              title={text}
              onFocus={() => setPreview(text)}
              onBlur={(event) => { if (!event.currentTarget.matches(":hover")) setPreview(""); }}
              onMouseEnter={() => setPreview(text)}
              onMouseLeave={(event) => setPreview(event.currentTarget.parentElement?.querySelector("button:focus")?.getAttribute("title") ?? "")}
              onClick={() => onSelect(turn.id)}
            >
              <span aria-hidden="true" />
            </button>
          );
        })}
      </div>
      {preview ? <span id="turn-navigator-preview" className="turn-navigator-preview" role="tooltip">{preview}</span> : null}
    </nav>
  );
}
