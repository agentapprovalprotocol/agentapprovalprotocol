/**
 * Agent Approval Protocol SDK.
 *
 * Put an agent's tool calls behind an AAP approval provider. `Gate` decides
 * whether one call may run; framework integrations build on it. See
 * https://agentapprovalprotocol.io.
 */

export { AAPError, Client, type ClientOptions, ConflictError, CredentialRefused, type Fetch, NotFound, type Submission } from "./client.js";
export {
  type Allow,
  type Call,
  type CheckOptions,
  type Deny,
  Gate,
  type GateOptions,
  type Guarded,
  type Logger,
  type Mode,
  type Pending,
  type Verdict,
} from "./gate.js";
export { type HeadersInput, Receiver, type ReceiverOptions, type Reply, type Resumer, WebhookError, sign, verify } from "./receiver.js";
export {
  type ApprovalRequest,
  type Consumption,
  type Decision,
  type Json,
  type JsonObject,
  type Outcome,
  type OutcomeStatus,
  ProtocolError,
  type Status,
} from "./wire.js";
