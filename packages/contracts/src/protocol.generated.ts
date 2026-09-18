/* Generated from schema/protocol.v1.json. Edit the schema, then npm run generate. */

export type ExecutionReceipt = SucceededReceipt | FailedReceipt | UnknownReceipt;
export type RoutingReason =
  "automatic_budget" | "request_fixed" | "conversation_fixed" | "saved_default" | "initial_local";
export type ProtocolMessage =
  | SessionReadyMessage
  | InputFinishedMessage
  | InputTranscriptMessage
  | TurnStartMessage
  | ResponseDeltaMessage
  | ResponseCompletedMessage
  | SpeechRequestMessage
  | SpeechChunkMessage
  | SpeechFinishedMessage
  | PlaybackStateMessage
  | TurnCancelMessage
  | TurnEndedMessage
  | SessionClosedMessage
  | ModelDefaultChangedMessage
  | ActionDraftMessage
  | ActionApproveMessage
  | ActionReceiptMessage
  | ContextInvalidatedMessage
  | ToolContextMessage
  | ToolOffersMessage
  | ToolProposedMessage
  | ToolResolvedMessage;

export interface ContractTypes {
  Identity?: Identity;
  Scope?: Scope;
  ModelRef?: ModelRef;
  ModelSelection?: ModelSelection;
  Endpoint?: Endpoint;
  SourceRef?: SourceRef;
  SourceRecord?: SourceRecord;
  ContextItem?: ContextItem;
  ActionPayload?: ActionPayload;
  ActionDraft?: ActionDraft;
  Approval?: Approval;
  ExecutionReceipt?: ExecutionReceipt;
  SessionReadyMessage?: SessionReadyMessage;
  InputFinishedMessage?: InputFinishedMessage;
  InputTranscriptMessage?: InputTranscriptMessage;
  TurnStartMessage?: TurnStartMessage;
  ResponseDeltaMessage?: ResponseDeltaMessage;
  ResponseCompletedMessage?: ResponseCompletedMessage;
  SpeechRequestMessage?: SpeechRequestMessage;
  SpeechChunkMessage?: SpeechChunkMessage;
  PlaybackStateMessage?: PlaybackStateMessage;
  TurnCancelMessage?: TurnCancelMessage;
  TurnEndedMessage?: TurnEndedMessage;
  SessionClosedMessage?: SessionClosedMessage;
  ModelDefault_changedMessage?: ModelDefaultChangedMessage;
  ActionDraftMessage?: ActionDraftMessage;
  ActionApproveMessage?: ActionApproveMessage;
  ActionReceiptMessage?: ActionReceiptMessage;
  ContextInvalidatedMessage?: ContextInvalidatedMessage;
  SpeechFinishedMessage?: SpeechFinishedMessage;
  RoutingReason?: RoutingReason;
  ToolOffer?: ToolOffer;
  ToolContextMessage?: ToolContextMessage;
  ToolOffersMessage?: ToolOffersMessage;
  ToolProposedMessage?: ToolProposedMessage;
  ToolResolvedMessage?: ToolResolvedMessage;
  ProtocolMessage?: ProtocolMessage;
}
export interface Identity {
  instance_id: string;
  mode: "personal" | "public_demo";
  principal_id: string;
}
export interface Scope {
  instance_id: string;
  mode: "personal" | "public_demo";
  principal_id: string;
  session_id: string;
  connection_id: string;
  connection_epoch: number;
}
export interface ModelRef {
  provider_id: string;
  model_id: string;
  endpoint_id: string;
}
export interface ModelSelection {
  model: ModelRef;
  source: "request" | "conversation" | "saved_default" | "initial_local";
}
export interface Endpoint {
  endpoint_id: string;
  provider_id: string;
  boundary: "local" | "private_lan" | "cloud";
  approved: boolean;
}
export interface SourceRef {
  source_id: string;
  revision: number;
}
export interface SourceRecord {
  source_id: string;
  revision: number;
  identity: Identity;
  kind: "screen" | "note" | "calendar" | "conversation" | "memory" | "index" | "tool_result";
  boundary: "local" | "private_lan" | "cloud";
  deleted: boolean;
  /**
   * @maxItems 128
   */
  parents: SourceRef[];
}
export interface ContextItem {
  source_id: string;
  revision: number;
  text: string;
}
export interface ActionPayload {
  tool_id: string;
  operation: string;
  account_id: string;
  target: string;
  arguments_json: string;
}
export interface ActionDraft {
  draft_id: string;
  revision: number;
  identity: Identity;
  executor_id: string;
  action: ActionPayload;
  payload_sha256: string;
  expires_at_ms: number;
}
export interface Approval {
  approval_id: string;
  draft_id: string;
  draft_revision: number;
  identity: Identity;
  executor_id: string;
  payload_sha256: string;
  execution_id: string;
  expires_at_ms: number;
}
export interface SucceededReceipt {
  execution_id: string;
  draft_id: string;
  draft_revision: number;
  identity: Identity;
  executor_id: string;
  payload_sha256: string;
  status: "succeeded";
  provider_id: string;
  provider_operation_id: string;
  error_code: null;
  recorded_at_ms: number;
}
export interface FailedReceipt {
  execution_id: string;
  draft_id: string;
  draft_revision: number;
  identity: Identity;
  executor_id: string;
  payload_sha256: string;
  status: "failed";
  provider_id: string;
  provider_operation_id: string | null;
  error_code: string | null;
  recorded_at_ms: number;
}
export interface UnknownReceipt {
  execution_id: string;
  draft_id: string;
  draft_revision: number;
  identity: Identity;
  executor_id: string;
  payload_sha256: string;
  status: "unknown";
  provider_id: string;
  provider_operation_id: string | null;
  error_code: string | null;
  recorded_at_ms: number;
}
export interface SessionReadyMessage {
  protocol: "kirian.rearchitecture.v1";
  message_id: string;
  request_id: string;
  scope: Scope;
  kind: "session.ready";
  turn_id: null;
  intent_id: null;
  sequence: number;
  payload: SessionReadyPayload;
}
export interface SessionReadyPayload {
  client_kind: "electron" | "web" | "android";
  resume: "new_session" | "turns_cancelled";
  /**
   * @maxItems 5
   */
  capabilities:
    | []
    | ["text" | "audio_input" | "audio_output" | "screen" | "local_actions"]
    | [
        "text" | "audio_input" | "audio_output" | "screen" | "local_actions",
        "text" | "audio_input" | "audio_output" | "screen" | "local_actions"
      ]
    | [
        "text" | "audio_input" | "audio_output" | "screen" | "local_actions",
        "text" | "audio_input" | "audio_output" | "screen" | "local_actions",
        "text" | "audio_input" | "audio_output" | "screen" | "local_actions"
      ]
    | [
        "text" | "audio_input" | "audio_output" | "screen" | "local_actions",
        "text" | "audio_input" | "audio_output" | "screen" | "local_actions",
        "text" | "audio_input" | "audio_output" | "screen" | "local_actions",
        "text" | "audio_input" | "audio_output" | "screen" | "local_actions"
      ]
    | [
        "text" | "audio_input" | "audio_output" | "screen" | "local_actions",
        "text" | "audio_input" | "audio_output" | "screen" | "local_actions",
        "text" | "audio_input" | "audio_output" | "screen" | "local_actions",
        "text" | "audio_input" | "audio_output" | "screen" | "local_actions",
        "text" | "audio_input" | "audio_output" | "screen" | "local_actions"
      ];
}
export interface InputFinishedMessage {
  protocol: "kirian.rearchitecture.v1";
  message_id: string;
  request_id: string;
  scope: Scope;
  kind: "input.finished";
  turn_id: string;
  intent_id: string;
  sequence: number;
  payload: InputFinishedPayload;
}
export interface InputFinishedPayload {
  input_id: string;
  kind: "text" | "audio";
  text: string;
}
export interface InputTranscriptMessage {
  protocol: "kirian.rearchitecture.v1";
  message_id: string;
  request_id: string;
  scope: Scope;
  kind: "input.transcript";
  turn_id: string;
  intent_id: string;
  sequence: number;
  payload: TranscriptPayload;
}
export interface TranscriptPayload {
  input_id: string;
  text: string;
  final: boolean;
}
export interface TurnStartMessage {
  protocol: "kirian.rearchitecture.v1";
  message_id: string;
  request_id: string;
  scope: Scope;
  kind: "turn.start";
  turn_id: string;
  intent_id: string;
  sequence: number;
  payload: TurnStartPayload;
}
export interface TurnStartPayload {
  selection: ModelSelection;
  /**
   * @maxItems 128
   */
  context: ContextItem[];
  /**
   * Client will close sentence submission with speech.finished; omission is false for legacy clients.
   */
  speech?: boolean;
  /**
   * @minItems 1
   * @maxItems 32
   */
  routing_candidates?: [ModelRef, ...ModelRef[]];
  /**
   * Host opt-in for this turn; omission is OFF. Tool offers confer no execution authority.
   */
  external_tools?: boolean;
}
export interface ResponseDeltaMessage {
  protocol: "kirian.rearchitecture.v1";
  message_id: string;
  request_id: string;
  scope: Scope;
  kind: "response.delta";
  turn_id: string;
  intent_id: string;
  sequence: number;
  payload: ResponseDeltaPayload;
}
export interface ResponseDeltaPayload {
  text: string;
  actual_model: ModelRef;
  routing_reason?: RoutingReason;
}
export interface ResponseCompletedMessage {
  protocol: "kirian.rearchitecture.v1";
  message_id: string;
  request_id: string;
  scope: Scope;
  kind: "response.completed";
  turn_id: string;
  intent_id: string;
  sequence: number;
  payload: ResponseCompletedPayload;
}
export interface ResponseCompletedPayload {
  actual_model: ModelRef;
  routing_reason?: RoutingReason;
}
export interface SpeechRequestMessage {
  protocol: "kirian.rearchitecture.v1";
  message_id: string;
  request_id: string;
  scope: Scope;
  kind: "speech.request";
  turn_id: string;
  intent_id: string;
  sequence: number;
  payload: SpeechRequestPayload;
}
export interface SpeechRequestPayload {
  sentence_id: string;
  sentence_index: number;
  text: string;
  model: ModelRef;
}
export interface SpeechChunkMessage {
  protocol: "kirian.rearchitecture.v1";
  message_id: string;
  request_id: string;
  scope: Scope;
  kind: "speech.chunk";
  turn_id: string;
  intent_id: string;
  sequence: number;
  payload: SpeechChunkPayload;
}
export interface SpeechChunkPayload {
  sentence_id: string;
  sentence_index: number;
  codec: "pcm_s16le" | "wav" | "mp3";
  sample_rate_hz: number;
  audio_base64: string;
  final: boolean;
}
export interface PlaybackStateMessage {
  protocol: "kirian.rearchitecture.v1";
  message_id: string;
  request_id: string;
  scope: Scope;
  kind: "playback.state";
  turn_id: string;
  intent_id: string;
  sequence: number;
  payload: PlaybackStatePayload;
}
export interface PlaybackStatePayload {
  sentence_id: string;
  state: "queued" | "playing" | "completed" | "cancelled" | "failed";
}
export interface TurnCancelMessage {
  protocol: "kirian.rearchitecture.v1";
  message_id: string;
  request_id: string;
  scope: Scope;
  kind: "turn.cancel";
  turn_id: string;
  intent_id: string;
  sequence: number;
  payload: TurnCancelPayload;
}
export interface TurnCancelPayload {
  reason: "user" | "barge_in" | "superseded" | "disconnect" | "shutdown";
}
export interface TurnEndedMessage {
  protocol: "kirian.rearchitecture.v1";
  message_id: string;
  request_id: string;
  scope: Scope;
  kind: "turn.ended";
  turn_id: string;
  intent_id: string;
  sequence: number;
  payload: TurnEndedPayload;
}
export interface TurnEndedPayload {
  status: "completed" | "cancelled" | "failed";
  error_code?:
    | "provider_unavailable"
    | "provider_error"
    | "model_mismatch"
    | "incomplete_response"
    | "empty_response"
    | "response_limit"
    | "model_not_allowed"
    | "context_blocked"
    | "invalid_request"
    | "session_limit"
    | "turn_timeout"
    | "speech_unavailable"
    | "speech_error"
    | "playback_failed"
    | "source_changed"
    | "storage_unavailable"
    | "unsupported_model"
    | "routing_changed"
    | "routing_limit"
    | "routing_no_candidate"
    | "routing_duplicate_call"
    | "persistence_unavailable";
}
export interface SessionClosedMessage {
  protocol: "kirian.rearchitecture.v1";
  message_id: string;
  request_id: string;
  scope: Scope;
  kind: "session.closed";
  turn_id: null;
  intent_id: null;
  sequence: number;
  payload: SessionClosedPayload;
}
export interface SessionClosedPayload {
  reason: "disconnect" | "shutdown" | "expired";
}
export interface ModelDefaultChangedMessage {
  protocol: "kirian.rearchitecture.v1";
  message_id: string;
  request_id: string;
  scope: Scope;
  kind: "model.default_changed";
  turn_id: null;
  intent_id: null;
  sequence: number;
  payload: ModelDefaultChangedPayload;
}
export interface ModelDefaultChangedPayload {
  model: ModelRef;
  revision: number;
}
export interface ActionDraftMessage {
  protocol: "kirian.rearchitecture.v1";
  message_id: string;
  request_id: string;
  scope: Scope;
  kind: "action.draft";
  turn_id: string;
  intent_id: string;
  sequence: number;
  payload: ActionDraftPayload;
}
export interface ActionDraftPayload {
  draft: ActionDraft;
}
export interface ActionApproveMessage {
  protocol: "kirian.rearchitecture.v1";
  message_id: string;
  request_id: string;
  scope: Scope;
  kind: "action.approve";
  turn_id: string;
  intent_id: string;
  sequence: number;
  payload: ActionApprovePayload;
}
export interface ActionApprovePayload {
  approval: Approval;
}
export interface ActionReceiptMessage {
  protocol: "kirian.rearchitecture.v1";
  message_id: string;
  request_id: string;
  scope: Scope;
  kind: "action.receipt";
  turn_id: null;
  intent_id: null;
  sequence: number;
  payload: ActionReceiptPayload;
}
export interface ActionReceiptPayload {
  receipt: ExecutionReceipt;
}
export interface ContextInvalidatedMessage {
  protocol: "kirian.rearchitecture.v1";
  message_id: string;
  request_id: string;
  scope: Scope;
  kind: "context.invalidated";
  turn_id: null;
  intent_id: null;
  sequence: number;
  payload: ContextInvalidatedPayload;
}
export interface ContextInvalidatedPayload {
  source_id: string;
  revision: number;
  reason: "updated" | "deleted";
}
export interface SpeechFinishedMessage {
  protocol: "kirian.rearchitecture.v1";
  message_id: string;
  request_id: string;
  scope: Scope;
  kind: "speech.finished";
  turn_id: string;
  intent_id: string;
  sequence: 0;
  payload: SpeechFinishedPayload;
}
export interface SpeechFinishedPayload {
  sentence_count: number;
}
export interface ToolOffer {
  offer_id: string;
  display_name: string;
  description: string;
  input_schema_json: string;
  provider_kind?: "mcp" | "google_calendar";
}
export interface ToolContextMessage {
  protocol: "kirian.rearchitecture.v1";
  message_id: string;
  request_id: string;
  scope: Scope;
  kind: "tool.context";
  turn_id: string;
  intent_id: string;
  sequence: number;
  payload: ToolContextPayload;
}
export interface ToolContextPayload {
  context_id: string;
}
export interface ToolOffersMessage {
  protocol: "kirian.rearchitecture.v1";
  message_id: string;
  request_id: string;
  scope: Scope;
  kind: "tool.offers";
  turn_id: string;
  intent_id: string;
  sequence: number;
  payload: ToolOffersPayload;
}
export interface ToolOffersPayload {
  context_id: string;
  /**
   * @maxItems 16
   */
  offers:
    | []
    | [ToolOffer]
    | [ToolOffer, ToolOffer]
    | [ToolOffer, ToolOffer, ToolOffer]
    | [ToolOffer, ToolOffer, ToolOffer, ToolOffer]
    | [ToolOffer, ToolOffer, ToolOffer, ToolOffer, ToolOffer]
    | [ToolOffer, ToolOffer, ToolOffer, ToolOffer, ToolOffer, ToolOffer]
    | [ToolOffer, ToolOffer, ToolOffer, ToolOffer, ToolOffer, ToolOffer, ToolOffer]
    | [ToolOffer, ToolOffer, ToolOffer, ToolOffer, ToolOffer, ToolOffer, ToolOffer, ToolOffer]
    | [ToolOffer, ToolOffer, ToolOffer, ToolOffer, ToolOffer, ToolOffer, ToolOffer, ToolOffer, ToolOffer]
    | [ToolOffer, ToolOffer, ToolOffer, ToolOffer, ToolOffer, ToolOffer, ToolOffer, ToolOffer, ToolOffer, ToolOffer]
    | [
        ToolOffer,
        ToolOffer,
        ToolOffer,
        ToolOffer,
        ToolOffer,
        ToolOffer,
        ToolOffer,
        ToolOffer,
        ToolOffer,
        ToolOffer,
        ToolOffer
      ]
    | [
        ToolOffer,
        ToolOffer,
        ToolOffer,
        ToolOffer,
        ToolOffer,
        ToolOffer,
        ToolOffer,
        ToolOffer,
        ToolOffer,
        ToolOffer,
        ToolOffer,
        ToolOffer
      ]
    | [
        ToolOffer,
        ToolOffer,
        ToolOffer,
        ToolOffer,
        ToolOffer,
        ToolOffer,
        ToolOffer,
        ToolOffer,
        ToolOffer,
        ToolOffer,
        ToolOffer,
        ToolOffer,
        ToolOffer
      ]
    | [
        ToolOffer,
        ToolOffer,
        ToolOffer,
        ToolOffer,
        ToolOffer,
        ToolOffer,
        ToolOffer,
        ToolOffer,
        ToolOffer,
        ToolOffer,
        ToolOffer,
        ToolOffer,
        ToolOffer,
        ToolOffer
      ]
    | [
        ToolOffer,
        ToolOffer,
        ToolOffer,
        ToolOffer,
        ToolOffer,
        ToolOffer,
        ToolOffer,
        ToolOffer,
        ToolOffer,
        ToolOffer,
        ToolOffer,
        ToolOffer,
        ToolOffer,
        ToolOffer,
        ToolOffer
      ]
    | [
        ToolOffer,
        ToolOffer,
        ToolOffer,
        ToolOffer,
        ToolOffer,
        ToolOffer,
        ToolOffer,
        ToolOffer,
        ToolOffer,
        ToolOffer,
        ToolOffer,
        ToolOffer,
        ToolOffer,
        ToolOffer,
        ToolOffer,
        ToolOffer
      ];
}
export interface ToolProposedMessage {
  protocol: "kirian.rearchitecture.v1";
  message_id: string;
  request_id: string;
  scope: Scope;
  kind: "tool.proposed";
  turn_id: string;
  intent_id: string;
  sequence: number;
  payload: ToolProposedPayload;
}
export interface ToolProposedPayload {
  provider_kind: "mcp" | "google_calendar";
  proposal_id: string;
  offer_id: string;
  arguments_json: string;
  actual_model: ModelRef;
  routing_reason?: RoutingReason;
  /**
   * @maxItems 128
   */
  source_refs: SourceRef[];
}
export interface ToolResolvedMessage {
  protocol: "kirian.rearchitecture.v1";
  message_id: string;
  request_id: string;
  scope: Scope;
  kind: "tool.resolved";
  turn_id: string;
  intent_id: string;
  sequence: number;
  payload: ToolResolvedPayload;
}
export interface ToolResolvedPayload {
  proposal_id: string;
  state: "succeeded" | "failed" | "unknown" | "unavailable";
  source_ref?: SourceRef;
}
