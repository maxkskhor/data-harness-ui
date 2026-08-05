export type ChatMessage = {
  role: "user" | "assistant" | "tool";
  content: string;
  kind?: "tool_use" | "tool_result";
  title?: string;
  isError?: boolean;
  image_url?: string | null;
  image_format?: string | null;
  image_title?: string | null;
};

export type UploadSummary = {
  handle: string;
  filename: string;
  rows: number;
  columns: string[];
  preview: Record<string, unknown>[];
};

export type Session = {
  id: string;
  messages: ChatMessage[];
  uploads: UploadSummary[];
};

export type Me = {
  login: string | null;
  avatar_url: string | null;
  budget_remaining_cents: number | null;
  budget_total_cents: number;
};

export type CacheHandleInfo = {
  name: string;
  snapshot: string;
  location: "memory" | "disk";
  storage_type: string;
};

export type SessionContext = {
  turns_used: number;
  max_turns: number;
  messages: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  handles: CacheHandleInfo[];
};

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000";

/** Resolve a backend-relative path (e.g. a chart's `image_url`) to an absolute URL. */
export function apiUrl(path: string): string {
  return `${API_BASE_URL}${path}`;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    credentials: "include",
    ...init,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const detail = body?.detail ?? `Request failed with ${response.status}`;
    throw new Error(detail);
  }
  return response.json() as Promise<T>;
}

export function getMe(): Promise<Me> {
  return request<Me>("/auth/me");
}

export function githubLoginUrl(): string {
  return `${API_BASE_URL}/auth/github/login`;
}

export function logout(): Promise<void> {
  return request("/auth/logout", { method: "POST" });
}

export function createSession(byokKey?: string): Promise<Session> {
  return request<Session>("/sessions", {
    method: "POST",
    headers: byokKey ? { "X-User-Deepseek-Key": byokKey } : undefined,
  });
}

export function getSession(sessionId: string): Promise<Session> {
  return request<Session>(`/sessions/${sessionId}`);
}

export function getSessionContext(sessionId: string): Promise<SessionContext> {
  return request<SessionContext>(`/sessions/${sessionId}/context`);
}

export async function getSessionTree(sessionId: string): Promise<string> {
  const response = await fetch(`${API_BASE_URL}/sessions/${sessionId}/tree`, {
    credentials: "include",
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.detail ?? `Request failed with ${response.status}`);
  }
  return response.text();
}

export function uploadDataset(
  sessionId: string,
  file: File,
): Promise<UploadSummary> {
  const formData = new FormData();
  formData.append("file", file);
  return request<UploadSummary>(`/sessions/${sessionId}/uploads`, {
    method: "POST",
    body: formData,
  });
}

export async function sendMessage(
  sessionId: string,
  content: string,
): Promise<Session> {
  const result = await request<{ session: Session }>(
    `/sessions/${sessionId}/messages`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    },
  );
  return result.session;
}

type StreamEvent =
  | { type: "chunk"; data: string }
  | { type: "tool_use"; data: ToolUseEvent }
  | { type: "tool_result"; data: ToolResultEvent }
  | { type: "chart"; data: ChartEvent }
  | { type: "answer"; data: string }
  | { type: "error"; data: string }
  | { type: "done"; data: Session };

export type ToolUseEvent = {
  id?: string;
  name?: string;
  input?: unknown;
};

export type ToolResultEvent = {
  id?: string;
  content?: string;
  is_error?: boolean;
};

export type ChartEvent = {
  url: string;
  format: string;
  title?: string | null;
};

export class StreamAborted extends Error {}

export async function streamMessage(
  sessionId: string,
  content: string,
  onEvent: (event: Exclude<StreamEvent, { type: "done" }>) => void,
  signal?: AbortSignal,
): Promise<Session> {
  const response = await fetch(
    `${API_BASE_URL}/sessions/${sessionId}/messages/stream`,
    {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
      signal,
    },
  );

  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const detail = body?.detail ?? `Request failed with ${response.status}`;
    throw new Error(detail);
  }

  if (!response.body) {
    throw new Error("Streaming response was empty.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finalSession: Session | null = null;

  while (true) {
    let done: boolean;
    let value: Uint8Array | undefined;
    try {
      ({ done, value } = await reader.read());
    } catch (err) {
      if (signal?.aborted) {
        await reader.cancel().catch(() => undefined);
        throw new StreamAborted("Streaming was stopped.");
      }
      throw err;
    }
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      const event = JSON.parse(line) as StreamEvent;
      if (event.type === "done") {
        finalSession = event.data;
      } else {
        onEvent(event);
      }
    }
  }

  buffer += decoder.decode();
  if (buffer.trim()) {
    const event = JSON.parse(buffer) as StreamEvent;
    if (event.type === "done") {
      finalSession = event.data;
    } else {
      onEvent(event);
    }
  }

  if (!finalSession) {
    throw new Error("Streaming response ended without a final session.");
  }
  return finalSession;
}
