"""Tests for the data-harness-ui FastAPI backend."""
from __future__ import annotations

import io
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from data_harness.result import Usage
from data_harness.streaming import (
    ContentBlockDeltaEvent,
    ContentBlockStartEvent,
    ContentBlockStopEvent,
    InputJSONDelta,
    TextDelta,
    ToolResultEvent,
)
from data_harness.types import ToolUseBlock
from fastapi.testclient import TestClient

from main import SessionKeyChoice, app, _normalise_handle, _rate_limit_hits, resolve_session_key


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _mock_agent_session(answer: str = "mocked answer") -> MagicMock:
    """Return a mock AsyncAgentSession whose ask_result() succeeds."""
    session = MagicMock()
    session.put.side_effect = lambda name, value, **kw: name
    result = MagicMock()
    result.status = "success"
    result.text = answer
    result.error = None
    result.usage = Usage(input_tokens=10, output_tokens=5)
    session.ask_result = AsyncMock(return_value=result)

    async def ask_stream(_content):
        yield answer

    session.ask_stream = ask_stream
    # cache.get used nowhere in the new code, but keep it available
    session.cache = MagicMock()
    return session


def _csv_bytes(content: str = "a,b\n1,2\n3,4\n") -> bytes:
    return content.encode()


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

def _fake_session_key() -> SessionKeyChoice:
    return SessionKeyChoice(user_id=1, api_key=None, is_byok=False)


@pytest.fixture
def client():
    _rate_limit_hits.clear()
    app.dependency_overrides[resolve_session_key] = _fake_session_key
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.pop(resolve_session_key, None)


@pytest.fixture
def session_id(client):
    """Create a real session and return its ID."""
    with patch("main._make_agent_session", return_value=_mock_agent_session()):
        resp = client.post("/sessions")
    assert resp.status_code == 200
    return resp.json()["id"]


# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------

def test_health(client):
    assert client.get("/health").json() == {"status": "ok"}


# ---------------------------------------------------------------------------
# Session lifecycle
# ---------------------------------------------------------------------------

def test_create_session_starts_without_messages(client):
    with patch("main._make_agent_session", return_value=_mock_agent_session()):
        resp = client.post("/sessions")
    assert resp.status_code == 200
    body = resp.json()
    assert "id" in body
    assert body["messages"] == []
    assert body["uploads"] == []


def test_create_session_fails_without_api_key(client):
    with patch("main.os.environ.get", return_value=None):
        resp = client.post("/sessions")
    assert resp.status_code == 503


def test_get_session(client, session_id):
    resp = client.get(f"/sessions/{session_id}")
    assert resp.status_code == 200
    assert resp.json()["id"] == session_id


def test_get_missing_session(client):
    assert client.get("/sessions/does-not-exist").status_code == 404


# ---------------------------------------------------------------------------
# Uploads
# ---------------------------------------------------------------------------

def test_upload_csv(client, session_id):
    resp = client.post(
        f"/sessions/{session_id}/uploads",
        files={"file": ("data.csv", io.BytesIO(_csv_bytes()), "text/csv")},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["handle"] == "data"
    assert body["rows"] == 2
    assert body["columns"] == ["a", "b"]
    assert len(body["preview"]) == 2


def test_upload_non_csv_rejected(client, session_id):
    resp = client.post(
        f"/sessions/{session_id}/uploads",
        files={"file": ("data.txt", io.BytesIO(b"hello"), "text/plain")},
    )
    assert resp.status_code == 400


def test_upload_empty_csv_still_accepted(client, session_id):
    # An empty CSV is technically valid — pandas returns a DataFrame with 0 rows
    resp = client.post(
        f"/sessions/{session_id}/uploads",
        files={"file": ("empty.csv", io.BytesIO(b"a,b\n"), "text/csv")},
    )
    assert resp.status_code == 200
    assert resp.json()["rows"] == 0


def test_upload_puts_data_into_agent_session(client):
    mock_session = _mock_agent_session()
    with patch("main._make_agent_session", return_value=mock_session):
        resp = client.post("/sessions")
        sid = resp.json()["id"]

    client.post(
        f"/sessions/{sid}/uploads",
        files={"file": ("sales.csv", io.BytesIO(_csv_bytes()), "text/csv")},
    )
    mock_session.put.assert_called_once()
    call_args = mock_session.put.call_args
    assert call_args[0][0] == "sales"  # handle name


# ---------------------------------------------------------------------------
# Messages
# ---------------------------------------------------------------------------

def test_send_message_returns_answer(client, session_id):
    resp = client.post(
        f"/sessions/{session_id}/messages",
        json={"content": "What columns are in this?"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["message"]["role"] == "assistant"
    assert body["message"]["content"] == "mocked answer"


def test_stream_message_returns_ndjson_chunks(client):
    mock_session = _mock_agent_session()

    async def ask_stream(_content):
        yield "hello"
        yield " world"

    mock_session.ask_stream = ask_stream
    with patch("main._make_agent_session", return_value=mock_session):
        resp = client.post("/sessions")
        sid = resp.json()["id"]

    resp = client.post(f"/sessions/{sid}/messages/stream", json={"content": "go"})

    assert resp.status_code == 200
    events = [line for line in resp.text.splitlines() if line]
    assert '"type": "chunk"' in events[0]
    assert '"hello"' in events[0]
    assert '" world"' in events[1]
    assert '"type": "done"' in events[-1]


def test_stream_message_forwards_tool_events(client):
    mock_session = _mock_agent_session()

    async def ask_stream(_content):
        yield {
            "type": "tool_use",
            "data": {"id": "call_1", "name": "python_interpreter", "input": {"code": "df.head()"}},
        }
        yield {
            "type": "tool_result",
            "data": {"id": "call_1", "content": "shape: (2, 2)", "is_error": False},
        }
        yield "# Result\nThe table has **2 rows**."

    mock_session.ask_stream = ask_stream
    with patch("main._make_agent_session", return_value=mock_session):
        resp = client.post("/sessions")
        sid = resp.json()["id"]

    resp = client.post(f"/sessions/{sid}/messages/stream", json={"content": "inspect"})

    assert resp.status_code == 200
    events = [line for line in resp.text.splitlines() if line]
    assert '"type": "tool_use"' in events[0]
    assert "python_interpreter" in events[0]
    assert '"type": "tool_result"' in events[1]
    assert "shape: (2, 2)" in events[1]
    assert '"type": "chunk"' in events[2]
    assert '"type": "done"' in events[3]
    history = client.get(f"/sessions/{sid}").json()["messages"]
    assert history[-1] == {
        "role": "assistant",
        "content": "# Result\nThe table has **2 rows**.",
    }


def test_stream_message_maps_data_harness_stream_events(client):
    mock_session = _mock_agent_session()

    async def ask_stream(_content):
        yield ContentBlockStartEvent(
            index=0,
            content_block=ToolUseBlock(
                tool_use_id="call_1",
                tool_name="python_interpreter",
                tool_input={},
            ),
        )
        yield ContentBlockDeltaEvent(
            index=0,
            delta=InputJSONDelta(partial_json='{"code": "df.describe()"}'),
        )
        yield ContentBlockStopEvent(index=0)
        yield ToolResultEvent(
            tool_use_id="call_1",
            tool_name="python_interpreter",
            content="count mean std",
            is_error=False,
        )
        yield ContentBlockStartEvent(index=1, content_block=MagicMock())
        yield ContentBlockDeltaEvent(index=1, delta=TextDelta(text="# Summary\n"))
        yield ContentBlockDeltaEvent(index=1, delta=TextDelta(text="- Done"))
        yield ContentBlockStopEvent(index=1)

    mock_session.ask_stream = ask_stream
    with patch("main._make_agent_session", return_value=mock_session):
        resp = client.post("/sessions")
        sid = resp.json()["id"]

    resp = client.post(f"/sessions/{sid}/messages/stream", json={"content": "inspect"})

    assert resp.status_code == 200
    events = [line for line in resp.text.splitlines() if line]
    assert '"type": "tool_use"' in events[0]
    assert '"code": "df.describe()"' in events[0]
    assert '"type": "tool_result"' in events[1]
    assert "count mean std" in events[1]
    assert '"type": "chunk"' in events[2]
    assert '"# Summary\\n"' in events[2]
    assert '"type": "chunk"' in events[3]
    assert '"- Done"' in events[3]
    assert '"type": "done"' in events[4]
    history = client.get(f"/sessions/{sid}").json()["messages"]
    assert history[-1] == {"role": "assistant", "content": "# Summary\n- Done"}


def test_stream_message_appends_to_history(client, session_id):
    resp = client.post(f"/sessions/{session_id}/messages/stream", json={"content": "go"})

    assert resp.status_code == 200
    history = client.get(f"/sessions/{session_id}").json()["messages"]
    assert history[-2] == {"role": "user", "content": "go"}
    assert history[-1] == {"role": "assistant", "content": "mocked answer"}


def test_send_message_appends_to_history(client, session_id):
    client.post(f"/sessions/{session_id}/messages", json={"content": "first"})
    client.post(f"/sessions/{session_id}/messages", json={"content": "second"})
    resp = client.get(f"/sessions/{session_id}")
    roles = [m["role"] for m in resp.json()["messages"]]
    # user + assistant + user + assistant
    assert roles.count("user") == 2
    assert roles.count("assistant") == 2


def test_send_empty_message_rejected(client, session_id):
    resp = client.post(f"/sessions/{session_id}/messages", json={"content": "   "})
    assert resp.status_code == 400


def test_send_oversized_message_rejected(client, session_id):
    resp = client.post(
        f"/sessions/{session_id}/messages", json={"content": "x" * 2001}
    )
    assert resp.status_code == 400


def test_rate_limit_blocks_excess_requests(client):
    with patch("main._make_agent_session", return_value=_mock_agent_session()):
        for _ in range(20):
            resp = client.post("/sessions")
            assert resp.status_code == 200
        blocked = client.post("/sessions")
    assert blocked.status_code == 429


def test_send_message_to_missing_session(client):
    resp = client.post("/sessions/nope/messages", json={"content": "hi"})
    assert resp.status_code == 404


def test_max_turns_exceeded_returns_graceful_message(client):
    mock_session = _mock_agent_session()
    result = mock_session.ask_result.return_value
    result.status = "max_turns_exceeded"
    result.text = ""
    with patch("main._make_agent_session", return_value=mock_session):
        resp = client.post("/sessions")
        sid = resp.json()["id"]
    resp = client.post(f"/sessions/{sid}/messages", json={"content": "go"})
    assert resp.status_code == 200
    assert "turn limit" in resp.json()["message"]["content"]


def test_agent_error_returns_graceful_message(client):
    mock_session = _mock_agent_session()
    result = mock_session.ask_result.return_value
    result.status = "error"
    result.text = ""
    result.error = "something broke"
    with patch("main._make_agent_session", return_value=mock_session):
        resp = client.post("/sessions")
        sid = resp.json()["id"]
    resp = client.post(f"/sessions/{sid}/messages", json={"content": "go"})
    assert resp.status_code == 200
    assert "something broke" in resp.json()["message"]["content"]


# ---------------------------------------------------------------------------
# _normalise_handle
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("filename,expected", [
    ("sales_data.csv", "sales_data"),
    ("My File (2024).csv", "my_file_2024"),
    ("123data.csv", "dataset_123data"),
    (".csv", "dataset"),
    ("UPPER.csv", "upper"),
])
def test_normalise_handle(filename, expected):
    assert _normalise_handle(filename) == expected
