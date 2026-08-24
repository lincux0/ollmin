import type { ChatMessage } from "../types";
import { estimateMessageTokens } from "./performance";

export interface TrimmedHistory {
  messages: ChatMessage[];
  estimatedTokens: number;
  droppedMessages: number;
}
function groupTurns(messages: ChatMessage[]): ChatMessage[][] {
  const turns: ChatMessage[][] = [];
  let current: ChatMessage[] = [];

  for (const message of messages) {
    if (message.role === "user" && current.length > 0) {
      turns.push(current);
      current = [];
    }
    current.push(message);
  }
  if (current.length > 0) turns.push(current);
  return turns;
}

/**
 * Keep system messages and the latest message, then add complete recent turns
 * from newest to oldest. A turn is never split, preventing orphan assistant
 * messages from entering a fast-mode prompt.
 */
export function trimHistoryForFastMode(messages: ChatMessage[], maxTokens: number): TrimmedHistory {
  if (messages.length === 0) {
    return { messages: [], estimatedTokens: 0, droppedMessages: 0 };
  }

  const systemMessages = messages.filter((message) => message.role === "system");
  const conversation = messages.filter((message) => message.role !== "system");
  const latest = conversation.length > 0 ? [conversation[conversation.length - 1]] : [];
  const prior = conversation.slice(0, -1);
  const turns = groupTurns(prior);
  const selectedTurns: ChatMessage[][] = [];
  let estimatedTokens = [...systemMessages, ...latest].reduce(
    (sum, message) => sum + estimateMessageTokens(message),
    0,
  );

  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    const turnTokens = turn.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
    if (estimatedTokens + turnTokens > maxTokens) continue;
    selectedTurns.unshift(turn);
    estimatedTokens += turnTokens;
  }

  const kept = [...systemMessages, ...selectedTurns.flat(), ...latest];
  return {
    messages: kept,
    estimatedTokens,
    droppedMessages: messages.length - kept.length,
  };
}
