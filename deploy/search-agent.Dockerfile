# syntax=docker/dockerfile:1.7

FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim AS builder

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy

WORKDIR /workspace/services/search-agent

COPY services/search-agent/pyproject.toml services/search-agent/uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project


FROM python:3.12-slim-bookworm AS runtime

ENV VIRTUAL_ENV=/workspace/services/search-agent/.venv \
    PATH=/workspace/services/search-agent/.venv/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

RUN groupadd --gid 10001 agent \
    && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin agent

WORKDIR /workspace/services/search-agent

COPY --from=builder --chown=agent:agent /workspace/services/search-agent/.venv ./.venv
COPY --chown=agent:agent services/search-agent/app ./app
COPY --chown=agent:agent database/migrations /workspace/database/migrations
COPY --chown=agent:agent deploy/ops /workspace/deploy/ops

USER 10001:10001

EXPOSE 8100

CMD ["python", "-m", "app.run"]
