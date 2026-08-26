"""In-app AI help panel API (plan M8/D3).

Administrator-only, opt-in, no conversation history persisted server-side -
each request is a single, bounded round trip. See backend/help_assistant for
the tool-scope and loop design and its security reasoning.
"""

from __future__ import annotations

from collections.abc import Callable

from fastapi import APIRouter, Request

from ...assistant_tools import AssistantToolService
from ...audit import AuditStore
from ...errors import ApiError
from ...help_assistant.loop import run_conversation
from ...help_assistant.scope import build_tool_scope
from ...security import RateLimiter
from ...settings import Settings
from ..schemas import AssistantAskRequest

#: Separate from the app's general API/write rate limits: this gates real
#: spend against the administrator's own Anthropic account, not just local
#: resource use.
_REQUESTS_PER_HOUR = 20


def create_assistant_router(
    *,
    service: AssistantToolService,
    settings: Settings,
    audit: AuditStore,
    require_capability: Callable[[Request, str], str],
) -> APIRouter:
    router = APIRouter(prefix="/api/v1/assistant", tags=["AI help panel"])
    rate_limiter = RateLimiter(read_limit=_REQUESTS_PER_HOUR, write_limit=_REQUESTS_PER_HOUR, window_seconds=3600)

    @router.post("/ask")
    async def ask(body: AssistantAskRequest, request: Request) -> dict:
        user_id = require_capability(request, "assistant.ask")
        decision = rate_limiter.check(user_id, write=True)
        if not decision.allowed:
            raise ApiError(
                "assistant_rate_limit_exceeded",
                "Too many AI help panel requests. Try again later.",
                429,
                {"retry_after": decision.retry_after},
            )
        identity = f"assistant:{user_id}"
        tools = build_tool_scope(
            service,
            project_name=body.project_name,
            configuration_name=body.configuration_name,
            identity=identity,
        )
        try:
            result = run_conversation(
                api_key=settings.assistant_api_key,
                user_message=body.message,
                tools=tools,
            )
        except ApiError as exc:
            audit.record(
                user_id=user_id,
                action="assistant.ask",
                configuration=body.project_name,
                old_revision=None,
                new_revision=None,
                result=exc.error,
            )
            raise
        proposals = [
            {
                "change_set_id": call["result"]["change_set_id"],
                "tool": call["name"],
                "preview": call["result"].get("preview"),
            }
            for call in result["tool_calls"]
            if call["name"] in {"propose_layout_change", "propose_binding_change"}
            and call["result"].get("ok")
            and call["result"].get("change_set_id")
        ]
        audit.record(
            user_id=user_id,
            action="assistant.ask",
            configuration=body.project_name,
            old_revision=None,
            new_revision=None,
            result="success",
            metadata={
                "tool_call_count": len(result["tool_calls"]),
                "change_set_ids": [item["change_set_id"] for item in proposals],
            },
        )
        return {
            "reply": result["reply"],
            "proposals": proposals,
            "tool_calls": [
                {"name": call["name"], "ok": bool(call["result"].get("ok"))}
                for call in result["tool_calls"]
            ],
        }

    @router.post("/changesets/{change_set_id}/apply")
    async def apply(change_set_id: str, request: Request) -> dict:
        # Never called by the model (see loop.py/scope.py): this is the
        # only path that applies a proposal, and it always requires this
        # separate, explicit request - the same capability gate as /ask.
        user_id = require_capability(request, "assistant.ask")
        identity = f"assistant:{user_id}"
        try:
            applied = service.apply_changeset(change_set_id, identity=identity)
        except ApiError as exc:
            audit.record(
                user_id=user_id,
                action="assistant.apply",
                configuration=change_set_id,
                old_revision=None,
                new_revision=None,
                result=exc.error,
            )
            raise
        audit.record(
            user_id=user_id,
            action="assistant.apply",
            configuration=change_set_id,
            old_revision=None,
            new_revision=applied.get("applied_revision"),
            result="success",
        )
        return applied

    return router
