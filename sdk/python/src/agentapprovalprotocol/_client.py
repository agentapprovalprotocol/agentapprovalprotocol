"""AAP HTTP client, in synchronous and asynchronous forms.

Both forms share the response rules below; only the transport differs.
Transport failures, 429 and 5xx responses are retried with the same
idempotency key until the retry budget runs out.
"""

from __future__ import annotations

import asyncio
import time
from email.utils import parsedate_to_datetime
from typing import Any, Mapping
from urllib.parse import urlsplit

import httpx

from ._wire import ProtocolError, Request, dumps, loads, parse_request

USER_AGENT = "agentapprovalprotocol-python"
MAX_RESPONSE = 8 << 20


class AAPError(Exception):
    """The operation did not produce a usable result."""


class CredentialRefused(AAPError):
    """The provider refused the instance credential (HTTP 401 or 403)."""


class ConflictError(AAPError):
    """A 409 answer, identified by the provider's error code."""

    def __init__(self, code: str, message: str = ""):
        super().__init__(f"AAP conflict: {code}")
        self.code = code
        self.message = message


class NotFound(AAPError):
    """The request is unknown or unavailable to this instance."""


def validate_base_url(base_url: str) -> str:
    parts = urlsplit(base_url)
    if not parts.netloc or parts.username or parts.password or parts.query or parts.fragment:
        raise ValueError("base URL must be an absolute AAP URL without credentials, query or fragment")
    local = parts.hostname in ("localhost", "127.0.0.1", "::1")
    if parts.scheme != "https" and not (parts.scheme == "http" and local):
        raise ValueError("base URL requires HTTPS, except on localhost")
    return base_url.rstrip("/")


def _retry_after(response: httpx.Response) -> float | None:
    value = response.headers.get("retry-after")
    if value is None:
        return None
    if value.isdigit():
        return float(value)
    try:
        return max(0.0, parsedate_to_datetime(value).timestamp() - time.time())
    except (TypeError, ValueError):
        return None


def _result(response: httpx.Response, raw: bytes) -> Request | None:
    """Turn a final response into a request, raise, or return None to retry."""
    code = response.status_code
    if code == 429 or code >= 500:
        return None
    if code in (401, 403):
        raise CredentialRefused(f"the provider refused the instance credential (HTTP {code})")
    if code == 404:
        raise NotFound("the request is unavailable")
    if code == 409:
        try:
            error = loads(raw)["error"]
            raise ConflictError(str(error["code"]), str(error.get("message", "")))
        except (ProtocolError, KeyError, TypeError) as err:
            raise AAPError("AAP request failed (HTTP 409)") from err
    if code not in (200, 201):
        raise AAPError(f"AAP request failed (HTTP {code})")
    if len(raw) > MAX_RESPONSE:
        raise ProtocolError("AAP response too large")
    return parse_request(loads(raw))


class _Base:
    def __init__(self, base_url: str, token: str, *, retry_budget: float = 30.0):
        if not token or "\n" in token or "\r" in token:
            raise ValueError("instance token is required and must not contain newlines")
        self.base_url = validate_base_url(base_url)
        self.retry_budget = retry_budget
        self._headers = {"Authorization": f"Bearer {token}", "User-Agent": USER_AGENT}

    def _request(self, method: str, path: str, body: Mapping[str, Any] | None, key: str | None) -> tuple[dict[str, str], bytes | None]:
        headers = dict(self._headers)
        content = None
        if body is not None:
            headers["Content-Type"] = "application/json"
            content = dumps(body)
        if key is not None:
            headers["Idempotency-Key"] = key
        return headers, content


class Client(_Base):
    """Synchronous AAP client for one instance credential."""

    def __init__(self, base_url: str, token: str, *, http: httpx.Client | None = None, retry_budget: float = 30.0):
        super().__init__(base_url, token, retry_budget=retry_budget)
        self._http = http or httpx.Client(timeout=40.0, follow_redirects=False)

    def close(self) -> None:
        self._http.close()

    def _send(self, method: str, path: str, body: Mapping[str, Any] | None = None, key: str | None = None, *, timeout: float | None = None) -> Request:
        headers, content = self._request(method, path, body, key)
        deadline = time.monotonic() + self.retry_budget
        delay = 0.1
        while True:
            wait = delay
            try:
                response = self._http.request(method, self.base_url + path, headers=headers, content=content, timeout=timeout or 40.0)
                raw = response.read()
                result = _result(response, raw)
                if result is not None:
                    return result
                wait = max(delay, _retry_after(response) or 0.0)
            except httpx.TransportError:
                pass
            if time.monotonic() + wait > deadline:
                raise AAPError("the provider could not be reached")
            time.sleep(wait)
            delay = min(delay * 2, 2.0)

    def create(self, submission: Mapping[str, Any], key: str) -> Request:
        return self._send("POST", "/v1/requests", submission, key)

    def get(self, request_id: str, *, wait: int | None = None) -> Request:
        query = f"?wait={wait}s" if wait else ""
        return self._send("GET", f"/v1/requests/{request_id}{query}", timeout=(wait or 0) + 10.0)

    def cancel(self, request_id: str) -> Request:
        return self._send("DELETE", f"/v1/requests/{request_id}")

    def consume(self, request_id: str, key: str) -> Request:
        return self._send("POST", f"/v1/requests/{request_id}/consume", None, key)

    def report_outcome(self, request_id: str, status: str, note: str | None = None) -> Request:
        body = {"status": status, **({"note": note} if note else {})}
        return self._send("POST", f"/v1/requests/{request_id}/outcome", body)


class AsyncClient(_Base):
    """Asynchronous AAP client for one instance credential."""

    def __init__(self, base_url: str, token: str, *, http: httpx.AsyncClient | None = None, retry_budget: float = 30.0):
        super().__init__(base_url, token, retry_budget=retry_budget)
        self._http = http or httpx.AsyncClient(timeout=40.0, follow_redirects=False)

    async def aclose(self) -> None:
        await self._http.aclose()

    async def _send(self, method: str, path: str, body: Mapping[str, Any] | None = None, key: str | None = None, *, timeout: float | None = None) -> Request:
        headers, content = self._request(method, path, body, key)
        deadline = time.monotonic() + self.retry_budget
        delay = 0.1
        while True:
            wait = delay
            try:
                response = await self._http.request(method, self.base_url + path, headers=headers, content=content, timeout=timeout or 40.0)
                raw = await response.aread()
                result = _result(response, raw)
                if result is not None:
                    return result
                wait = max(delay, _retry_after(response) or 0.0)
            except httpx.TransportError:
                pass
            if time.monotonic() + wait > deadline:
                raise AAPError("the provider could not be reached")
            await asyncio.sleep(wait)
            delay = min(delay * 2, 2.0)

    async def create(self, submission: Mapping[str, Any], key: str) -> Request:
        return await self._send("POST", "/v1/requests", submission, key)

    async def get(self, request_id: str, *, wait: int | None = None) -> Request:
        query = f"?wait={wait}s" if wait else ""
        return await self._send("GET", f"/v1/requests/{request_id}{query}", timeout=(wait or 0) + 10.0)

    async def cancel(self, request_id: str) -> Request:
        return await self._send("DELETE", f"/v1/requests/{request_id}")

    async def consume(self, request_id: str, key: str) -> Request:
        return await self._send("POST", f"/v1/requests/{request_id}/consume", None, key)

    async def report_outcome(self, request_id: str, status: str, note: str | None = None) -> Request:
        body = {"status": status, **({"note": note} if note else {})}
        return await self._send("POST", f"/v1/requests/{request_id}/outcome", body)
