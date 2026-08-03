from __future__ import annotations

import asyncio
import base64
import io
import os
import re
import time
import uuid
import json
import inspect
from collections import defaultdict, deque
from dataclasses import dataclass, field
from pathlib import Path
from collections.abc import AsyncGenerator
from typing import Any, Literal

from contextlib import asynccontextmanager

import pandas as pd
from data_harness import AsyncAgent, AsyncAgentSession
from data_harness.result import Usage
from data_harness.streaming import (
    ContentBlockDeltaEvent,
    ContentBlockStartEvent,
    ContentBlockStopEvent,
    InputJSONDelta,
    MessageDeltaEvent,
    TextDelta,
    ToolResultEvent,
)
from data_harness.types import ToolUseBlock
from dotenv import load_dotenv
from fastapi import Depends, FastAPI, File, Header, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session as DbSession
from starlette.middleware.sessions import SessionMiddleware

import auth
import budget
from db import get_db, init_db

load_dotenv(Path(__file__).with_name(".env"))


MessageRole = Literal["user", "assistant"]


class Message(BaseModel):
    role: MessageRole
    content: str
    image_base64: str | None = None
    image_format: str | None = None
    image_title: str | None = None


class UploadSummary(BaseModel):
    handle: str
    filename: str
    rows: int
    columns: list[str]
    preview: list[dict]


class SessionResponse(BaseModel):
    id: str
    messages: list[Message]
    uploads: list[UploadSummary]


class ChatRequest(BaseModel):
    content: str


class ChatResponse(BaseModel):
    message: Message
    session: SessionResponse


class MeResponse(BaseModel):
    login: str | None = None
    avatar_url: str | None = None
    budget_remaining_cents: float | None = None
    budget_total_cents: float = budget.MONTHLY_BUDGET_CENTS


@dataclass
class SessionState:
    id: str
    agent_session: AsyncAgentSession
    user_id: int | None = None
    is_byok: bool = False
    messages: list[Message] = field(default_factory=list)
    uploads: list[UploadSummary] = field(default_factory=list)


@dataclass
class SessionKeyChoice:
    user_id: int | None
    api_key: str | None
    is_byok: bool


def _allowed_origins() -> list[str]:
    extra = [
        origin.strip()
        for origin in os.environ.get("ALLOWED_ORIGINS", "").split(",")
        if origin.strip()
    ]
    # DATABASE_URL is only ever set in deployed environments (see db.py's
    # sqlite fallback for local dev) — reuse that as the prod/dev signal so
    # localhost isn't a permanently-credentialed CORS origin in production.
    if os.environ.get("DATABASE_URL"):
        return extra
    return ["http://localhost:3000", "http://127.0.0.1:3000"] + extra


@asynccontextmanager
async def _lifespan(_app: FastAPI):
    init_db()
    yield


app = FastAPI(title="data-harness API", lifespan=_lifespan)

# Middleware order matters: the last one added is outermost. SessionMiddleware
# goes first so CORSMiddleware wraps it and still attaches CORS headers to
# auth errors. The session cookie is cross-site (Vercel <-> Render), hence
# SameSite=None + Secure.
app.add_middleware(
    SessionMiddleware,
    secret_key=os.environ.get("SESSION_SECRET_KEY", "dev-insecure-secret-change-me"),
    same_site=os.environ.get("SESSION_SAME_SITE", "none"),
    https_only=os.environ.get("SESSION_HTTPS_ONLY", "true").lower() != "false",
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins(),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(auth.router)

_sessions: dict[str, SessionState] = {}

# Every request here spends real tokens against a shared API key, so a
# cheap per-IP rate limit and input size caps sit in front of the
# cost-generating endpoints as a first line of defense. This is not a
# substitute for auth or provider-side spend limits, just a floor.
MAX_MESSAGE_LENGTH = 2000
MAX_UPLOAD_BYTES = 5 * 1024 * 1024
_RATE_LIMIT_WINDOW_SECONDS = 600
_RATE_LIMIT_MAX_REQUESTS = 20
_rate_limit_hits: dict[str, deque[float]] = defaultdict(deque)


def _client_ip(request: Request) -> str:
    # Render sits behind Cloudflare, which sets CF-Connecting-IP to the true
    # origin client and overwrites any client-supplied value — unspoofable,
    # and unambiguous regardless of how many internal hops sit behind it.
    #
    # X-Forwarded-For is NOT a safe fallback here: verified live (2026-08)
    # that Render's own internal load balancer adds a further hop after
    # Cloudflare's, and that hop rotates across several internal IPs even
    # for requests from one real client — so "trust the rightmost entry"
    # (the naive fix for "don't trust the client-supplied leftmost entry")
    # is unstable in this specific multi-proxy setup. Prefer the header a
    # trusted edge sets unconditionally over parsing a chain of unknown
    # length.
    cf_ip = request.headers.get("cf-connecting-ip")
    if cf_ip:
        return cf_ip.strip()
    return request.client.host if request.client else "unknown"


def rate_limit(request: Request) -> None:
    ip = _client_ip(request)
    now = time.monotonic()
    hits = _rate_limit_hits[ip]
    while hits and now - hits[0] > _RATE_LIMIT_WINDOW_SECONDS:
        hits.popleft()
    if len(hits) >= _RATE_LIMIT_MAX_REQUESTS:
        raise HTTPException(status_code=429, detail="Too many requests. Try again later.")
    hits.append(now)


def _make_agent_session(api_key: str | None = None) -> AsyncAgentSession:
    """Build a session. `api_key` overrides the shared key (BYOK)."""
    key = api_key or os.environ.get("DEEPSEEK_API_KEY")
    if not key:
        raise HTTPException(status_code=503, detail="DEEPSEEK_API_KEY is not configured.")
    from data_harness.providers.openai import AsyncDeepSeekAdapter

    adapter = AsyncDeepSeekAdapter(
        model=os.environ.get("DEEPSEEK_MODEL", "deepseek-v4-flash"), api_key=key
    )
    agent = AsyncAgent(
        adapter=adapter,
        system=(
            "You are a precise data analyst in a local data workbench. "
            "Use Python for calculations, dataframe inspection, and "
            "evidence-backed answers. Answer in concise, readable Markdown. "
            "matplotlib is available for charts: build a normal matplotlib "
            "figure (e.g. plt.plot/plt.bar + plt.title) and it is captured "
            "and shown to the user automatically — no need to save it "
            "yourself or fall back to text-rendered charts."
        ),
        max_turns=10,
    )
    return agent.async_session()


def resolve_session_key(
    request: Request,
    x_user_deepseek_key: str | None = Header(default=None, alias="X-User-Deepseek-Key"),
    db: DbSession = Depends(get_db),
) -> SessionKeyChoice:
    """Decide which key a new session runs on: BYOK, or the shared key
    against the caller's remaining monthly budget."""
    if x_user_deepseek_key:
        return SessionKeyChoice(
            user_id=auth.current_user_id(request), api_key=x_user_deepseek_key, is_byok=True
        )

    user_id = auth.require_user_id(request)
    if budget.remaining_budget_cents(db, user_id) <= 0:
        raise HTTPException(
            status_code=402,
            detail="Monthly shared budget used up. Add your own DeepSeek key to keep going.",
        )
    return SessionKeyChoice(user_id=user_id, api_key=None, is_byok=False)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/auth/me", response_model=MeResponse)
def me(request: Request, db: DbSession = Depends(get_db)) -> MeResponse:
    user_id = auth.current_user_id(request)
    if user_id is None:
        return MeResponse()
    user = budget.get_user(db, user_id)
    if user is None:
        return MeResponse()
    return MeResponse(
        login=user.login,
        avatar_url=user.avatar_url,
        budget_remaining_cents=budget.remaining_budget_cents(db, user_id),
    )


@app.post("/sessions", response_model=SessionResponse, dependencies=[Depends(rate_limit)])
def create_session(choice: SessionKeyChoice = Depends(resolve_session_key)) -> SessionResponse:
    session = SessionState(
        id=str(uuid.uuid4()),
        agent_session=_make_agent_session(api_key=choice.api_key),
        user_id=choice.user_id,
        is_byok=choice.is_byok,
    )
    _sessions[session.id] = session
    return _serialise_session(session)


@app.get(
    "/sessions/{session_id}",
    response_model=SessionResponse,
    dependencies=[Depends(rate_limit)],
)
def get_session(session_id: str, request: Request) -> SessionResponse:
    return _serialise_session(_get_session(session_id, request))


@app.post(
    "/sessions/{session_id}/uploads",
    response_model=UploadSummary,
    dependencies=[Depends(rate_limit)],
)
async def upload_dataset(
    session_id: str,
    request: Request,
    file: UploadFile = File(...),
) -> UploadSummary:
    session = _get_session(session_id, request)
    if not file.filename or not file.filename.lower().endswith(".csv"):
        raise HTTPException(status_code=400, detail="Upload a CSV file first.")

    raw = await file.read()
    if len(raw) > MAX_UPLOAD_BYTES:
        raise HTTPException(
            status_code=400,
            detail=f"CSV too large (max {MAX_UPLOAD_BYTES // (1024 * 1024)}MB for this demo).",
        )

    try:
        df = pd.read_csv(io.BytesIO(raw))
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Could not read CSV: {exc}") from exc

    handle = session.agent_session.put(_normalise_handle(file.filename), df)
    summary = UploadSummary(
        handle=handle,
        filename=file.filename,
        rows=int(df.shape[0]),
        columns=[str(col) for col in df.columns],
        preview=df.head(5).to_dict(orient="records"),
    )
    session.uploads.append(summary)
    session.messages.append(
        Message(
            role="assistant",
            content=(
                f"Loaded `{file.filename}` as `{handle}` with "
                f"{summary.rows} rows and {len(summary.columns)} columns."
            ),
        )
    )
    return summary


@app.post(
    "/sessions/{session_id}/messages",
    response_model=ChatResponse,
    dependencies=[Depends(rate_limit)],
)
async def send_message(
    session_id: str, body: ChatRequest, request: Request, db: DbSession = Depends(get_db)
) -> ChatResponse:
    session = _get_session(session_id, request)
    content = body.content.strip()
    if not content:
        raise HTTPException(status_code=400, detail="Message cannot be empty.")
    if len(content) > MAX_MESSAGE_LENGTH:
        raise HTTPException(
            status_code=400,
            detail=f"Message too long (max {MAX_MESSAGE_LENGTH} characters).",
        )
    if not session.is_byok and session.user_id is not None:
        if budget.remaining_budget_cents(db, session.user_id) <= 0:
            raise HTTPException(
                status_code=402,
                detail="Monthly shared budget used up. Add your own DeepSeek key to keep going.",
            )

    session.messages.append(Message(role="user", content=content))

    result = await _maybe_await(session.agent_session.ask_result(content))
    if not session.is_byok and session.user_id is not None:
        budget.record_usage(db, session.user_id, result.usage)
    if result.status == "success":
        answer = result.text
    elif result.status == "max_turns_exceeded":
        answer = "The agent reached its turn limit. Try a simpler question."
    else:
        answer = f"Agent error: {result.error or 'unknown'}."

    assistant_message = Message(role="assistant", content=answer)
    session.messages.append(assistant_message)
    return ChatResponse(
        message=assistant_message,
        session=_serialise_session(session),
    )


@app.post(
    "/sessions/{session_id}/messages/stream",
    dependencies=[Depends(rate_limit)],
)
async def stream_message(
    session_id: str,
    body: ChatRequest,
    request: Request,
    db: DbSession = Depends(get_db),
) -> StreamingResponse:
    session = _get_session(session_id, request)
    content = body.content.strip()
    if not content:
        raise HTTPException(status_code=400, detail="Message cannot be empty.")
    if len(content) > MAX_MESSAGE_LENGTH:
        raise HTTPException(
            status_code=400,
            detail=f"Message too long (max {MAX_MESSAGE_LENGTH} characters).",
        )
    if not session.is_byok and session.user_id is not None:
        if budget.remaining_budget_cents(db, session.user_id) <= 0:
            raise HTTPException(
                status_code=402,
                detail="Monthly shared budget used up. Add your own DeepSeek key to keep going.",
            )

    session.messages.append(Message(role="user", content=content))
    chart_paths_before = {c.path for c in session.agent_session.cache.list_charts()}

    async def events() -> AsyncGenerator[str, None]:
        answer_parts: list[str] = []
        tool_json_by_index: dict[int, str] = {}
        tool_use_by_index: dict[int, ToolUseBlock] = {}
        total_usage = Usage()

        def record() -> None:
            if not session.is_byok and session.user_id is not None:
                budget.record_usage(db, session.user_id, total_usage)

        try:
            async for item in session.agent_session.ask_stream(content):
                if isinstance(item, MessageDeltaEvent):
                    total_usage = total_usage + Usage(
                        input_tokens=item.input_tokens,
                        output_tokens=item.output_tokens,
                        cache_read_tokens=item.cache_read_tokens,
                        cache_write_tokens=item.cache_write_tokens,
                    )
                normalised = _normalise_stream_item(
                    item,
                    tool_json_by_index=tool_json_by_index,
                    tool_use_by_index=tool_use_by_index,
                )
                if normalised is None:
                    continue
                event_type, data = normalised
                if event_type == "chunk":
                    answer_parts.append(str(data))
                yield _stream_event(event_type, data)
        except asyncio.CancelledError:
            # Client disconnected (e.g. the Stop button) or the connection
            # dropped mid-stream. Tokens already generated were already
            # billed by the provider, so record them before letting the
            # cancellation propagate — don't swallow it.
            record()
            raise
        except Exception as exc:
            record()
            print(f"stream_message error for session {session_id}: {exc!r}")
            answer = "Agent error. Please try again."
            session.messages.append(Message(role="assistant", content=answer))
            yield _stream_event("error", answer)
            yield _stream_event("done", _serialise_session(session).model_dump())
            return

        record()
        answer = "".join(answer_parts)
        if not answer.strip():
            # The provider call can fail (bad key, rate limit) without the
            # harness raising in streaming mode, leaving an empty response
            # with no signal of what happened.
            answer = "The agent returned no response. Check that the API key and model are valid."
            yield _stream_event("error", answer)
        session.messages.append(Message(role="assistant", content=answer))

        for chart in session.agent_session.cache.list_charts():
            if chart.path in chart_paths_before:
                continue
            try:
                encoded = base64.b64encode(chart.read_bytes()).decode("ascii")
            except OSError:
                continue
            chart_message = Message(
                role="assistant",
                content="",
                image_base64=encoded,
                image_format=chart.format,
                image_title=chart.title,
            )
            session.messages.append(chart_message)
            yield _stream_event(
                "chart",
                {
                    "base64": encoded,
                    "format": chart.format,
                    "title": chart.title,
                },
            )

        yield _stream_event("done", _serialise_session(session).model_dump())

    return StreamingResponse(events(), media_type="application/x-ndjson")


def _serialise_session(session: SessionState) -> SessionResponse:
    return SessionResponse(
        id=session.id,
        messages=session.messages,
        uploads=session.uploads,
    )


def _get_session(session_id: str, request: Request) -> SessionState:
    try:
        session = _sessions[session_id]
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Session not found.") from exc
    # BYOK sessions have no signed-in owner to check against. Non-BYOK
    # sessions belong to whoever created them; a session id alone (a UUID,
    # but still just a string in a request) shouldn't be a usable bearer
    # token for someone else's uploaded data and chat history.
    if not session.is_byok and session.user_id is not None:
        if auth.current_user_id(request) != session.user_id:
            raise HTTPException(status_code=404, detail="Session not found.")
    return session


def _normalise_handle(filename: str) -> str:
    stem = filename.rsplit(".", 1)[0]
    handle = re.sub(r"\W+", "_", stem).strip("_").lower()
    if not handle:
        return "dataset"
    if handle[0].isdigit():
        handle = f"dataset_{handle}"
    return handle


async def _maybe_await(value: Any) -> Any:
    if inspect.isawaitable(value):
        return await value
    return value


def _stream_event(event_type: str, data: Any) -> str:
    return json.dumps({"type": event_type, "data": data}) + "\n"


def _normalise_stream_item(
    item: Any,
    *,
    tool_json_by_index: dict[int, str] | None = None,
    tool_use_by_index: dict[int, ToolUseBlock] | None = None,
) -> tuple[str, Any] | None:
    if isinstance(item, str):
        return "chunk", item
    if isinstance(item, ContentBlockStartEvent):
        if isinstance(item.content_block, ToolUseBlock):
            if tool_json_by_index is not None:
                tool_json_by_index[item.index] = ""
            if tool_use_by_index is not None:
                tool_use_by_index[item.index] = item.content_block
        else:
            if tool_json_by_index is not None:
                tool_json_by_index.pop(item.index, None)
            if tool_use_by_index is not None:
                tool_use_by_index.pop(item.index, None)
        return None
    if isinstance(item, ContentBlockDeltaEvent):
        if isinstance(item.delta, TextDelta):
            return "chunk", item.delta.text
        if isinstance(item.delta, InputJSONDelta):
            if tool_json_by_index is not None:
                tool_json_by_index[item.index] = (
                    tool_json_by_index.get(item.index, "") + item.delta.partial_json
                )
        return None
    if isinstance(item, ContentBlockStopEvent):
        if tool_json_by_index is None or tool_use_by_index is None:
            return None
        tool_use = tool_use_by_index.get(item.index)
        if tool_use is None:
            return None
        raw_input = tool_json_by_index.get(item.index, "")
        try:
            tool_input = json.loads(raw_input) if raw_input else {}
        except json.JSONDecodeError:
            tool_input = {}
        tool_json_by_index.pop(item.index, None)
        tool_use_by_index.pop(item.index, None)
        return (
            "tool_use",
            {
                "id": tool_use.tool_use_id,
                "name": tool_use.tool_name,
                "input": tool_input,
            },
        )
    if isinstance(item, ToolResultEvent):
        return (
            "tool_result",
            {
                "id": item.tool_use_id,
                "name": item.tool_name,
                "content": item.content,
                "is_error": item.is_error,
            },
        )
    if isinstance(item, dict):
        event_type = item.get("type")
        if event_type in {"chunk", "tool_use", "tool_result", "error"}:
            return event_type, item.get("data", "")
    event_type = getattr(item, "type", None)
    data = getattr(item, "data", None)
    if event_type in {"chunk", "tool_use", "tool_result", "error"}:
        return event_type, data if data is not None else ""
    if event_type in {
        "message_start",
        "message_delta",
        "message_stop",
        "content_block_start",
        "content_block_delta",
        "content_block_stop",
    }:
        return None
    return "chunk", str(item)
