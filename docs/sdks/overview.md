---
lastModified: 2026-10-12
---

# SDKs overview

Use the AAP SDKs to put an agent you build in code behind your [approval provider](../providers/overview.md). They do the adapter's job inside your own application.

## Choose your framework

| Framework | Language |
| --- | --- |
| [LangGraph and Deep Agents](langgraph.md) | Python |
| [Pydantic AI](pydantic-ai.md) | Python |
| [Google ADK](adk.md) | Python |
| [OpenAI Agents SDK](openai-agents.md) | Python |
| [Claude Agent SDK](claude-agent-sdk.md) | Python |
| [CrewAI](crewai.md) | Python |
| [Vercel AI SDK](ai-sdk.md) | TypeScript |
| [Mastra](mastra.md) | TypeScript |

For another framework, [check each tool call yourself](#check-a-tool-call) with the core SDK.

## Install

Each framework guide has its own install command. To install the core SDK for Python 3.10 or later:

```sh
pip install agentapprovalprotocol
```

For TypeScript on Node.js 20 or later:

```sh
npm install @agentapprovalprotocol/sdk
```

You will need an instance token and an AAP URL from your provider. Keep the token on your server, out of tool arguments and logs.

## What to expect

- Every tool call goes to your provider before it runs.
- A call runs only if it is approved, and at most once. A call seen again after a retry or resume does not run a second time.
- A denied call does not run. The model receives the reason as the tool's result and can carry on.
- If the provider cannot be reached or the decision cannot be confirmed, the call is denied.
- After an approved call runs, the SDK reports to the provider whether it succeeded.

Your agent's own permissions and other paths to the same services still apply. See [adapter coverage and limits](../concepts/adapter.md#where-the-adapter-runs).

## Wait or pause

Each call either waits for its decision or pauses the run. Choose with the `mode` option.

| Mode | What happens | Use it when |
| --- | --- | --- |
| Wait (`sync`, the default) | The call waits while the run stays open. | Decisions arrive within minutes and your process keeps running. |
| Pause (`async`) | The run stops at the call and saves its state, so your process can respond or exit. A [receiver](#resume-paused-runs) resumes the run when the decision arrives. | Reviews can take hours, or runs are served by short-lived processes such as web requests or serverless functions. |

A waiting call gives up after 9 minutes by default. It is then cancelled and denied. Change this with `wait_limit` in Python or `waitLimit` in TypeScript, in seconds.

A paused call can wait 24 hours for a decision by default. Change this with `timeout`, for example `"72h"`. Your provider may set a shorter deadline.

Some calls cannot pause, such as calls inside sub-agents. Those calls wait even in pause mode. Each framework guide lists them.

## Check a tool call

Use the gate directly when there is no integration for your framework. Give each call a `key` that identifies it within its run and stays the same if the call is seen again after a retry or resume.

```python
import os
from agentapprovalprotocol import Call, Client, Gate

gate = Gate(Client("https://approvals.example.com/api/aap", os.environ["AAP_INSTANCE_TOKEN"]))

def run_tool_call(run_id, tool_call):
    call = Call(key=f"{run_id}:{tool_call.id}", tool=tool_call.name, arguments=tool_call.args)
    with gate.guard(call) as verdict:
        if not verdict:
            return verdict.reason  # return this to the model as the tool result
        return run_tool(tool_call)
```

`guard` reports the call as succeeded when the block exits, or failed if it raises. For `asyncio`, use `AsyncGate` and `AsyncClient` with `async with`.

```ts
import { Client, Gate } from "@agentapprovalprotocol/sdk";

const gate = new Gate(new Client("https://approvals.example.com/api/aap", process.env.AAP_INSTANCE_TOKEN!));

async function runToolCall(runId: string, toolCall: ToolCall) {
  const result = await gate.guard(
    { key: `${runId}:${toolCall.id}`, tool: toolCall.name, arguments: toolCall.args },
    () => runTool(toolCall),
  );
  if (result.kind === "allow") return result.value;
  if (result.kind === "deny") return result.reason; // return this to the model as the tool result
}
```

`guard` runs the tool only when the call is approved and reports whether it succeeded. To run the tool yourself, use `gate.check(call)`, then call `verdict.report("succeeded")` or `verdict.report("failed")` after an allow.

For an MCP tool, also pass `server` with the server's name.

## Resume paused runs

In pause mode, a receiver resumes runs when decisions arrive. It is an HTTPS endpoint in your application. Your provider sends it a signed notification when a paused call is decided. The receiver checks the signature and wakes the run. The run then asks the provider for the decision before anything runs, so a notification alone cannot approve a call.

To set it up, start the receiver, then register it with your provider. On later starts, give it the saved credential.

### Start the receiver

Start the receiver before registering it, because the provider checks that it answers. Serve it at a public HTTPS URL that your provider can reach. For local development, expose it through an HTTPS tunnel.

```python
from fastapi import FastAPI
from agentapprovalprotocol import Receiver
from agentapprovalprotocol.langgraph import resumer  # the resumer for your framework

receiver = Receiver(resumers={"langgraph": resumer(agent)})

app = FastAPI()
app.add_route("/aap/events", receiver.asgi(), methods=["POST"])
```

Add the receiver as a route, as shown. `app.mount` redirects `/aap/events` to `/aap/events/`, and providers do not follow redirects. `receiver.asgi()` works with any ASGI framework.

```ts
import { Receiver } from "@agentapprovalprotocol/sdk";
import { resumer } from "@agentapprovalprotocol/mastra"; // the resumer for your framework

const receiver = new Receiver({ resumers: { mastra: resumer(agent) } });

export const POST = receiver.handler; // a Next.js route handler
```

`receiver.handler` also works with Hono, Bun, Deno and Workers. On Node.js `http` or Express, use `nodeListener(receiver)` from `@agentapprovalprotocol/sdk/node`. On serverless platforms, pass `waitUntil` so the run can resume after the response is sent.

### Register it

Once the server is accepting requests, register the receiver from the same process with a provisioner token from your provider:

```python
provisioned = await receiver.provision(
    provider_url="https://approvals.example.com/api/aap",
    provisioner_token=os.environ["AAP_PROVISIONER_TOKEN"],
    url="https://agents.example.com/aap/events",
)
```

```ts
const provisioned = await receiver.provision({
  providerUrl: "https://approvals.example.com/api/aap",
  provisionerToken: process.env.AAP_PROVISIONER_TOKEN!,
  url: "https://agents.example.com/aap/events",
});
```

This creates an instance whose notifications come to this receiver, and the receiver starts using its credential. Save the token, secret, registration ID and instance ID from the result: nothing is saved for you. Use the saved token as your agent's instance token too, so its paused calls notify this receiver.

If registration fails with `WebhookVerificationFailed`, check that the receiver is reachable at `url` and call `provision` again.

To register in your provider's app instead, start the receiver with the signing secret and registration ID you enter there. Without the registration ID, the receiver refuses the provider's check. See [delivery configuration](../specification/7_async.md#delivery-configuration).

### Restart with the credential

On later starts, pass the saved values. `client` can be a function, called the first time a run is woken:

```python
from agentapprovalprotocol import AsyncClient

receiver = Receiver(
    secret=secret,
    registration_id=registration_id,
    instance_id=instance_id,
    client=lambda: AsyncClient("https://approvals.example.com/api/aap", load_token()),
    resumers={"langgraph": resumer(agent)},
)
```

```ts
import { Client, Receiver } from "@agentapprovalprotocol/sdk";

const receiver = new Receiver({
  secret,
  registrationId,
  instanceId,
  client: async () => new Client("https://approvals.example.com/api/aap", await loadToken()),
  resumers: { mastra: resumer(agent) },
});
```

A receiver without a client still answers the provider, but cannot wake runs.

The resumer continues the run in the receiver's process. Read the result from where your framework stores the run, not from the call that started it.

## Test without a provider

`FakeProvider` is an in-memory provider for tests. It approves every new request unless you say otherwise.

```python
from agentapprovalprotocol import Call, Gate
from agentapprovalprotocol.testing import FakeProvider

provider = FakeProvider(auto=None)  # keep requests pending, or use "approved" or "denied"
gate = Gate(provider.client(), mode="async")
verdict = gate.check(Call(key="run-1:call-1", tool="issue_refund", arguments={"amount": 4900}))
provider.decide(verdict.request_id, "denied", "Refunds over 40 GBP need a manager.")
```

```ts
import { Gate } from "@agentapprovalprotocol/sdk";
import { FakeProvider } from "@agentapprovalprotocol/sdk/testing";

const provider = new FakeProvider({ auto: null });
const gate = new Gate(provider.client(), { mode: "async" });
const verdict = await gate.check({ key: "run-1:call-1", tool: "issue_refund", arguments: { amount: 4900 } });
if (verdict.kind === "pending") provider.decide(verdict.requestId, "approved");
```

Use `provider.async_client()` for an `AsyncGate`. To test resuming, decide the request and call `receiver.wake(request_id)`, or post the signed notification from `provider.webhook(request_id)` to your receiver.

## Troubleshooting

- **Every call denied with a refused credential:** The agent may have been archived or disabled, or its token revoked. Ask whoever manages it in your provider for a new token.
- **The client refuses the AAP URL:** Use the complete AAP URL from your provider over HTTPS. Plain HTTP works only on `localhost`.
- **Paused runs never resume:** Check that your provider can reach the receiver URL without a redirect, that the secret and registration ID match the registration, and that the receiver has a client. If a notification was missed, call `receiver.wake(request_id)` with the paused request's ID.
