FROM python:3.11-slim

RUN pip install --no-cache-dir uv

WORKDIR /app

COPY . .
RUN uv sync --frozen --no-dev

ENV PORT=8000
EXPOSE 8000

CMD ["sh", "-c", "uv run uvicorn main:app --host 0.0.0.0 --port ${PORT}"]
