/**
 * Keep a conversation reference when the first chat request fails after the
 * conversation row has already been persisted. Reset only an unpersisted
 * first attempt so the next message cannot fork a duplicate conversation.
 */
export function shouldKeepConversationAfterStartFailure(
  hadConversation: boolean,
  persistedDuringRequest: boolean,
): boolean {
  return hadConversation || persistedDuringRequest;
}
