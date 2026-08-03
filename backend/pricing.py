"""DeepSeek cost accounting.

Prices are per-million-tokens in USD cents, overridable via env vars so a
provider price change doesn't need a code deploy. Verify current rates at
https://api-docs.deepseek.com/quick_start/pricing/ before trusting these
defaults for anything beyond a small demo budget.
"""

from __future__ import annotations

import os

from data_harness.result import Usage

DEFAULT_INPUT_CENTS_PER_MILLION = 14.0
DEFAULT_OUTPUT_CENTS_PER_MILLION = 28.0
DEFAULT_CACHE_READ_CENTS_PER_MILLION = 0.3


def _price(env_var: str, default: float) -> float:
    raw = os.environ.get(env_var)
    if not raw:
        return default
    try:
        return float(raw)
    except ValueError:
        return default


def usage_cost_cents(usage: Usage) -> float:
    input_price = _price("DEEPSEEK_INPUT_CENTS_PER_MILLION", DEFAULT_INPUT_CENTS_PER_MILLION)
    output_price = _price("DEEPSEEK_OUTPUT_CENTS_PER_MILLION", DEFAULT_OUTPUT_CENTS_PER_MILLION)
    cache_price = _price(
        "DEEPSEEK_CACHE_READ_CENTS_PER_MILLION", DEFAULT_CACHE_READ_CENTS_PER_MILLION
    )

    cache_read = min(usage.cache_read_tokens, usage.input_tokens)
    fresh_input = usage.input_tokens - cache_read

    return (
        fresh_input * input_price / 1_000_000
        + cache_read * cache_price / 1_000_000
        + usage.output_tokens * output_price / 1_000_000
    )
