export function VoiceListeningIndicator() {
  return (
    <div className="voice-listening-indicator" role="status" aria-label="타냐가 듣고 있어요">
      <span className="voice-wave" aria-hidden="true">
        <i /><i /><i /><i /><i />
      </span>
      <span>듣고 있어</span>
    </div>
  );
}
