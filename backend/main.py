from __future__ import annotations

import os
import re
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

import pandas as pd
from data_harness import Agent, AgentSession
from dotenv import load_dotenv
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
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
    agent_session: AgentSession
    messages: list[Message] = field(default_factory=list)
    uploads: list[UploadSummary] = field(default_factory=list)


app = FastAPI(title="data-harness API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

_sessions: dict[str, SessionState] = {}


def _make_agent_session() -> AgentSession:
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        raise HTTPException(status_code=503, detail="OPENAI_API_KEY is not configured.")
    from data_harness.providers.openai import OpenAIAdapter

    adapter = OpenAIAdapter(model=os.environ.get("OPENAI_MODEL", "gpt-4o-mini"))
    agent = Agent(
        adapter=adapter,
        system=(
            "You are a precise data analyst in a local data workbench. "
            "Use Python when calculation or dataframe inspection is needed. "
            "Refer to uploaded data by its cache handle."
        ),
        max_turns=10,
    )
    return agent.session()


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/sessions", response_model=SessionResponse)
def create_session() -> SessionResponse:
    session = SessionState(
        id=str(uuid.uuid4()),
        agent_session=_make_agent_session(),
    )
    session.messages.append(
        Message(
            role="assistant",
            content="Upload a dataset, then ask a question about it.",
        )
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
def send_message(session_id: str, request: ChatRequest) -> ChatResponse:
    session = _get_session(session_id)
    content = request.content.strip()
    if not content:
        raise HTTPException(status_code=400, detail="Message cannot be empty.")

    session.messages.append(Message(role="user", content=content))

    result = session.agent_session.ask_result(content)
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
