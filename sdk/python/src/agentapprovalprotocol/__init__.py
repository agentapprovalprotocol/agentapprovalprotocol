"""Agent Approval Protocol SDK.

Put an agent's tool calls behind an AAP approval provider. ``Gate`` and
``AsyncGate`` decide whether one call may run; framework integrations build
on them. See https://agentapprovalprotocol.io.
"""

from ._client import AAPError, AsyncClient, Client, ConflictError, CredentialRefused, NotFound
from ._gate import Allow, AsyncGate, Call, Deny, Gate, Pending, Verdict
from ._wire import Consumption, Decision, Outcome, ProtocolError, Request
from .receiver import Receiver

__all__ = [
    "AAPError",
    "Allow",
    "AsyncClient",
    "AsyncGate",
    "Call",
    "Client",
    "ConflictError",
    "Consumption",
    "CredentialRefused",
    "Decision",
    "Deny",
    "Gate",
    "NotFound",
    "Outcome",
    "Pending",
    "ProtocolError",
    "Receiver",
    "Request",
    "Verdict",
]
