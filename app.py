from __future__ import annotations

import html
import hmac
import json
import logging
import os
import random
import re
import signal
import threading
import time
from datetime import datetime, timedelta, timezone
from hashlib import sha256
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qsl, quote, unquote, urlsplit
from urllib.request import Request, urlopen


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)
log = logging.getLogger("zeno-wallet")
ADMIN_ID = 5814345235
SEASON_CHANNEL_ID = os.getenv("SEASON_CHANNEL_ID", "-1004423195226")
WEBAPP_DIR = Path(__file__).resolve().parent / "webapp"
SEASON_ACTIVITY_POINTS = 1
SEASON_CASE_POINTS = 5
CASE_REWARDS = (0, 5, 10, 25, 50, 100)
DEFAULT_CASE_SETTINGS = {
    "odds": {"0": 55, "5": 15, "10": 12, "25": 8, "50": 6, "100": 4},
    "hourly_limit": 5,
}


def resolve_webapp_url() -> str:
    configured_url = os.getenv("WEBAPP_URL", "").strip().rstrip("/")
    if not configured_url:
        return ""

    hostname = (urlsplit(configured_url).hostname or "").lower()
    if hostname == "replit.dev" or hostname.endswith(".replit.dev"):
        return ""
    if hostname == "replit.app" or hostname.endswith(".replit.app"):
        return ""
    return configured_url


WEBAPP_URL = resolve_webapp_url()
WEB_ONLY = os.getenv("WEB_ONLY", "").strip().lower() in {"1", "true", "yes", "on"}


def required_env(name: str) -> str:
    value = os.getenv(name)
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


class SupabaseClient:
    def __init__(self) -> None:
        self.base_url = required_env("SUPABASE_URL").rstrip("/")
        self.key = required_env("SUPABASE_KEY")

    def request(
        self,
        path: str,
        method: str = "GET",
        body: Any | None = None,
        prefer: str | None = None,
    ) -> Any:
        headers = {
            "apikey": self.key,
            "Authorization": f"Bearer {self.key}",
            "Content-Type": "application/json",
        }
        if prefer:
            headers["Prefer"] = prefer

        data = None if body is None else json.dumps(body).encode("utf-8")
        request = Request(
            f"{self.base_url}/rest/v1/{path}",
            data=data,
            headers=headers,
            method=method,
        )
        try:
            with urlopen(request, timeout=30) as response:
                raw = response.read()
                if not raw:
                    return None
                return json.loads(raw.decode("utf-8"))
        except HTTPError as error:
            details = error.reason
            try:
                payload = error.read().decode("utf-8")
                parsed = json.loads(payload)
                details = (
                    parsed.get("message")
                    or parsed.get("details")
                    or parsed.get("hint")
                    or details
                )
            except (OSError, UnicodeDecodeError, json.JSONDecodeError):
                pass
            raise RuntimeError(
                f"Supabase request failed ({error.code}): {details}"
            ) from error
        except URLError as error:
            raise RuntimeError(f"Supabase connection failed: {error.reason}") from error

    def get_wallet(self, user_id: int) -> dict[str, Any] | None:
        rows = self.request(
            "wallet?"
            "select=user_id,earn_balance,zeno_balance,updated_at,"
            "daily_claimed_at,referred_by,referral_rewarded"
            f"&user_id=eq.{user_id}&limit=1"
        )
        return rows[0] if rows else None

    def create_wallet(self, user_id: int) -> dict[str, Any]:
        rows = self.request(
            "wallet",
            method="POST",
            body={"user_id": user_id, "earn_balance": 0, "zeno_balance": 0},
            prefer="return=representation",
        )
        return rows[0]

    def ensure_wallet(self, user_id: int) -> dict[str, Any]:
        wallet = self.get_wallet(user_id)
        if wallet:
            return wallet
        try:
            return self.create_wallet(user_id)
        except RuntimeError:
            wallet = self.get_wallet(user_id)
            if wallet:
                return wallet
            raise

    def update_wallet(
        self, user_id: int, values: dict[str, Any]
    ) -> dict[str, Any]:
        payload = {**values, "updated_at": datetime.now(timezone.utc).isoformat()}
        rows = self.request(
            f"wallet?user_id=eq.{user_id}",
            method="PATCH",
            body=payload,
            prefer="return=representation",
        )
        if not rows:
            raise RuntimeError(f"Wallet update returned no row for user {user_id}")
        return rows[0]

    def get_users_state(self) -> dict[str, Any]:
        rows = self.request(
            "bot_state?select=state_value&state_key=eq.users&limit=1"
        )
        if not rows:
            raise RuntimeError("Supabase bot_state row state_key=users was not found")
        state = rows[0].get("state_value")
        if not isinstance(state, dict):
            raise RuntimeError("Supabase bot_state.users must contain a JSON object")
        return state

    def ensure_user_state(self, user_id: int) -> None:
        state = self.get_users_state()
        key = str(user_id)
        current = state.get(key)
        if isinstance(current, dict):
            return
        state[key] = {"zenotoken": 0}
        self.update_users_state(state)

    def update_users_state(self, state: dict[str, Any]) -> None:
        self.request(
            "bot_state?state_key=eq.users",
            method="PATCH",
            body={"state_value": state},
            prefer="return=minimal",
        )

    def get_case_settings(self) -> dict[str, Any]:
        rows = self.request(
            "bot_state?select=state_value&state_key=eq.case_settings&limit=1"
        )
        if not rows:
            try:
                rows = self.request(
                    "bot_state",
                    method="POST",
                    body={
                        "state_key": "case_settings",
                        "state_value": DEFAULT_CASE_SETTINGS,
                    },
                    prefer="return=representation",
                )
            except RuntimeError:
                rows = self.request(
                    "bot_state?select=state_value&state_key=eq.case_settings&limit=1"
                )
        raw = rows[0].get("state_value") if rows else {}
        raw_odds = (
            raw.get("odds")
            if isinstance(raw, dict) and isinstance(raw.get("odds"), dict)
            else {}
        )
        odds = {
            str(reward): int(raw_odds.get(str(reward), DEFAULT_CASE_SETTINGS["odds"][str(reward)]))
            for reward in CASE_REWARDS
        }
        try:
            limit = (
                int(raw.get("hourly_limit", DEFAULT_CASE_SETTINGS["hourly_limit"]))
                if isinstance(raw, dict)
                else DEFAULT_CASE_SETTINGS["hourly_limit"]
            )
        except (TypeError, ValueError):
            limit = DEFAULT_CASE_SETTINGS["hourly_limit"]
        if sum(odds.values()) != 100 or limit < 1:
            return {
                "odds": dict(DEFAULT_CASE_SETTINGS["odds"]),
                "hourly_limit": DEFAULT_CASE_SETTINGS["hourly_limit"],
            }
        return {"odds": odds, "hourly_limit": limit}

    def update_case_settings(
        self, odds: dict[str, int] | None = None, hourly_limit: int | None = None
    ) -> dict[str, Any]:
        current = self.get_case_settings()
        settings = {
            "odds": odds if odds is not None else current["odds"],
            "hourly_limit": hourly_limit
            if hourly_limit is not None
            else current["hourly_limit"],
        }
        self.request(
            "bot_state?state_key=eq.case_settings",
            method="PATCH",
            body={"state_value": settings},
            prefer="return=minimal",
        )
        return settings

    def _rpc(self, function: str, body: dict[str, Any]) -> Any:
        return self.request(f"rpc/{function}", method="POST", body=body)

    @staticmethod
    def _rpc_object(value: Any) -> dict[str, Any]:
        if isinstance(value, dict):
            return value
        if isinstance(value, list) and value and isinstance(value[0], dict):
            return value[0]
        return {}

    def finalize_expired_season(self, force: bool = False) -> dict[str, Any]:
        return self._rpc_object(
            self._rpc("season_finalize_expired", {"p_force": force})
        )

    def get_active_season(self) -> dict[str, Any] | None:
        rows = self.request(
            "seasons?"
            "select=id,season_number,starts_at,ends_at,status"
            "&status=eq.active&order=starts_at.desc&limit=1"
        )
        return rows[0] if rows else None

    def set_season_number(self, season_number: int) -> dict[str, Any]:
        return self._rpc_object(
            self._rpc(
                "season_set_number",
                {"p_season_number": season_number},
            )
        )

    def ensure_active_season(self) -> dict[str, Any]:
        self.finalize_expired_season()
        season = self.get_active_season()
        if season:
            return season
        result = self._rpc_object(self._rpc("season_ensure_active", {}))
        season_id = result.get("season_id")
        if not season_id:
            raise RuntimeError("Could not create an active season")
        season = self.get_active_season()
        if not season:
            raise RuntimeError("Active season was not returned after creation")
        return season

    def add_season_points(
        self,
        user_id: int,
        username: str | None,
        display_name: str,
        activity_points: int = 0,
        case_points: int = 0,
    ) -> dict[str, Any]:
        result = self._rpc_object(self._rpc("season_add_points", {
            "p_user_id": user_id,
            "p_username": username,
            "p_display_name": display_name,
            "p_activity_points": activity_points,
            "p_case_points": case_points,
        }))
        if result.get("expired"):
            self.finalize_expired_season()
            result = self._rpc_object(self._rpc("season_add_points", {
                "p_user_id": user_id,
                "p_username": username,
                "p_display_name": display_name,
                "p_activity_points": activity_points,
                "p_case_points": case_points,
            }))
        return result

    def get_season_scores(self, season_id: int) -> list[dict[str, Any]]:
        return self.request(
            "season_scores?"
            "select=user_id,username,display_name,points,activity_count,"
            f"cases_opened,updated_at&season_id=eq.{season_id}"
            "&order=points.desc,updated_at.asc,user_id.asc&limit=10000"
        )

    def get_season_rewards(self, season_id: int) -> list[dict[str, Any]]:
        return self.request(
            "season_rewards?"
            "select=place,user_id,username,display_name,token_reward,bonus_reward"
            f"&season_id=eq.{season_id}&order=place.asc&limit=10"
        )

    def get_pending_season_announcements(self) -> list[dict[str, Any]]:
        return self.request(
            "seasons?"
            "select=id,season_number,starts_at,ends_at"
            "&status=eq.finished&announcement_sent_at=is.null"
            "&order=ends_at.asc&limit=10"
        )

    def mark_season_announced(self, season_id: int) -> None:
        self.request(
            f"seasons?id=eq.{season_id}",
            method="PATCH",
            body={"announcement_sent_at": datetime.now(timezone.utc).isoformat()},
            prefer="return=minimal",
        )

    def open_case(
        self, user_id: int
    ) -> tuple[bool, int | None, dict[str, Any], int, datetime | None]:
        settings = self.get_case_settings()
        wallet = self.ensure_wallet(user_id)
        users_state = self.get_users_state()
        user_key = str(user_id)
        previous_user = users_state.get(user_key)
        user_state = dict(previous_user) if isinstance(previous_user, dict) else {}
        now = datetime.now(timezone.utc)
        cutoff = now - timedelta(hours=1)
        recent_attempts: list[str] = []
        for raw_timestamp in user_state.get("case_attempts", []):
            try:
                timestamp = datetime.fromisoformat(
                    str(raw_timestamp).replace("Z", "+00:00")
                )
                if timestamp > cutoff:
                    recent_attempts.append(timestamp.isoformat())
            except (TypeError, ValueError):
                continue

        if len(recent_attempts) >= settings["hourly_limit"]:
            oldest = min(
                datetime.fromisoformat(value.replace("Z", "+00:00"))
                for value in recent_attempts
            )
            return (
                False,
                None,
                wallet,
                0,
                oldest + timedelta(hours=1),
            )

        recent_attempts.append(now.isoformat())
        users_state[user_key] = {**user_state, "case_attempts": recent_attempts}
        self.update_users_state(users_state)

        roll = random.uniform(0, 100)
        cursor = 0.0
        reward = 0
        for candidate in CASE_REWARDS:
            cursor += settings["odds"][str(candidate)]
            if roll < cursor:
                reward = candidate
                break
        if reward:
            wallet = self.credit(user_id, reward)
        return (
            True,
            reward,
            wallet,
            settings["hourly_limit"] - len(recent_attempts),
            None,
        )

    def list_user_ids(self) -> list[int]:
        state = self.get_users_state()
        result: list[int] = []
        for key in state:
            if str(key).isdigit():
                result.append(int(key))
        return result

    def is_banned(self, user_id: int) -> bool:
        state = self.get_users_state()
        user = state.get(str(user_id))
        return isinstance(user, dict) and user.get("banned") is True

    def set_banned(self, user_id: int, banned: bool) -> None:
        state = self.get_users_state()
        key = str(user_id)
        user = state.get(key)
        user_state = dict(user) if isinstance(user, dict) else {"zenotoken": 0}
        user_state["banned"] = banned
        state[key] = user_state
        self.update_users_state(state)

    def get_all_wallets(self) -> list[dict[str, Any]]:
        return self.request(
            "wallet?select=user_id,earn_balance,zeno_balance&limit=10000"
        )

    def admin_adjust_earn(self, user_id: int, amount: int) -> dict[str, Any]:
        wallet = self.ensure_wallet(user_id)
        next_balance = int(wallet["earn_balance"]) + amount
        if next_balance < 0:
            raise ValueError(
                f"У пользователя только {wallet['earn_balance']} заработанных монет"
            )
        return self.update_wallet(user_id, {"earn_balance": next_balance})

    def admin_stats(self) -> tuple[int, int]:
        users_state = self.get_users_state()
        wallets = self.get_all_wallets()
        total_earn = sum(int(wallet.get("earn_balance", 0)) for wallet in wallets)
        total_zeno = 0
        for user in users_state.values():
            if isinstance(user, dict):
                value = user.get("zenotoken", 0)
                if isinstance(value, (int, float)) and value >= 0:
                    total_zeno += int(value)
        return len(self.list_user_ids()), total_earn + total_zeno

    def get_zeno_balance(self, user_id: int) -> int:
        state = self.get_users_state()
        user = state.get(str(user_id))
        if not isinstance(user, dict):
            return 0
        value = user.get("zenotoken", 0)
        return int(value) if isinstance(value, (int, float)) and value >= 0 else 0

    def credit(self, user_id: int, amount: int) -> dict[str, Any]:
        wallet = self.ensure_wallet(user_id)
        return self.update_wallet(
            user_id, {"earn_balance": int(wallet["earn_balance"]) + amount}
        )

    def claim_daily(
        self, user_id: int
    ) -> tuple[bool, dict[str, Any], datetime | None]:
        wallet = self.ensure_wallet(user_id)
        raw_last_claim = wallet.get("daily_claimed_at")
        if raw_last_claim:
            last_claim = datetime.fromisoformat(
                str(raw_last_claim).replace("Z", "+00:00")
            )
            next_available = last_claim + timedelta(hours=24)
            if datetime.now(timezone.utc) < next_available:
                return False, wallet, next_available

        claimed_at = datetime.now(timezone.utc)
        updated = self.update_wallet(
            user_id,
            {
                "earn_balance": int(wallet["earn_balance"]) + 10,
                "daily_claimed_at": claimed_at.isoformat(),
            },
        )
        return True, updated, None

    def claim_referral(self, inviter_id: int, friend_id: int) -> bool:
        friend = self.ensure_wallet(friend_id)
        if (
            inviter_id == friend_id
            or friend.get("referred_by") is not None
            or friend.get("referral_rewarded")
        ):
            return False

        self.update_wallet(
            friend_id,
            {"referred_by": inviter_id, "referral_rewarded": True},
        )
        self.credit(inviter_id, 5)
        return True

    def withdraw(
        self, user_id: int, amount: int
    ) -> tuple[bool, dict[str, Any], int | None]:
        wallet = self.ensure_wallet(user_id)
        earn_balance = int(wallet["earn_balance"])
        if earn_balance < amount:
            return False, wallet, None

        users_state = self.get_users_state()
        user_key = str(user_id)
        previous_user = users_state.get(user_key)
        user_state = dict(previous_user) if isinstance(previous_user, dict) else {}
        current_zeno = user_state.get("zenotoken", 0)
        if not isinstance(current_zeno, (int, float)) or current_zeno < 0:
            current_zeno = 0
        next_zeno = current_zeno + amount
        next_state = dict(users_state)
        next_state[user_key] = {**user_state, "zenotoken": next_zeno}
        self.update_users_state(next_state)

        try:
            updated_wallet = self.update_wallet(
                user_id, {"earn_balance": earn_balance - amount}
            )
            return True, updated_wallet, next_zeno
        except Exception:
            rollback = dict(users_state)
            if previous_user is None:
                rollback.pop(user_key, None)
            else:
                rollback[user_key] = previous_user
            try:
                self.update_users_state(rollback)
            except Exception:
                log.exception("Could not roll back bot_state after wallet failure")
            raise

    def get_active_crash_game(self, user_id: int) -> dict[str, Any] | None:
        rows = self.request(
            "games?"
            "select=id,user_id,game_name,bet,multiplier,result,created_at,"
            "started_at,crash_at,payout"
            f"&user_id=eq.{user_id}&game_name=eq.rocket&result=eq.active"
            "&order=created_at.desc&limit=1"
        )
        return rows[0] if rows else None

    def get_crash_history(self, user_id: int) -> list[dict[str, Any]]:
        return self.request(
            "games?"
            "select=id,bet,multiplier,result,created_at,payout"
            f"&user_id=eq.{user_id}&game_name=eq.rocket&result=in.(won,lost)"
            "&order=created_at.desc&limit=10"
        )

    def start_crash_game(self, user_id: int, bet: int) -> dict[str, Any]:
        if bet <= 0:
            raise ValueError("Ставка должна быть больше нуля")
        crash_at = round(1.5 + (random.random() ** 2.7) * 8.5, 2)
        return self._rpc_object(
            self._rpc(
                "crash_start",
                {
                    "p_user_id": user_id,
                    "p_bet": bet,
                    "p_crash_at": crash_at,
                },
            )
        )

    def cashout_crash_game(self, user_id: int, game_id: int) -> dict[str, Any]:
        if game_id <= 0:
            raise ValueError("Некорректный раунд")
        return self._rpc_object(
            self._rpc(
                "crash_cashout",
                {"p_user_id": user_id, "p_game_id": game_id},
            )
        )

    def settle_crash_game(self, user_id: int, game_id: int) -> dict[str, Any]:
        if game_id <= 0:
            raise ValueError("Некорректный раунд")
        return self._rpc_object(
            self._rpc(
                "crash_settle_loss",
                {"p_user_id": user_id, "p_game_id": game_id},
            )
        )

    def resolve_active_crash_game(self, user_id: int) -> dict[str, Any] | None:
        active = self.get_active_crash_game(user_id)
        if not active:
            return None
        started_at = datetime.fromisoformat(
            str(active["started_at"]).replace("Z", "+00:00")
        )
        elapsed = max(0.0, (datetime.now(timezone.utc) - started_at).total_seconds())
        current_multiplier = round(
            1.0 + (0.42 * elapsed) + (0.045 * elapsed * elapsed),
            2,
        )
        if current_multiplier >= float(active["crash_at"]):
            self.settle_crash_game(user_id, int(active["id"]))
            return None
        return active


class TelegramApi:
    def __init__(self, token: str) -> None:
        self.token = token
        self.base_url = f"https://api.telegram.org/bot{token}"

    def call(
        self,
        method: str,
        body: dict[str, Any] | None = None,
        timeout: int = 40,
    ) -> Any:
        request = Request(
            f"{self.base_url}/{method}",
            data=json.dumps(body or {}).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urlopen(request, timeout=timeout) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except HTTPError as error:
            details: Any = error.reason
            try:
                payload = json.loads(error.read().decode("utf-8"))
                details = payload.get("description") or details
            except (OSError, UnicodeDecodeError, json.JSONDecodeError):
                pass
            raise RuntimeError(
                f"Telegram {method} request failed ({error.code}): {details}"
            ) from error
        except (URLError, TimeoutError) as error:
            raise RuntimeError(f"Telegram {method} request failed: {error}") from error
        if not payload.get("ok"):
            raise RuntimeError(
                f"Telegram {method} failed: {payload.get('description', 'unknown error')}"
            )
        return payload.get("result")

    def get_me(self) -> dict[str, Any]:
        return self.call("getMe")

    def set_my_commands(self) -> None:
        self.call(
            "setMyCommands",
            {
                "commands": [
                    {
                        "command": "start",
                        "description": "Открыть главное меню",
                    },
                    {
                        "command": "season",
                        "description": "Текущий сезон и мой прогресс",
                    },
                    {
                        "command": "season_top",
                        "description": "Топ-10 сезона",
                    },
                    {
                        "command": "menu",
                        "description": "Показать меню",
                    },
                    {
                        "command": "app",
                        "description": "Открыть мини-апп",
                    },
                ]
            },
        )

    def delete_webhook(self) -> None:
        self.call("deleteWebhook", {"drop_pending_updates": False})

    def get_updates(self, offset: int) -> list[dict[str, Any]]:
        return self.call(
            "getUpdates",
            {
                "offset": offset,
                "timeout": 25,
                "allowed_updates": ["message", "callback_query"],
            },
            timeout=35,
        )

    def answer_callback(self, callback_id: str) -> None:
        self.call("answerCallbackQuery", {"callback_query_id": callback_id})

    def send_dice(self, chat_id: int) -> None:
        self.call("sendDice", {"chat_id": chat_id, "emoji": "🎰"})

    def send_message(
        self,
        chat_id: int,
        text: str,
        reply_markup: dict[str, Any] | None = None,
    ) -> None:
        body: dict[str, Any] = {
            "chat_id": chat_id,
            "text": text,
            "parse_mode": "HTML",
            "disable_web_page_preview": True,
        }
        if reply_markup is not None:
            body["reply_markup"] = reply_markup
        self.call("sendMessage", body)


def parse_command(text: str) -> tuple[str, list[str]]:
    pieces = text.strip().split()
    if not pieces:
        return "", []
    command = pieces[0].split("@", 1)[0].lower().lstrip("/")
    return command, pieces[1:]


def parse_amount(value: str | None) -> int | None:
    if not value or not re.fullmatch(r"\d+", value):
        return None
    amount = int(value)
    return amount if amount > 0 else None


def referral_id(args: list[str]) -> int | None:
    if not args or not args[0].startswith("ref_"):
        return None
    value = args[0][4:]
    return int(value) if value.isdigit() and int(value) > 0 else None


def format_wallet(wallet: dict[str, Any], zeno_balance: int | float) -> str:
    earn_balance = int(wallet["earn_balance"])
    zeno_value = int(zeno_balance)
    return (
        "<b>💳 МОЙ КОШЕЛЁК</b>\n"
        "<i>Все балансы в одном месте</i>\n\n"
        "┌ <b>Основной баланс</b>\n"
        f"└ <code>{earn_balance:,}</code> монет\n"
        "<i>Доступно для вывода в Zeno</i>\n\n"
        "┌ <b>Zeno</b>\n"
        f"└ <code>{zeno_value:,}</code> монет\n"
        "<i>Баланс в Zeno Wallet</i>"
    ).replace(",", " ")


def progress_bar(percent: int, width: int = 10) -> str:
    filled = max(0, min(width, round(percent / 100 * width)))
    return "▰" * filled + "▱" * (width - filled)


def menu_keyboard(is_admin: bool = False) -> dict[str, Any]:
    keyboard = [
        *(
            [[
                {
                    "text": "🚀 Открыть мини-апп",
                    "web_app": {"url": WEBAPP_URL},
                }
            ]]
            if WEBAPP_URL
            else []
        ),
        [{"text": "🎁 Открыть кейс"}, {"text": "☀️ Ежедневный бонус"}],
        [{"text": "💳 Мой баланс"}, {"text": "👥 Пригласить друзей"}],
        [{"text": "📤 Вывести монеты"}],
        [{"text": "🏆 Сезон"}, {"text": "📊 Топ сезона"}],
    ]
    if is_admin:
        keyboard.append([{"text": "⚙️ Админ-панель"}])
    return {
        "keyboard": keyboard,
        "resize_keyboard": True,
        # Let Telegram collapse the reply keyboard and show its native
        # keyboard toggle in the composer instead of forcing it open.
        "is_persistent": False,
        "input_field_placeholder": "Выберите раздел",
    }

WITHDRAW_KEYBOARD = {
    "inline_keyboard": [
        [
            {"text": "10 монет", "callback_data": "withdraw:10"},
            {"text": "50 монет", "callback_data": "withdraw:50"},
            {"text": "100 монет", "callback_data": "withdraw:100"},
        ],
        [
            {"text": "200 монет", "callback_data": "withdraw:200"},
            {"text": "✎ Своя сумма", "callback_data": "withdraw:custom"},
        ],
    ]
}

ADMIN_KEYBOARD = {
    "inline_keyboard": [
        [
            {"text": "➕ Выдать валюту", "callback_data": "admin:grant"},
            {"text": "➖ Забрать валюту", "callback_data": "admin:take"},
        ],
        [
            {"text": "👤 Баланс пользователя", "callback_data": "admin:balance"},
            {"text": "👥 Пользователи", "callback_data": "admin:users"},
        ],
        [
            {"text": "💰 Всего валюты", "callback_data": "admin:total"},
        ],
        [
            {"text": "📣 Рассылка всем", "callback_data": "admin:broadcast"},
        ],
        [
            {"text": "🎁 Настройки кейсов", "callback_data": "admin:case_settings"},
        ],
        [
            {"text": "🏆 Завершить сезон", "callback_data": "admin:season_finish"},
            {"text": "№ Изменить сезон", "callback_data": "admin:season_number"},
        ],
        [
            {"text": "🔒 Заблокировать", "callback_data": "admin:ban"},
            {"text": "🔓 Разблокировать", "callback_data": "admin:unban"},
        ],
        [{"text": "‹ Закрыть панель", "callback_data": "admin:close"}],
    ]
}

SEASON_FINISH_CONFIRM_KEYBOARD = {
    "inline_keyboard": [
        [
            {"text": "✓ Да, завершить", "callback_data": "admin:season_finish_confirm"},
            {"text": "× Отмена", "callback_data": "admin:season_finish_cancel"},
        ]
    ]
}

BUTTON_ACTIONS = {
    "🎁 Открыть кейс": "case",
    "☀️ Ежедневный бонус": "daily",
    "💳 Мой баланс": "balance",
    "👥 Пригласить друзей": "referral",
    "📤 Вывести монеты": "withdraw_menu",
    "🏆 Сезон": "season",
    "📊 Топ сезона": "season_top",
    "⚙️ Админ-панель": "admin_menu",
    # Keep the previous labels valid for users with an older keyboard.
    "Открыть кейс": "case",
    "Ежедневный бонус": "daily",
    "Мой баланс": "balance",
    "Пригласить друзей": "referral",
    "Вывести монеты": "withdraw_menu",
    "Админ-панель": "admin_menu",
}


HELP_TEXT = (
    "<b>✦ ZENO WALLET</b>\n"
    "<i>Награды. Баланс. Zeno.</i>\n\n"
    "<b>Что здесь можно делать</b>\n"
    "🎁 Открывать кейсы и забирать награды\n"
    "☀️ Получать ежедневный бонус\n"
    "🏆 Участвовать в сезонном рейтинге\n"
    "📤 Переводить заработанные монеты в Zeno\n\n"
    "<i>Выберите раздел в меню ниже.</i>"
)


def format_duration(delta: timedelta) -> str:
    minutes = max(1, int((delta.total_seconds() + 59) // 60))
    hours, remaining = divmod(minutes, 60)
    if hours == 0:
        return f"{remaining} мин."
    return f"{hours} ч." if remaining == 0 else f"{hours} ч. {remaining} мин."


def format_season_remaining(delta: timedelta) -> str:
    seconds = max(0, int(delta.total_seconds()))
    days, remainder = divmod(seconds, 86400)
    hours, remainder = divmod(remainder, 3600)
    minutes = (remainder + 59) // 60
    parts: list[str] = []
    if days:
        parts.append(f"{days} дн.")
    if hours:
        parts.append(f"{hours} ч.")
    if minutes and len(parts) < 2:
        parts.append(f"{minutes} мин.")
    return " ".join(parts) or "меньше минуты"


def escape(value: str) -> str:
    return html.escape(value, quote=True)


def season_display_name(user: dict[str, Any]) -> str:
    username = str(user.get("username") or "").strip()
    if username:
        return f"@{username}"
    first_name = str(user.get("first_name") or "").strip()
    last_name = str(user.get("last_name") or "").strip()
    full_name = " ".join(part for part in (first_name, last_name) if part)
    return full_name or f"ID {user.get('id', '?')}"


def season_profile(user: dict[str, Any]) -> tuple[str | None, str]:
    username = str(user.get("username") or "").strip() or None
    return username, season_display_name(user)


def format_season_top(scores: list[dict[str, Any]]) -> str:
    if not scores:
        return (
            "<b>📊 ТОП СЕЗОНА</b>\n"
            "<i>Рейтинг обновляется после каждой активности</i>\n\n"
            "Пока никто не набрал очки."
        )
    lines = [
        "<b>📊 ТОП-10 СЕЗОНА</b>",
        "<i>Станьте первым в рейтинге</i>",
        "",
    ]
    for place, score in enumerate(scores[:10], 1):
        name = escape(str(score.get("display_name") or f"ID {score['user_id']}"))
        medal = ("🥇", "🥈", "🥉")[place - 1] if place <= 3 else f"<b>{place}.</b>"
        lines.append(
            f"{medal} {name}  ·  <b>{int(score.get('points', 0))}</b> очков"
        )
    return "\n".join(lines)


def format_case_settings(settings: dict[str, Any]) -> str:
    odds = settings["odds"]
    return (
        "<b>🎁 НАСТРОЙКИ КЕЙСОВ</b>\n"
        "<i>Вероятности наград и лимит открытий</i>\n\n"
        f"0 монет  ·  <b>{odds['0']}%</b>\n"
        f"5 монет  ·  <b>{odds['5']}%</b>\n"
        f"10 монет  ·  <b>{odds['10']}%</b>\n"
        f"25 монет  ·  <b>{odds['25']}%</b>\n"
        f"50 монет  ·  <b>{odds['50']}%</b>\n"
        f"100 монет  ·  <b>{odds['100']}%</b>\n\n"
        f"⏱ Лимит: <b>{settings['hourly_limit']}</b> открытий в час"
    )


CASE_SETTINGS_KEYBOARD = {
    "inline_keyboard": [
        [{"text": "✎ Изменить шансы", "callback_data": "admin:case_odds"}],
        [{"text": "⏱ Лимит в час", "callback_data": "admin:case_limit"}],
        [{"text": "‹ Назад", "callback_data": "admin:case_back"}],
    ]
}


class WalletBot:
    def __init__(self, telegram: TelegramApi, supabase: SupabaseClient) -> None:
        self.telegram = telegram
        self.supabase = supabase
        self.bot_username = "zeno_wallet_bot"
        self.running = True
        self.operation_lock = threading.Lock()
        self.pending_withdraw: set[int] = set()
        self.pending_admin: dict[int, str] = {}

    def send_error(self, chat_id: int, error: Exception) -> None:
        log.exception("Zeno Wallet command failed", exc_info=error)
        error_text = str(error)
        if (
            "Could not find the table 'public.wallet'" in error_text
            or "Could not find the table 'public.seasons'" in error_text
            or "Could not find the table 'public.games'" in error_text
            or "Could not find the function public.season_" in error_text
            or "Could not find the function public.crash_" in error_text
        ):
            message = (
                "Хранилище кошелька ещё не настроено.\n\n"
                "Администратору нужно выполнить файл "
                "<code>supabase/schema.sql</code> в Supabase SQL Editor."
            )
        else:
            message = "Не удалось выполнить операцию. Попробуйте ещё раз позже."
        self.send(chat_id, message)

    def send(
        self,
        chat_id: int,
        text: str,
        reply_markup: dict[str, Any] | None = None,
    ) -> None:
        markup = (
            reply_markup
            if reply_markup is not None
            else menu_keyboard(chat_id == ADMIN_ID)
        )
        self.telegram.send_message(chat_id, text, markup)

    def record_season_activity(self, user: dict[str, Any], case_points: int = 0) -> None:
        user_id = int(user["id"])
        if user_id == ADMIN_ID:
            return
        username, display_name = season_profile(user)
        try:
            self.supabase.add_season_points(
                user_id,
                username,
                display_name,
                activity_points=SEASON_ACTIVITY_POINTS if case_points == 0 else 0,
                case_points=case_points,
            )
        except Exception:
            # Season tracking must not prevent the wallet bot from responding.
            log.exception("Could not update season score for user %s", user_id)

    def season_status(self, user_id: int) -> str:
        self.supabase.finalize_expired_season()
        season = self.supabase.ensure_active_season()
        scores = self.supabase.get_season_scores(int(season["id"]))
        ordered = sorted(
            scores,
            key=lambda row: (
                -int(row.get("points", 0)),
                str(row.get("updated_at", "")),
                int(row.get("user_id", 0)),
            ),
        )
        current = next(
            (row for row in ordered if int(row.get("user_id", 0)) == user_id),
            None,
        )
        points = int(current.get("points", 0)) if current else 0
        rank = next(
            (
                index
                for index, row in enumerate(ordered, 1)
                if int(row.get("user_id", 0)) == user_id
            ),
            len(ordered) + 1,
        )
        leader_points = int(ordered[0].get("points", 0)) if ordered else 0
        progress = 100 if leader_points == 0 and points else (
            int(points * 100 / leader_points) if leader_points else 0
        )
        ends_at = datetime.fromisoformat(
            str(season["ends_at"]).replace("Z", "+00:00")
        )
        return (
            f"<b>🏆 СЕЗОН #{season['season_number']}</b>\n"
            "<i>Соревнуйтесь, открывайте кейсы, поднимайтесь в топе</i>\n\n"
            f"⏳ До конца  ·  <b>{format_season_remaining(ends_at - datetime.now(timezone.utc))}</b>\n"
            f"📍 Ваше место  ·  <b>#{rank}</b>\n"
            f"⭐ Очки  ·  <b>{points}</b>\n\n"
            f"{progress_bar(progress)}  <b>{progress}%</b> от лидера\n\n"
            "<i>+1 за активность  ·  +5 за успешное открытие кейса</i>"
        )

    def season_top(self) -> str:
        self.supabase.finalize_expired_season()
        season = self.supabase.ensure_active_season()
        return format_season_top(self.supabase.get_season_scores(int(season["id"])))

    def season_announcement(
        self, season_number: int, winners: list[dict[str, Any]]
    ) -> str:
        lines = [
            f"<b>🏆 СЕЗОН #{season_number} ЗАВЕРШЁН</b>",
            "<i>Награды уже начислены победителям</i>",
            "",
        ]
        if not winners:
            lines.append("В этом сезоне никто не набрал очков.")
        else:
            for winner in winners:
                name = escape(
                    str(winner.get("display_name") or f"ID {winner['user_id']}")
                )
                points = winner.get("points")
                points_text = f"{points} очков, " if points is not None else ""
                lines.append(
                    f"<b>{winner['place']}.</b> {name}\n"
                    f"{points_text}"
                    f"+{winner.get('bonus_reward', 0)} монет "
                    "в основной баланс 💰"
                )
        return "\n".join(lines)

    def announce_season(
        self, season_number: int, season_id: int, winners: list[dict[str, Any]]
    ) -> None:
        try:
            self.telegram.send_message(
                SEASON_CHANNEL_ID,
                self.season_announcement(season_number, winners),
            )
            self.supabase.mark_season_announced(season_id)
            log.info("Season %s results announced", season_number)
        except Exception:
            log.exception("Could not announce season %s", season_id)

    def retry_pending_announcements(self) -> None:
        for season in self.supabase.get_pending_season_announcements():
            season_id = int(season["id"])
            season_number = int(season.get("season_number", season_id))
            rewards = self.supabase.get_season_rewards(season_id)
            self.announce_season(season_number, season_id, rewards)

    def maintain_seasons(self) -> None:
        result = self.supabase.finalize_expired_season()
        if result.get("finalized"):
            self.announce_season(
                int(result.get("season_number", result["season_id"])),
                int(result["season_id"]),
                list(result.get("winners") or []),
            )
        self.retry_pending_announcements()

    def process_withdraw(self, chat_id: int, user_id: int, amount: int) -> None:
        withdrawn, wallet, zeno = self.supabase.withdraw(user_id, amount)
        if not withdrawn:
            self.send(
                chat_id,
                "<b>⚠️ Недостаточно средств</b>\n\n"
                f"Доступно к выводу: <b>{int(wallet['earn_balance'])}</b> монет",
            )
            return
        self.send(
            chat_id,
            "<b>✅ Вывод выполнен</b>\n\n"
            f"<b>{amount}</b> монет переведено в Zeno.\n\n"
            f"{format_wallet(wallet, zeno or 0)}",
        )

    def show_admin_panel(self, chat_id: int) -> None:
        self.send(
            chat_id,
            "<b>⚙️ АДМИН-ПАНЕЛЬ</b>\n"
            "<i>Управление балансами, кейсами и сезонами</i>\n\n"
            "Выберите нужный раздел:",
            ADMIN_KEYBOARD,
        )

    def handle_admin_input(self, chat_id: int, text: str) -> None:
        action = self.pending_admin.pop(ADMIN_ID, None)
        if action is None:
            return

        if action == "broadcast":
            delivered = 0
            failed = 0
            for user_id in self.supabase.list_user_ids():
                if user_id == ADMIN_ID or self.supabase.is_banned(user_id):
                    continue
                try:
                    self.send(user_id, f"<b>Сообщение от Zeno Wallet</b>\n\n{escape(text)}")
                    delivered += 1
                except Exception:
                    failed += 1
            self.send(
                chat_id,
                "<b>📣 РАССЫЛКА ЗАВЕРШЕНА</b>\n\n"
                f"Доставлено  ·  <b>{delivered}</b>\n"
                f"Ошибок  ·  <b>{failed}</b>",
            )
            return

        if action == "case_odds":
            values: dict[str, int] = {}
            try:
                for item in text.strip().split():
                    reward, chance = item.split("=", 1)
                    if reward not in {str(value) for value in CASE_REWARDS}:
                        raise ValueError
                    values[reward] = int(chance)
            except (ValueError, TypeError):
                self.send(
                    chat_id,
                    "<b>⚠️ Неверный формат</b>\n\n"
                    "Пример:\n"
                    "<code>0=55 5=15 10=12 25=8 50=6 100=4</code>",
                )
                return
            expected = {str(value) for value in CASE_REWARDS}
            if (
                set(values) != expected
                or any(chance < 0 or chance > 100 for chance in values.values())
                or sum(values.values()) != 100
            ):
                self.send(
                    chat_id,
                    "<b>⚠️ Проверьте вероятности</b>\n\n"
                    "Нужны все награды от 0 до 100%, а сумма должна быть ровно 100%.",
                )
                return
            settings = self.supabase.update_case_settings(odds=values)
            self.send(chat_id, format_case_settings(settings))
            return

        if action == "case_limit":
            if not text.strip().isdigit():
                self.send(chat_id, "⏱ Введите целое число открытий в час от 1 до 1000.")
                return
            hourly_limit = int(text.strip())
            if hourly_limit < 1 or hourly_limit > 1000:
                self.send(chat_id, "⚠️ Лимит должен быть от 1 до 1000 кейсов в час.")
                return
            settings = self.supabase.update_case_settings(hourly_limit=hourly_limit)
            self.send(chat_id, format_case_settings(settings))
            return

        if action == "season_number":
            if not text.strip().isdigit():
                self.send(chat_id, "🏆 Введите положительный номер сезона.")
                return
            season_number = int(text.strip())
            if season_number < 1 or season_number > 1_000_000_000:
                self.send(chat_id, "Номер сезона должен быть от 1 до 1 000 000 000.")
                return
            season = self.supabase.set_season_number(season_number)
            self.send(
                chat_id,
                f"✅ Текущий сезон изменён на <b>#{season['season_number']}</b>.",
            )
            return

        parts = text.strip().split()
        try:
            if action in ("grant", "take"):
                if len(parts) != 2 or not parts[0].isdigit() or not parts[1].isdigit():
                    raise ValueError("Формат: Telegram ID и сумма через пробел")
                target_id = int(parts[0])
                amount = int(parts[1])
                if amount <= 0:
                    raise ValueError("Сумма должна быть больше нуля")
                delta = amount if action == "grant" else -amount
                wallet = self.supabase.admin_adjust_earn(target_id, delta)
                verb = "Выдано" if action == "grant" else "Забрано"
                self.send(
                    chat_id,
                    f"✅ {verb}: <b>{amount}</b> монет.\n"
                    f"Основной баланс пользователя: <b>{wallet['earn_balance']}</b>",
                )
                return

            if action == "balance":
                if len(parts) != 1 or not parts[0].isdigit():
                    raise ValueError("Укажите Telegram ID пользователя")
                target_id = int(parts[0])
                wallet = self.supabase.ensure_wallet(target_id)
                zeno = self.supabase.get_zeno_balance(target_id)
                self.send(chat_id, format_wallet(wallet, zeno))
                return

            if action in ("ban", "unban"):
                if len(parts) != 1 or not parts[0].isdigit():
                    raise ValueError("Укажите Telegram ID пользователя")
                target_id = int(parts[0])
                if target_id == ADMIN_ID:
                    raise ValueError("Нельзя изменить статус главного администратора")
                self.supabase.set_banned(target_id, action == "ban")
                status = "заблокирован" if action == "ban" else "разблокирован"
                icon = "🔒" if action == "ban" else "🔓"
                self.send(chat_id, f"{icon} Пользователь <b>{target_id}</b> {status}.")
                return

            raise ValueError("Неизвестное действие")
        except Exception as error:
            self.send(
                chat_id,
                f"⚠️ Не удалось выполнить действие:\n<b>{escape(str(error))}</b>",
            )

    def handle_message(self, message: dict[str, Any]) -> None:
        user = message.get("from")
        text = message.get("text")
        if not user or not text:
            return

        chat_id = int(message["chat"]["id"])
        user_id = int(user["id"])
        if user_id != ADMIN_ID and self.supabase.is_banned(user_id):
            return

        command, args = parse_command(text)
        command = BUTTON_ACTIONS.get(text.strip(), command)
        if command != "case":
            self.record_season_activity(user)

        if user_id == ADMIN_ID and user_id in self.pending_admin and not text.startswith("/"):
            try:
                with self.operation_lock:
                    self.handle_admin_input(chat_id, text)
            except Exception as error:
                self.send_error(chat_id, error)
            return

        if user_id in self.pending_withdraw and not text.startswith("/"):
            amount = parse_amount(text.strip())
            if amount is not None:
                self.pending_withdraw.remove(user_id)
                try:
                    with self.operation_lock:
                        self.process_withdraw(chat_id, user_id, amount)
                except Exception as error:
                    self.send_error(chat_id, error)
                return
            self.send(
                chat_id,
                "📤 Введите положительную сумму, например <code>100</code>.",
            )
            return

        if not command:
            return

        try:
            with self.operation_lock:
                if command == "start":
                    self.supabase.ensure_wallet(user_id)
                    self.supabase.ensure_user_state(user_id)
                    message_parts = [HELP_TEXT]
                    inviter = referral_id(args)
                    if inviter and self.supabase.claim_referral(inviter, user_id):
                        message_parts.append(
                            "\n✅ Реферал засчитан. Пригласивший получил +5 монет."
                        )
                    self.send(chat_id, "\n".join(message_parts))
                    return

                if command == "menu":
                    self.send(
                        chat_id,
                        "<b>✦ МЕНЮ ZENO WALLET</b>\n\n"
                        "Выберите нужный раздел ниже.",
                    )
                    return

                if command == "app":
                    if not WEBAPP_URL:
                        self.send(
                            chat_id,
                            "Мини-апп пока не настроен: добавьте Secret <code>WEBAPP_URL</code>.",
                        )
                    else:
                        self.send(
                            chat_id,
                            "<b>🚀 ZENO WALLET MINI APP</b>\n\n"
                            "Откройте приложение, чтобы управлять балансом, "
                            "кейсами, бонусами и сезоном.",
                            {
                                "inline_keyboard": [[
                                    {
                                        "text": "Открыть мини-апп",
                                        "web_app": {"url": WEBAPP_URL},
                                    }
                                ]]
                            },
                        )
                    return

                if command == "admin_menu":
                    if user_id == ADMIN_ID:
                        self.show_admin_panel(chat_id)
                    return

                if command == "season":
                    self.send(chat_id, self.season_status(user_id))
                    return

                if command == "season_top":
                    self.send(chat_id, self.season_top())
                    return

                if command == "withdraw_menu":
                    self.send(
                        chat_id,
                        "<b>📤 ВЫВОД В ZENO</b>\n"
                        "<i>Выберите готовую сумму или укажите свою</i>",
                        reply_markup=WITHDRAW_KEYBOARD,
                    )
                    return

                if command == "case":
                    allowed, reward, wallet, remaining, next_available = (
                        self.supabase.open_case(user_id)
                    )
                    if not allowed and next_available:
                        self.send(
                            chat_id,
                            "⏱ <b>Лимит открытий исчерпан</b>\n\n"
                            "Попробуйте снова через "
                            f"<b>{format_duration(next_available - datetime.now(timezone.utc))}</b>.",
                        )
                        return
                    try:
                        self.telegram.send_dice(chat_id)
                    except Exception:
                        log.exception("Could not send case animation")
                    if reward > 0:
                        self.record_season_activity(
                            user, case_points=SEASON_CASE_POINTS
                        )
                    zeno = self.supabase.get_zeno_balance(user_id)
                    if reward == 0:
                        self.send(
                            chat_id,
                            "<b>🎁 КЕЙС ОТКРЫТ</b>\n"
                            "<i>В этот раз награда не выпала</i>\n\n"
                            f"Осталось открытий  ·  <b>{remaining}</b> в час\n\n"
                            f"{format_wallet(wallet, zeno)}",
                        )
                        return
                    self.send(
                        chat_id,
                        "<b>🎁 КЕЙС ОТКРЫТ</b>\n"
                        f"<i>Ваша награда  ·  +{reward} монет</i>\n\n"
                        f"Осталось открытий  ·  <b>{remaining}</b> в час\n\n"
                        f"{format_wallet(wallet, zeno)}",
                    )
                    return

                if command == "daily":
                    claimed, wallet, next_available = self.supabase.claim_daily(user_id)
                    if not claimed and next_available:
                        wait = format_duration(
                            next_available - datetime.now(timezone.utc)
                        )
                        self.send(
                            chat_id,
                            "☀️ <b>Бонус уже получен</b>\n\n"
                            f"Возвращайтесь через "
                            f"<b>{wait}</b>.",
                        )
                        return
                    zeno = self.supabase.get_zeno_balance(user_id)
                    self.send(
                        chat_id,
                        "<b>☀️ ЕЖЕДНЕВНЫЙ БОНУС</b>\n"
                        "<i>Начислено +10 монет</i>\n\n"
                        f"{format_wallet(wallet, zeno)}",
                    )
                    return

                if command == "referral":
                    link = f"https://t.me/{self.bot_username}?start=ref_{user_id}"
                    self.send(
                        chat_id,
                        "<b>👥 ПРИГЛАСИТЕ ДРУЗЕЙ</b>\n"
                        "<i>Получайте +5 монет за каждого нового пользователя</i>\n\n"
                        "Ваша ссылка:\n"
                        f"<code>{escape(link)}</code>\n\n"
                        "Награда начислится после первого запуска бота другом.",
                    )
                    return

                if command == "balance":
                    wallet = self.supabase.ensure_wallet(user_id)
                    zeno = self.supabase.get_zeno_balance(user_id)
                    self.send(chat_id, format_wallet(wallet, zeno))
                    return

                if command == "withdraw":
                    amount = parse_amount(args[0] if args else None)
                    if amount is None:
                        self.pending_withdraw.add(user_id)
                        self.send(
                            chat_id,
                            "📤 Введите сумму вывода одним сообщением, например "
                            "<code>100</code>.",
                        )
                        return
                    self.process_withdraw(chat_id, user_id, amount)
                    return

                self.send(chat_id, HELP_TEXT)
        except Exception as error:
            self.send_error(chat_id, error)

    def handle_callback(self, callback: dict[str, Any]) -> None:
        callback_id = str(callback["id"])
        user = callback.get("from", {})
        data = str(callback.get("data", ""))
        chat = callback.get("message", {}).get("chat", {})
        chat_id = int(chat.get("id", user.get("id")))
        user_id = int(user["id"])
        self.telegram.answer_callback(callback_id)

        if data.startswith("admin:"):
            if user_id != ADMIN_ID:
                return
            action = data.split(":", 1)[1]
            if action == "close":
                self.send(chat_id, "⚙️ Админ-панель закрыта.")
                return
            if action in ("users", "total"):
                try:
                    with self.operation_lock:
                        users, total = self.supabase.admin_stats()
                    if action == "users":
                        self.send(chat_id, f"👥 Пользователей в системе: <b>{users}</b>")
                    else:
                        self.send(
                            chat_id,
                            f"💰 Всего валюты в системе: <b>{total}</b> монет",
                        )
                except Exception as error:
                    self.send_error(chat_id, error)
                return
            if action == "case_settings":
                try:
                    with self.operation_lock:
                        settings = self.supabase.get_case_settings()
                    self.send(chat_id, format_case_settings(settings), CASE_SETTINGS_KEYBOARD)
                except Exception as error:
                    self.send_error(chat_id, error)
                return
            if action == "case_back":
                self.show_admin_panel(chat_id)
                return
            if action == "season_finish":
                try:
                    season = self.supabase.get_active_season()
                    if not season:
                        self.send(chat_id, "⚠️ Активный сезон не найден.")
                        return
                    current_number = int(season["season_number"])
                    self.send(
                        chat_id,
                        f"<b>🏆 Завершить сезон #{current_number}?</b>\n\n"
                        "Награды будут выданы за 1–3 места, очки сброшены, "
                        f"затем начнётся сезон <b>#{current_number + 1}</b>.",
                        SEASON_FINISH_CONFIRM_KEYBOARD,
                    )
                except Exception as error:
                    self.send_error(chat_id, error)
                return
            if action == "season_finish_cancel":
                self.show_admin_panel(chat_id)
                return
            if action == "season_finish_confirm":
                try:
                    with self.operation_lock:
                        result = self.supabase.finalize_expired_season(force=True)
                        if not result.get("finalized"):
                            self.send(chat_id, "⚠️ Активный сезон не найден.")
                            return
                        season_number = int(
                            result.get("season_number", result["season_id"])
                        )
                        self.announce_season(
                            season_number,
                            int(result["season_id"]),
                            list(result.get("winners") or []),
                        )
                        new_season = self.supabase.get_active_season()
                    new_number = (
                        new_season.get("season_number")
                        if new_season
                        else "следующий"
                    )
                    self.send(
                        chat_id,
                        f"✅ Сезон <b>#{season_number}</b> завершён.\n"
                        f"Новый сезон: <b>#{new_number}</b>.",
                    )
                except Exception as error:
                    self.send_error(chat_id, error)
                return
            prompts = {
                "grant": "Введите Telegram ID и сумму для выдачи через пробел:",
                "take": "Введите Telegram ID и сумму для списания через пробел:",
                "balance": "Введите Telegram ID пользователя:",
                "broadcast": "Введите текст сообщения для рассылки:",
                "case_odds": (
                    "Введите шансы одной строкой в формате:\n"
                    "<code>0=55 5=15 10=12 25=8 50=6 100=4</code>\n"
                    "Сумма должна быть ровно 100%."
                ),
                "case_limit": "Введите максимальное количество открытий кейсов в час (1–1000):",
                "season_number": "Введите новый номер текущего сезона (положительное число):",
                "ban": "Введите Telegram ID пользователя для блокировки:",
                "unban": "Введите Telegram ID пользователя для разблокировки:",
            }
            if action in prompts:
                self.pending_admin[ADMIN_ID] = action
                self.send(chat_id, f"<b>✎ ДЕЙСТВИЕ АДМИНИСТРАТОРА</b>\n\n{prompts[action]}")
            return

        if not data.startswith("withdraw:"):
            return
        value = data.split(":", 1)[1]
        if value == "custom":
            self.pending_withdraw.add(user_id)
            self.send(
                chat_id,
                "📤 Введите сумму вывода одним сообщением, например <code>100</code>.",
            )
            return
        amount = parse_amount(value)
        if amount is None:
            return
        try:
            with self.operation_lock:
                self.process_withdraw(chat_id, user_id, amount)
        except Exception as error:
            self.send_error(chat_id, error)

    def run(self) -> None:
        self.telegram.delete_webhook()
        self.telegram.set_my_commands()
        bot = self.telegram.get_me()
        self.bot_username = bot.get("username", self.bot_username)
        log.info("Zeno Wallet bot started as @%s", self.bot_username)
        offset = 0

        while self.running:
            try:
                for update in self.telegram.get_updates(offset):
                    offset = max(offset, int(update["update_id"]) + 1)
                    message = update.get("message")
                    if message:
                        self.handle_message(message)
                    callback = update.get("callback_query")
                    if callback:
                        self.handle_callback(callback)
            except Exception:
                if self.running:
                    log.exception("Telegram polling failed")
                    time.sleep(5)

    def stop(self) -> None:
        self.running = False


def validate_web_app_init_data(init_data: str, bot_token: str) -> dict[str, Any]:
    fields = dict(parse_qsl(init_data, keep_blank_values=True))
    received_hash = fields.pop("hash", "")
    if not received_hash:
        raise ValueError("Telegram init data has no hash")

    data_check_string = "\n".join(
        f"{key}={value}" for key, value in sorted(fields.items())
    )
    secret_key = hmac.new(
        b"WebAppData",
        bot_token.encode("utf-8"),
        sha256,
    ).digest()
    expected_hash = hmac.new(
        secret_key,
        data_check_string.encode("utf-8"),
        sha256,
    ).hexdigest()
    if not hmac.compare_digest(expected_hash, received_hash):
        raise ValueError("Telegram init data signature is invalid")

    try:
        auth_date = int(fields.get("auth_date", "0"))
    except ValueError as error:
        raise ValueError("Telegram init data auth_date is invalid") from error
    if not auth_date or time.time() - auth_date > 86400:
        raise ValueError("Telegram init data has expired")

    try:
        user = json.loads(fields.get("user", "{}"))
    except json.JSONDecodeError as error:
        raise ValueError("Telegram user data is invalid") from error
    if not isinstance(user, dict) or not str(user.get("id", "")).isdigit():
        raise ValueError("Telegram user is missing")
    return user


def is_crash_schema_error(error: Exception) -> bool:
    error_text = str(error).lower()
    return "public.games" in error_text or "public.crash_" in error_text


def web_app_state(bot: WalletBot, user: dict[str, Any]) -> dict[str, Any]:
    user_id = int(user["id"])
    supabase = bot.supabase
    wallet = supabase.ensure_wallet(user_id)
    supabase.ensure_user_state(user_id)
    crash_available = True
    try:
        active_crash_game = supabase.resolve_active_crash_game(user_id)
        crash_history = supabase.get_crash_history(user_id)
    except RuntimeError as error:
        if not is_crash_schema_error(error):
            raise
        log.warning("Crash game schema is not ready; keeping wallet available")
        crash_available = False
        active_crash_game = None
        crash_history = []
    users_state = supabase.get_users_state()
    user_state = users_state.get(str(user_id))
    user_state = user_state if isinstance(user_state, dict) else {}
    zeno_balance = supabase.get_zeno_balance(user_id)

    settings = supabase.get_case_settings()
    cutoff = datetime.now(timezone.utc) - timedelta(hours=1)
    recent_attempts: list[datetime] = []
    for raw_timestamp in user_state.get("case_attempts", []):
        try:
            timestamp = datetime.fromisoformat(
                str(raw_timestamp).replace("Z", "+00:00")
            )
            if timestamp > cutoff:
                recent_attempts.append(timestamp)
        except (TypeError, ValueError):
            continue
    case_remaining = max(0, settings["hourly_limit"] - len(recent_attempts))

    daily_claimed_at = wallet.get("daily_claimed_at")
    daily_next_at: datetime | None = None
    if daily_claimed_at:
        try:
            daily_next_at = datetime.fromisoformat(
                str(daily_claimed_at).replace("Z", "+00:00")
            ) + timedelta(hours=24)
        except ValueError:
            daily_next_at = None
    daily_ready = daily_next_at is None or datetime.now(timezone.utc) >= daily_next_at

    season = supabase.ensure_active_season()
    scores = supabase.get_season_scores(int(season["id"]))
    ordered = sorted(
        scores,
        key=lambda row: (
            -int(row.get("points", 0)),
            str(row.get("updated_at", "")),
            int(row.get("user_id", 0)),
        ),
    )
    current = next(
        (row for row in ordered if int(row.get("user_id", 0)) == user_id),
        None,
    )
    points = int(current.get("points", 0)) if current else 0
    rank = next(
        (
            index
            for index, row in enumerate(ordered, 1)
            if int(row.get("user_id", 0)) == user_id
        ),
        len(ordered) + 1,
    )
    leader_points = int(ordered[0].get("points", 0)) if ordered else 0
    progress = (
        100
        if leader_points == 0 and points
        else int(points * 100 / leader_points) if leader_points else 0
    )
    ends_at = datetime.fromisoformat(
        str(season["ends_at"]).replace("Z", "+00:00")
    )

    return {
        "ok": True,
        "user": {
            "id": user_id,
            "firstName": str(user.get("first_name") or user.get("username") or "друг"),
            "username": user.get("username"),
        },
        "wallet": {
            "earnBalance": int(wallet["earn_balance"]),
            "zenoBalance": zeno_balance,
        },
        "daily": {
            "ready": daily_ready,
            "nextAt": daily_next_at.isoformat() if daily_next_at else None,
        },
        "case": {
            "remaining": case_remaining,
            "hourlyLimit": settings["hourly_limit"],
        },
        "crash": {
            "available": crash_available,
            "active": (
                {
                    "id": int(active_crash_game["id"]),
                    "bet": int(active_crash_game["bet"]),
                    "startedAt": str(active_crash_game["started_at"]),
                    "crashAt": float(active_crash_game["crash_at"]),
                }
                if active_crash_game
                else None
            ),
            "history": [
                {
                    "id": int(row["id"]),
                    "bet": int(row["bet"]),
                    "multiplier": (
                        float(row["multiplier"])
                        if row.get("multiplier") is not None
                        else None
                    ),
                    "result": str(row["result"]),
                    "payout": int(row.get("payout") or 0),
                    "createdAt": str(row["created_at"]),
                }
                for row in crash_history
            ],
        },
        "season": {
            "number": int(season["season_number"]),
            "startsAt": str(season["starts_at"]),
            "endsAt": ends_at.isoformat(),
            "points": points,
            "rank": rank,
            "progress": progress,
            "top": [
                {
                    "place": place,
                    "name": str(row.get("display_name") or f"ID {row['user_id']}"),
                    "points": int(row.get("points", 0)),
                    "isCurrent": int(row.get("user_id", 0)) == user_id,
                }
                for place, row in enumerate(ordered[:10], 1)
            ],
        },
        "referralLink": (
            f"https://t.me/{bot.bot_username}?start=ref_{user_id}"
        ),
    }


class MiniAppHandler(BaseHTTPRequestHandler):
    bot: WalletBot
    supabase: SupabaseClient

    def send_json(self, payload: dict[str, Any], status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def error_json(self, message: str, status: int = 400, code: str = "error") -> None:
        self.send_json({"ok": False, "code": code, "error": message}, status)

    def authorized_user(self) -> dict[str, Any]:
        init_data = self.headers.get("X-Telegram-Init-Data", "")
        return validate_web_app_init_data(init_data, self.bot.telegram.token)

    def do_GET(self) -> None:
        path = urlsplit(self.path).path
        if path in ("/", "/healthz"):
            self.send_json({"status": "ok", "service": "zeno-wallet"})
            return
        if path == "/webapp":
            self.send_response(301)
            self.send_header("Location", "/webapp/")
            self.end_headers()
            return
        if path == "/api/state":
            try:
                user = self.authorized_user()
                with self.bot.operation_lock:
                    self.send_json(web_app_state(self.bot, user))
            except ValueError as error:
                self.error_json(str(error), 401, "unauthorized")
            except Exception:
                log.exception("Mini-app state request failed")
                self.error_json("Не удалось загрузить данные кошелька.", 500)
            return
        if path.startswith("/webapp/"):
            self.serve_static(path)
            return
        self.error_json("Страница не найдена.", 404, "not_found")

    def do_HEAD(self) -> None:
        path = urlsplit(self.path).path
        if path in ("/", "/healthz"):
            body = b'{"status": "ok", "service": "zeno-wallet"}'
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            return
        if path.startswith("/webapp/"):
            self.serve_static(path, head_only=True)
            return
        self.send_response(404)
        self.end_headers()

    def do_POST(self) -> None:
        path = urlsplit(self.path).path
        if path != "/api/action":
            self.error_json("Страница не найдена.", 404, "not_found")
            return
        try:
            user = self.authorized_user()
            length = int(self.headers.get("Content-Length", "0"))
            if length > 32_000:
                raise ValueError("Запрос слишком большой")
            raw_body = self.rfile.read(length)
            body = json.loads(raw_body.decode("utf-8") or "{}")
            action = body.get("action")
            user_id = int(user["id"])
            with self.bot.operation_lock:
                if action == "case":
                    allowed, reward, _wallet, remaining, next_available = (
                        self.supabase.open_case(user_id)
                    )
                    if not allowed:
                        self.send_json(
                            {
                                "ok": False,
                                "code": "case_limit",
                                "error": "Лимит открытий на этот час исчерпан.",
                                "nextAt": next_available.isoformat()
                                if next_available
                                else None,
                            },
                            429,
                        )
                        return
                    if reward and reward > 0:
                        self.bot.record_season_activity(
                            user,
                            case_points=SEASON_CASE_POINTS,
                        )
                    result = web_app_state(self.bot, user)
                    result["lastAction"] = {
                        "type": "case",
                        "reward": int(reward or 0),
                        "remaining": remaining,
                    }
                    self.send_json(result)
                    return

                if action == "daily":
                    claimed, _wallet, next_available = self.supabase.claim_daily(user_id)
                    if not claimed:
                        self.send_json(
                            {
                                "ok": False,
                                "code": "daily_cooldown",
                                "error": "Ежедневный бонус уже получен.",
                                "nextAt": next_available.isoformat()
                                if next_available
                                else None,
                            },
                            429,
                        )
                        return
                    result = web_app_state(self.bot, user)
                    result["lastAction"] = {"type": "daily", "reward": 10}
                    self.send_json(result)
                    return

                if action == "withdraw":
                    amount = body.get("amount")
                    if isinstance(amount, bool) or not isinstance(amount, int):
                        raise ValueError("Сумма должна быть целым числом")
                    if amount <= 0:
                        raise ValueError("Сумма должна быть больше нуля")
                    withdrawn, wallet, zeno = self.supabase.withdraw(user_id, amount)
                    if not withdrawn:
                        self.send_json(
                            {
                                "ok": False,
                                "code": "insufficient_funds",
                                "error": "Недостаточно средств для вывода.",
                                "balance": int(wallet["earn_balance"]),
                            },
                            400,
                        )
                        return
                    result = web_app_state(self.bot, user)
                    result["lastAction"] = {
                        "type": "withdraw",
                        "amount": amount,
                        "zenoBalance": zeno,
                    }
                    self.send_json(result)
                    return

                if action == "crash_start":
                    raw_bet = body.get("bet")
                    active_game = self.supabase.resolve_active_crash_game(user_id)
                    if active_game:
                        raise ValueError("Сначала заверши текущий раунд.")
                    wallet = self.supabase.ensure_wallet(user_id)
                    balance = int(wallet["earn_balance"])
                    if raw_bet == "all":
                        bet = balance
                    elif (
                        isinstance(raw_bet, bool)
                        or not isinstance(raw_bet, int)
                    ):
                        raise ValueError("Ставка должна быть целым числом")
                    else:
                        bet = raw_bet
                    if bet <= 0:
                        raise ValueError("Недостаточно монет для ставки")
                    if bet > balance:
                        self.send_json(
                            {
                                "ok": False,
                                "code": "insufficient_funds",
                                "error": "Недостаточно монет для этой ставки.",
                                "balance": balance,
                            },
                            400,
                        )
                        return
                    started = self.supabase.start_crash_game(user_id, bet)
                    result = web_app_state(self.bot, user)
                    result["lastAction"] = {
                        "type": "crash_start",
                        "gameId": int(started["gameId"]),
                        "bet": bet,
                    }
                    self.send_json(result)
                    return

                if action == "crash_cashout":
                    game_id = body.get("gameId")
                    if isinstance(game_id, bool) or not isinstance(game_id, int):
                        raise ValueError("Некорректный раунд")
                    settled = self.supabase.cashout_crash_game(user_id, game_id)
                    result = web_app_state(self.bot, user)
                    result["lastAction"] = {
                        "type": "crash_cashout",
                        "result": str(settled.get("result")),
                        "multiplier": float(settled.get("multiplier") or 0),
                        "payout": int(settled.get("payout") or 0),
                        "bet": int(settled.get("bet") or 0),
                    }
                    self.send_json(result)
                    return

                if action == "crash_settle":
                    game_id = body.get("gameId")
                    if isinstance(game_id, bool) or not isinstance(game_id, int):
                        raise ValueError("Некорректный раунд")
                    settled = self.supabase.settle_crash_game(user_id, game_id)
                    result = web_app_state(self.bot, user)
                    result["lastAction"] = {
                        "type": "crash_settle",
                        "result": str(settled.get("result")),
                        "multiplier": float(settled.get("multiplier") or 0),
                        "payout": int(settled.get("payout") or 0),
                        "bet": int(settled.get("bet") or 0),
                    }
                    self.send_json(result)
                    return

                if action in ("refresh", "season"):
                    self.send_json(web_app_state(self.bot, user))
                    return
                raise ValueError("Неизвестное действие")
        except ValueError as error:
            self.error_json(str(error), 400)
        except RuntimeError as error:
            if action and str(action).startswith("crash_") and is_crash_schema_error(error):
                self.error_json(
                    "Ракетка пока не настроена. Выполните supabase/schema.sql в Supabase.",
                    503,
                    "crash_setup_required",
                )
                return
            log.exception("Mini-app action request failed")
            self.error_json("Не удалось выполнить операцию.", 500)
        except Exception:
            log.exception("Mini-app action request failed")
            self.error_json("Не удалось выполнить операцию.", 500)

    def serve_static(self, path: str, head_only: bool = False) -> None:
        relative_path = unquote(path.removeprefix("/webapp/")) or "index.html"
        try:
            root = WEBAPP_DIR.resolve()
            candidate = (root / relative_path).resolve()
            candidate.relative_to(root)
        except (OSError, ValueError):
            self.error_json("Файл не найден.", 404, "not_found")
            return
        if not candidate.is_file():
            self.error_json("Файл не найден.", 404, "not_found")
            return

        content_types = {
            ".html": "text/html; charset=utf-8",
            ".css": "text/css; charset=utf-8",
            ".js": "application/javascript; charset=utf-8",
            ".svg": "image/svg+xml",
            ".png": "image/png",
            ".jpg": "image/jpeg",
            ".ico": "image/x-icon",
        }
        body = candidate.read_bytes()
        self.send_response(200)
        self.send_header(
            "Content-Type",
            content_types.get(candidate.suffix.lower(), "application/octet-stream"),
        )
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if not head_only:
            self.wfile.write(body)

    def log_message(self, _format: str, *_args: Any) -> None:
        return


class HealthHandler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        if self.path not in ("/", "/healthz"):
            self.send_response(404)
            self.end_headers()
            return
        payload = b'{"status":"ok"}'
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, _format: str, *_args: Any) -> None:
        return


def start_web_server(bot: WalletBot) -> ThreadingHTTPServer:
    port = int(os.getenv("PORT", "8080"))
    handler = type(
        "BoundMiniAppHandler",
        (MiniAppHandler,),
        {"bot": bot, "supabase": bot.supabase},
    )
    server = ThreadingHTTPServer(("0.0.0.0", port), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    log.info("Web server listening on port %s; mini-app at /webapp/", port)
    if not WEBAPP_URL:
        log.warning("WEBAPP_URL is not set; Telegram mini-app button is disabled")
    return server


def season_maintenance_loop(bot: WalletBot) -> None:
    while bot.running:
        try:
            with bot.operation_lock:
                bot.maintain_seasons()
        except Exception:
            log.exception("Season maintenance failed")
        time.sleep(60)


def main() -> None:
    token = required_env("BOT_TOKEN")
    supabase = SupabaseClient()
    telegram = TelegramApi(token)
    bot = WalletBot(telegram, supabase)
    web_server = start_web_server(bot)
    threading.Thread(
        target=season_maintenance_loop,
        args=(bot,),
        daemon=True,
        name="season-maintenance",
    ).start()

    def shutdown(_signum: int, _frame: Any) -> None:
        bot.stop()
        web_server.shutdown()

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)
    if WEB_ONLY:
        log.info("Zeno Wallet web-only mode started")
        while bot.running:
            time.sleep(3600)
        return
    bot.run()


if __name__ == "__main__":
    main()