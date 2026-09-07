export function shouldShowCaption(input: {
  captionsEnabled: boolean;
  chatPanelOpen: boolean;
  speaking: boolean;
  text: string;
}): boolean {
  return input.captionsEnabled
    && !input.chatPanelOpen
    && input.speaking
    && input.text.trim().length > 0;
}
