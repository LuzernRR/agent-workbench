"""生产 Model Gateway 装配。"""

from __future__ import annotations

from functools import cache

from app.config.runtime import runtime_config
from app.llm.deepseek import DeepSeekProviderAdapter
from app.llm.gateway import DefaultModelGateway
from app.reliability.retry import RetryPolicy


@cache
def model_gateway() -> DefaultModelGateway:
    config = runtime_config()
    fallbacks = {
        model.id: (model.fallback_model,)
        for model in config.models
        if model.fallback_model is not None
    }
    return DefaultModelGateway(
        DeepSeekProviderAdapter(),
        retry_policy=RetryPolicy(
            max_attempts=config.max_retries + 1,
            max_elapsed_seconds=config.timeout_seconds,
        ),
        fallback_models=fallbacks,
    )
