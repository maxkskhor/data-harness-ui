from __future__ import annotations

import os
import re
import uuid
import json
import inspect
from dataclasses import dataclass, field
from pathlib import Path
from collections.abc import AsyncGenerator
from typing import Any, Literal

import pandas as pd
from data_harness import AsyncAgent, AsyncAgentSession
from data_harness.streaming import (
    ContentBlockDeltaEvent,
    ContentBlockStartEvent,
    ContentBlockStopEvent,
    InputJSONDelta,
    TextDelta,
    ToolResultEvent,
)
from data_harness.types import ToolUseBlock
from dotenv import load_dotenv
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

load_dotenv(Path(__file__).with_name(".env"))


MessageRole = Literal["user", "assistant"]


class Message(BaseModel):
    role: MessageRole
    content: str


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


@dataclass
class SessionState:
    id: str
    agent_session: AsyncAgentSession
    messages: list[Message] = field(default_factory=list)
    uploads: list[UploadSummary] = field(default_factory=list)


def _allowed_origins() -> list[str]:
    defaults = ["http://localhost:3000", "http://127.0.0.1:3000"]
    extra = [
        origin.strip()
        for origin in os.environ.get("ALLOWED_ORIGINS", "").split(",")
        if origin.strip()
    ]
    return defaults + extra


app = FastAPI(title="data-harness API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins(),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

_sessions: dict[str, SessionState] = {}


def _make_agent_session() -> AsyncAgentSession:
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        raise HTTPException(status_code=503, detail="OPENAI_API_KEY is not configured.")
    from data_harness.providers.openai import AsyncOpenAIAdapter

    adapter = AsyncOpenAIAdapter(model=os.environ.get("OPENAI_MODEL", "gpt-4o-mini"))
    agent = AsyncAgent(
        adapter=adapter,
        system=(
            "You are a precise data analyst in a local data workbench. "
            "Use Python for calculations, dataframe inspection, and "
            "evidence-backed answers. Answer in concise, readable Markdown."
        ),
        max_turns=10,
    )
    return agent.async_session()


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/sessions", response_model=SessionResponse)
def create_session() -> SessionResponse:
    session = SessionState(
        id=str(uuid.uuid4()),
        agent_session=_make_agent_session(),
    )
    _sessions[session.id] = session
    return _serialise_session(session)


@app.get("/sessions/{session_id}", response_model=SessionResponse)
def get_session(session_id: str) -> SessionResponse:
    return _serialise_session(_get_session(session_id))


@app.post("/sessions/{session_id}/uploads", response_model=UploadSummary)
async def upload_dataset(
    session_id: str,
    file: UploadFile = File(...),
) -> UploadSummary:
    session = _get_session(session_id)
    if not file.filename or not file.filename.lower().endswith(".csv"):
        raise HTTPException(status_code=400, detail="Upload a CSV file first.")

    try:
        df = pd.read_csv(file.file)
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


@app.post("/sessions/{session_id}/messages", response_model=ChatResponse)
async def send_message(session_id: str, request: ChatRequest) -> ChatResponse:
    session = _get_session(session_id)
    content = request.content.strip()
    if not content:
        raise HTTPException(status_code=400, detail="Message cannot be empty.")

    session.messages.append(Message(role="user", content=content))

    result = await _maybe_await(session.agent_session.ask_result(content))
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


@app.post("/sessions/{session_id}/messages/stream")
async def stream_message(
    session_id: str,
    request: ChatRequest,
) -> StreamingResponse:
    session = _get_session(session_id)
    content = request.content.strip()
    if not content:
        raise HTTPException(status_code=400, detail="Message cannot be empty.")

    session.messages.append(Message(role="user", content=content))

    async def events() -> AsyncGenerator[str, None]:
        answer_parts: list[str] = []
        tool_json_by_index: dict[int, str] = {}
        tool_use_by_index: dict[int, ToolUseBlock] = {}
        try:
            async for item in session.agent_session.ask_stream(content):
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
        except Exception as exc:
            answer = f"Agent error: {exc!r}."
            session.messages.append(Message(role="assistant", content=answer))
            yield _stream_event("error", answer)
            yield _stream_event("done", _serialise_session(session).model_dump())
            return

        answer = "".join(answer_parts)
        session.messages.append(Message(role="assistant", content=answer))
        yield _stream_event("done", _serialise_session(session).model_dump())

    return StreamingResponse(events(), media_type="application/x-ndjson")


def _serialise_session(session: SessionState) -> SessionResponse:
    return SessionResponse(
        id=session.id,
        messages=session.messages,
        uploads=session.uploads,
    )


def _get_session(session_id: str) -> SessionState:
    try:
        return _sessions[session_id]
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Session not found.") from exc


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
