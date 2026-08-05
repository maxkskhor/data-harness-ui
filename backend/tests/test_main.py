"""Tests for the data-harness-ui FastAPI backend."""
from __future__ import annotations

import io
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from data_harness import (
    ChartArtifact,
    ContentBlockDeltaEvent,
    ContentBlockStartEvent,
    ContentBlockStopEvent,
    InputJSONDelta,
    TextDelta,
    ToolResultEvent,
    ToolUseBlock,
    Usage,
)
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
    session.cache = MagicMock()
    session.cache.list_charts = MagicMock(return_value=[])
    return session


def _csv_bytes(content: str = "a,b\n1,2\n3,4\n") -> bytes:
    return content.encode()


def _mock_chart(
    handle: str = "chart",
    path: str = "/tmp/chart.png",
    data: bytes = b"fake-png-bytes",
    title: str = "Revenue by Month",
) -> ChartArtifact:
    # A real ChartArtifact, not a bare MagicMock — the /charts/{handle}
    # endpoint does `isinstance(value, ChartArtifact)`, which a plain mock
    # would fail.
    chart = ChartArtifact(path=path, format="png", title=title, handle=handle)
    chart.read_bytes = MagicMock(return_value=data)  # type: ignore[method-assign]
    return chart


def _wire_charts(mock_session: MagicMock, charts: list[ChartArtifact]) -> None:
    """Wire a mock AsyncAgentSession's cache to serve `charts` consistently
    across list_charts()/has_handle()/get() — everything the endpoint and
    the inline ![title](handle) resolver touch."""
    by_handle = {c.handle: c for c in charts}
    mock_session.cache.list_charts = MagicMock(return_value=charts)
    mock_session.cache.has_handle = MagicMock(side_effect=lambda h: h in by_handle)
    mock_session.cache.get = MagicMock(side_effect=lambda h: by_handle[h])


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

def _fake_session_key() -> SessionKeyChoice:
    return SessionKeyChoice(user_id=1, api_key=None, is_byok=False)


def _fake_byok_session_key() -> SessionKeyChoice:
    return SessionKeyChoice(user_id=None, api_key="sk-test", is_byok=True)


@pytest.fixture
def client():
    _rate_limit_hits.clear()
    app.dependency_overrides[resolve_session_key] = _fake_session_key
    # _get_session's ownership check reads the real (cookie-backed) identity
    # via auth.current_user_id; pin it to match _fake_session_key's user_id
    # so tests exercise a session's owner, not a stranger.
    with patch("main.auth.current_user_id", return_value=1):
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
    assert '"type": "answer"' in events[3]
    assert '"type": "done"' in events[4]
    history = client.get(f"/sessions/{sid}").json()["messages"]
    assert history[-1]["role"] == "assistant"
    assert history[-1]["content"] == "# Result\nThe table has **2 rows**."


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
    assert '"type": "answer"' in events[4]
    assert '"type": "done"' in events[5]
    history = client.get(f"/sessions/{sid}").json()["messages"]
    assert history[-1]["role"] == "assistant"
    assert history[-1]["content"] == "# Summary\n- Done"


def test_stream_message_appends_to_history(client, session_id):
    resp = client.post(f"/sessions/{session_id}/messages/stream", json={"content": "go"})

    assert resp.status_code == 200
    history = client.get(f"/sessions/{session_id}").json()["messages"]
    assert history[-2]["role"] == "user"
    assert history[-2]["content"] == "go"
    assert history[-1]["role"] == "assistant"
    assert history[-1]["content"] == "mocked answer"


def test_send_message_appends_to_history(client, session_id):
    client.post(f"/sessions/{session_id}/messages", json={"content": "first"})
    client.post(f"/sessions/{session_id}/messages", json={"content": "second"})
    resp = client.get(f"/sessions/{session_id}")
    roles = [m["role"] for m in resp.json()["messages"]]
    # user + assistant + user + assistant
    assert roles.count("user") == 2
    assert roles.count("assistant") == 2


# ---------------------------------------------------------------------------
# Charts
# ---------------------------------------------------------------------------

def test_stream_message_emits_chart_event_with_url_not_bytes(client):
    mock_session = _mock_agent_session()
    chart = _mock_chart()

    async def ask_stream(_content):
        _wire_charts(mock_session, [chart])
        yield "Here's the chart."

    mock_session.ask_stream = ask_stream
    with patch("main._make_agent_session", return_value=mock_session):
        resp = client.post("/sessions")
        sid = resp.json()["id"]

    resp = client.post(f"/sessions/{sid}/messages/stream", json={"content": "plot it"})

    assert resp.status_code == 200
    events = [line for line in resp.text.splitlines() if line]
    chart_events = [e for e in events if '"type": "chart"' in e]
    assert len(chart_events) == 1
    assert f"/sessions/{sid}/charts/chart" in chart_events[0]
    # The raw bytes must never appear in the stream itself.
    assert "fake-png-bytes" not in resp.text

    history = client.get(f"/sessions/{sid}").json()["messages"]
    chart_message = history[-1]
    assert chart_message["image_url"] == f"/sessions/{sid}/charts/chart"
    assert chart_message["image_title"] == "Revenue by Month"
    assert chart_message.get("image_base64") is None


def test_send_message_includes_chart_when_produced(client):
    mock_session = _mock_agent_session()
    chart = _mock_chart()
    with patch("main._make_agent_session", return_value=mock_session):
        resp = client.post("/sessions")
        sid = resp.json()["id"]

    # The chart must only appear in list_charts() *after* ask_result runs,
    # same as a real turn — otherwise it'd already be in chart_paths_before
    # and get (correctly) treated as pre-existing, not new.
    original_result = mock_session.ask_result.return_value

    async def ask_result(_content):
        _wire_charts(mock_session, [chart])
        return original_result

    mock_session.ask_result = ask_result
    resp = client.post(f"/sessions/{sid}/messages", json={"content": "plot it"})

    assert resp.status_code == 200
    history = resp.json()["session"]["messages"]
    chart_message = history[-1]
    assert chart_message["image_url"] == f"/sessions/{sid}/charts/chart"
    assert chart_message["image_format"] == "png"


def test_get_chart_serves_bytes(client):
    mock_session = _mock_agent_session()
    chart = _mock_chart(data=b"\x89PNG-fake-bytes")
    _wire_charts(mock_session, [chart])
    with patch("main._make_agent_session", return_value=mock_session):
        resp = client.post("/sessions")
        sid = resp.json()["id"]

    resp = client.get(f"/sessions/{sid}/charts/chart")

    assert resp.status_code == 200
    assert resp.content == b"\x89PNG-fake-bytes"
    assert resp.headers["content-type"] == "image/png"
    assert "immutable" in resp.headers["cache-control"]


def test_get_chart_unknown_handle_returns_404(client, session_id):
    resp = client.get(f"/sessions/{session_id}/charts/nope")
    assert resp.status_code == 404


def test_get_chart_requires_session_ownership(client):
    mock_session = _mock_agent_session()
    _wire_charts(mock_session, [_mock_chart()])
    with patch("main._make_agent_session", return_value=mock_session):
        resp = client.post("/sessions")
        sid = resp.json()["id"]

    with patch("main.auth.current_user_id", return_value=2):
        resp = client.get(f"/sessions/{sid}/charts/chart")
    assert resp.status_code == 404


def test_inline_chart_reference_resolves_to_real_url_and_skips_duplicate_bubble(client):
    # The model referencing ![title](chart) inline in its own prose is the
    # whole point of this feature — the text must come back with a real URL
    # in place of the bare handle, and the chart must NOT also appear as a
    # second, separate trailing message (that's the pre-existing fallback
    # path for when the model doesn't reference it inline).
    mock_session = _mock_agent_session(
        answer="Here you go:\n\n![Revenue](chart)\n\nMay was the best month."
    )
    chart = _mock_chart()
    with patch("main._make_agent_session", return_value=mock_session):
        resp = client.post("/sessions")
        sid = resp.json()["id"]

    original_result = mock_session.ask_result.return_value

    async def ask_result(_content):
        _wire_charts(mock_session, [chart])
        return original_result

    mock_session.ask_result = ask_result
    resp = client.post(f"/sessions/{sid}/messages", json={"content": "plot it"})

    assert resp.status_code == 200
    body = resp.json()
    assert f"![Revenue](/sessions/{sid}/charts/chart)" in body["message"]["content"]

    # The chart is embedded inline in the text's own content above; it must
    # NOT also appear as a separate trailing image_url message (that's the
    # fallback path for when the model doesn't reference it inline).
    history = body["session"]["messages"]
    image_messages = [m for m in history if m.get("image_url")]
    assert image_messages == []


def test_unresolvable_inline_chart_reference_is_stripped(client):
    # A hallucinated or stale handle name must not survive into the response
    # as a markdown image pointing nowhere real (a permanently-broken <img>
    # is worse than no reference at all).
    mock_session = _mock_agent_session(
        answer="Here's the trend: ![Revenue](not_a_real_handle) as shown."
    )
    with patch("main._make_agent_session", return_value=mock_session):
        resp = client.post("/sessions")
        sid = resp.json()["id"]

    resp = client.post(f"/sessions/{sid}/messages", json={"content": "plot it"})

    assert resp.status_code == 200
    content = resp.json()["message"]["content"]
    assert "not_a_real_handle" not in content
    assert "![" not in content


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


def test_rate_limit_ignores_spoofable_forwarded_for(client):
    # X-Forwarded-For must NOT be trusted at all here (Render's own proxy
    # chain has an unpredictable number of hops - see _client_ip). A client
    # varying it should still land in one bucket, keyed off the transport
    # connection (or CF-Connecting-IP, checked separately below).
    with patch("main._make_agent_session", return_value=_mock_agent_session()):
        for i in range(20):
            resp = client.post(
                "/sessions", headers={"X-Forwarded-For": f"{i}.{i}.{i}.{i}"}
            )
            assert resp.status_code == 200
        blocked = client.post(
            "/sessions", headers={"X-Forwarded-For": "255.255.255.255"}
        )
    assert blocked.status_code == 429


def test_rate_limit_keys_on_cf_connecting_ip(client):
    # CF-Connecting-IP is the one header Cloudflare sets unconditionally and
    # a client can't override - two different values must get independent
    # buckets, and each bucket enforces its own limit.
    with patch("main._make_agent_session", return_value=_mock_agent_session()):
        for _ in range(20):
            resp = client.post("/sessions", headers={"CF-Connecting-IP": "1.1.1.1"})
            assert resp.status_code == 200
        blocked = client.post("/sessions", headers={"CF-Connecting-IP": "1.1.1.1"})
        assert blocked.status_code == 429

        other = client.post("/sessions", headers={"CF-Connecting-IP": "2.2.2.2"})
        assert other.status_code == 200


def test_budget_exhausted_blocks_new_session(client):
    # The client fixture overrides resolve_session_key wholesale so most
    # tests don't need real auth plumbing; this test needs the real
    # dependency (with auth.current_user_id already patched to 1 by the
    # fixture) to exercise its actual budget check.
    app.dependency_overrides.pop(resolve_session_key, None)
    try:
        with patch("main.budget.remaining_budget_cents", return_value=0.0):
            resp = client.post("/sessions")
        assert resp.status_code == 402
    finally:
        app.dependency_overrides[resolve_session_key] = _fake_session_key


def test_budget_exhausted_mid_session_blocks_message(client, session_id):
    with patch("main.budget.remaining_budget_cents", return_value=0.0):
        resp = client.post(
            f"/sessions/{session_id}/messages", json={"content": "still going?"}
        )
    assert resp.status_code == 402


def test_budget_exhausted_mid_session_blocks_stream(client, session_id):
    with patch("main.budget.remaining_budget_cents", return_value=0.0):
        resp = client.post(
            f"/sessions/{session_id}/messages/stream", json={"content": "still going?"}
        )
    assert resp.status_code == 402


def test_stranger_cannot_read_another_users_session(client, session_id):
    # session_id was created as user 1 (the fixture's default identity).
    # Anyone else authenticated as a different user must not be able to
    # read it via a bare session id.
    with patch("main.auth.current_user_id", return_value=2):
        resp = client.get(f"/sessions/{session_id}")
    assert resp.status_code == 404


def test_byok_session_has_no_ownership_check(client):
    app.dependency_overrides[resolve_session_key] = _fake_byok_session_key
    try:
        with patch("main._make_agent_session", return_value=_mock_agent_session()):
            resp = client.post("/sessions")
            sid = resp.json()["id"]
    finally:
        app.dependency_overrides[resolve_session_key] = _fake_session_key

    with patch("main.auth.current_user_id", return_value=None):
        resp = client.get(f"/sessions/{sid}")
    assert resp.status_code == 200


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
