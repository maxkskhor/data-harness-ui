"""GitHub OAuth (Authorization Code flow) and session-cookie identity.

The cookie is a signed Starlette session (itsdangerous), not a JWT — it
holds nothing but a user id, and SessionMiddleware in main.py handles
signing/verification. SameSite=None + Secure is required because the
frontend (Vercel) and backend (Render) are on different origins.
"""

from __future__ import annotations

import os
import secrets
from urllib.parse import urlencode

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import RedirectResponse
from sqlalchemy.orm import Session

from budget import get_or_create_user
from db import get_db

router = APIRouter()

GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize"
GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token"
GITHUB_USER_URL = "https://api.github.com/user"


def _frontend_url() -> str:
    return os.environ.get("FRONTEND_URL", "http://localhost:3000")


def _client_id() -> str:
    value = os.environ.get("GITHUB_CLIENT_ID")
    if not value:
        raise HTTPException(status_code=503, detail="GitHub OAuth is not configured.")
    return value


def _client_secret() -> str:
    value = os.environ.get("GITHUB_CLIENT_SECRET")
    if not value:
        raise HTTPException(status_code=503, detail="GitHub OAuth is not configured.")
    return value


def _callback_url(request: Request) -> str:
    override = os.environ.get("GITHUB_CALLBACK_URL")
    if override:
        return override
    return str(request.url_for("github_callback"))


@router.get("/auth/github/login")
def github_login(request: Request) -> RedirectResponse:
    state = secrets.token_urlsafe(16)
    request.session["oauth_state"] = state
    params = {
        "client_id": _client_id(),
        "redirect_uri": _callback_url(request),
        "scope": "read:user",
        "state": state,
    }
    return RedirectResponse(f"{GITHUB_AUTHORIZE_URL}?{urlencode(params)}")


@router.get("/auth/github/callback", name="github_callback")
async def github_callback(
    request: Request,
    code: str | None = None,
    state: str | None = None,
    db: Session = Depends(get_db),
) -> RedirectResponse:
    expected_state = request.session.pop("oauth_state", None)
    if not code or not state or state != expected_state:
        raise HTTPException(status_code=400, detail="Invalid OAuth callback.")

    async with httpx.AsyncClient() as client:
        token_resp = await client.post(
            GITHUB_TOKEN_URL,
            headers={"Accept": "application/json"},
            data={
                "client_id": _client_id(),
                "client_secret": _client_secret(),
                "code": code,
                "redirect_uri": _callback_url(request),
            },
        )
        token_resp.raise_for_status()
        access_token = token_resp.json().get("access_token")
        if not access_token:
            raise HTTPException(status_code=400, detail="GitHub did not return an access token.")

        user_resp = await client.get(
            GITHUB_USER_URL,
            headers={"Authorization": f"Bearer {access_token}", "Accept": "application/json"},
        )
        user_resp.raise_for_status()
        profile = user_resp.json()

    user = get_or_create_user(
        db,
        github_id=profile["id"],
        login=profile["login"],
        avatar_url=profile.get("avatar_url"),
    )
    request.session["user_id"] = user.id
    return RedirectResponse(_frontend_url())


@router.post("/auth/logout")
def logout(request: Request) -> dict[str, bool]:
    request.session.clear()
    return {"ok": True}


def current_user_id(request: Request) -> int | None:
    return request.session.get("user_id")


def require_user_id(request: Request) -> int:
    user_id = current_user_id(request)
    if user_id is None:
        raise HTTPException(status_code=401, detail="Sign in with GitHub to continue.")
    return user_id
