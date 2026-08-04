"""Per-user monthly spend tracking against the shared DeepSeek key.

BYOK sessions never touch this — a user's own key is their own cost.
"""

from __future__ import annotations

import datetime as dt
import os

from data_harness import Usage
from sqlalchemy.orm import Session

from db import MonthlyUsage, User
from pricing import usage_cost_cents

MONTHLY_BUDGET_CENTS = float(os.environ.get("MONTHLY_BUDGET_CENTS", "50"))


def _current_month() -> str:
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m")


def get_or_create_user(
    db: Session, *, github_id: int, login: str, avatar_url: str | None
) -> User:
    user = db.query(User).filter_by(github_id=github_id).one_or_none()
    if user is None:
        user = User(github_id=github_id, login=login, avatar_url=avatar_url)
        db.add(user)
        db.commit()
        db.refresh(user)
    elif user.login != login or user.avatar_url != avatar_url:
        user.login = login
        user.avatar_url = avatar_url
        db.commit()
    return user


def get_user(db: Session, user_id: int) -> User | None:
    return db.get(User, user_id)


def _get_or_create_monthly_row(db: Session, user_id: int) -> MonthlyUsage:
    month = _current_month()
    row = db.query(MonthlyUsage).filter_by(user_id=user_id, month=month).one_or_none()
    if row is None:
        row = MonthlyUsage(user_id=user_id, month=month)
        db.add(row)
        db.commit()
        db.refresh(row)
    return row


def remaining_budget_cents(db: Session, user_id: int) -> float:
    row = _get_or_create_monthly_row(db, user_id)
    return max(0.0, MONTHLY_BUDGET_CENTS - row.cost_cents)


def record_usage(db: Session, user_id: int, usage: Usage) -> float:
    """Record usage against the shared-key budget; returns the cost in cents.

    Uses an in-database increment (not read-modify-write in Python) so
    concurrent turns for the same user can't clobber each other's usage —
    two overlapping streamed messages are a real scenario (a follow-up sent
    before the first finishes), not just a theoretical race.
    """
    row = _get_or_create_monthly_row(db, user_id)
    cost = usage_cost_cents(usage)
    db.query(MonthlyUsage).filter(MonthlyUsage.id == row.id).update(
        {
            MonthlyUsage.input_tokens: MonthlyUsage.input_tokens + usage.input_tokens,
            MonthlyUsage.output_tokens: MonthlyUsage.output_tokens + usage.output_tokens,
            MonthlyUsage.cost_cents: MonthlyUsage.cost_cents + cost,
        }
    )
    db.commit()
    return cost
