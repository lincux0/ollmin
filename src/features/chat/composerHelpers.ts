export interface ComposerKeyState {
  key: string;
  shiftKey: boolean;
  isComposing: boolean;
  keyCode: number;
  repeat: boolean;
}

export function shouldSubmitOnEnter(event: ComposerKeyState, composing: boolean): boolean {
  return event.key === "Enter"
    && !event.shiftKey
    && !event.isComposing
    && event.keyCode !== 229
    && !event.repeat
    && !composing;
}

export function composerMaxHeight(windowHeight: number): number {
  return Math.max(120, Math.min(336, windowHeight - 384));
}
