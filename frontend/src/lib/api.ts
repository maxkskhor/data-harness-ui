export type ChatMessage = {
  role: "user" | "assistant";
  content: string;
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

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, init);
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const detail = body?.detail ?? `Request failed with ${response.status}`;
    throw new Error(detail);
  }
  return response.json() as Promise<T>;
}

export function createSession(): Promise<Session> {
  return request<Session>("/sessions", { method: "POST" });
}

export function getSession(sessionId: string): Promise<Session> {
  return request<Session>(`/sessions/${sessionId}`);
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
