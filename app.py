from __future__ import annotations

import html
import json
import logging
import os
import random
import re
import signal
import threading
import time
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)
log = logging.getLogger("zeno-wallet")
ADMIN_ID = 5814345235


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
        return value if isinstance(value, (int, float)) and value >= 0 else 0

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
        self.credit(inviter_id, 50)
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
        next_zeno = int(current_zeno) + amount

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


class TelegramApi:
    def __init__(self, token: str) -> None:
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
        except (HTTPError, URLError, TimeoutError) as error:
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
                    }
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

    def send_message(
        self,
        chat_id: int,
        text: str,
        reply_markup: dict[str, Any] | None = None,
    ) -> None:
        markup = reply_markup if reply_markup is not None else menu_keyboard(False)
        self.call(
            "sendMessage",
            {
                "chat_id": chat_id,
                "text": text,
                "parse_mode": "HTML",
                "disable_web_page_preview": True,
                "reply_markup": markup,
            },
        )


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
    return (
        "<b>Ваш баланс</b>\n\n"
        f"Заработано: <b>{int(wallet['earn_balance'])}</b> монет\n"
        f"В Zeno: <b>{int(zeno_balance)}</b> монет"
    )


def menu_keyboard(is_admin: bool = False) -> dict[str, Any]:
    keyboard = [
        [{"text": "Открыть кейс"}, {"text": "Ежедневный бонус"}],
        [{"text": "Мой баланс"}, {"text": "Пригласить друзей"}],
        [{"text": "Вывести монеты"}],
    ]
    if is_admin:
        keyboard.append([{"text": "Админ-панель"}])
    return {
        "keyboard": keyboard,
        "resize_keyboard": True,
        "is_persistent": True,
        "input_field_placeholder": "Выберите действие",
    }

WITHDRAW_KEYBOARD = {
    "inline_keyboard": [
        [
            {"text": "10", "callback_data": "withdraw:10"},
            {"text": "50", "callback_data": "withdraw:50"},
            {"text": "100", "callback_data": "withdraw:100"},
        ],
        [
            {"text": "200", "callback_data": "withdraw:200"},
            {"text": "Ввести свою сумму", "callback_data": "withdraw:custom"},
        ],
    ]
}

ADMIN_KEYBOARD = {
    "inline_keyboard": [
        [
            {"text": "Выдать валюту", "callback_data": "admin:grant"},
            {"text": "Забрать валюту", "callback_data": "admin:take"},
        ],
        [
            {"text": "Баланс пользователя", "callback_data": "admin:balance"},
            {"text": "Количество юзеров", "callback_data": "admin:users"},
        ],
        [
            {"text": "Всего валюты", "callback_data": "admin:total"},
        ],
        [
            {"text": "Рассылка всем", "callback_data": "admin:broadcast"},
        ],
        [
            {"text": "Забанить юзера", "callback_data": "admin:ban"},
            {"text": "Разбанить", "callback_data": "admin:unban"},
        ],
        [{"text": "Закрыть панель", "callback_data": "admin:close"}],
    ]
}

BUTTON_ACTIONS = {
    "Открыть кейс": "case",
    "Ежедневный бонус": "daily",
    "Мой баланс": "balance",
    "Пригласить друзей": "referral",
    "Вывести монеты": "withdraw_menu",
    "Админ-панель": "admin_menu",
}


HELP_TEXT = (
    "<b>Zeno Wallet</b>\n\n"
    "Зарабатывайте монеты и переводите их в Zeno.\n\n"
    "Выберите действие в меню ниже."
)


def format_duration(delta: timedelta) -> str:
    minutes = max(1, int((delta.total_seconds() + 59) // 60))
    hours, remaining = divmod(minutes, 60)
    if hours == 0:
        return f"{remaining} мин."
    return f"{hours} ч." if remaining == 0 else f"{hours} ч. {remaining} мин."


def escape(value: str) -> str:
    return html.escape(value, quote=True)


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
        if "Could not find the table 'public.wallet'" in str(error):
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

    def process_withdraw(self, chat_id: int, user_id: int, amount: int) -> None:
        withdrawn, wallet, zeno = self.supabase.withdraw(user_id, amount)
        if not withdrawn:
            self.send(
                chat_id,
                f"Недостаточно заработанных монет.\n\nВаш баланс: "
                f"<b>{wallet['earn_balance']}</b> монет",
            )
            return
        self.send(
            chat_id,
            f"Вывод выполнен: <b>{amount} монет</b> переведено в Zeno.\n\n"
            f"{format_wallet(wallet, zeno or 0)}",
        )

    def show_admin_panel(self, chat_id: int) -> None:
        self.send(
            chat_id,
            "<b>Админ-панель Zeno Wallet</b>\n\nВыберите нужное действие:",
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
                f"Рассылка завершена.\n\nДоставлено: <b>{delivered}</b>\n"
                f"Ошибок: <b>{failed}</b>",
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
                    f"{verb}: <b>{amount}</b> монет.\n"
                    f"Баланс пользователя: <b>{wallet['earn_balance']}</b>",
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
                self.send(chat_id, f"Пользователь <b>{target_id}</b> {status}.")
                return

            raise ValueError("Неизвестное действие")
        except Exception as error:
            self.send(chat_id, f"Не удалось выполнить действие: <b>{escape(str(error))}</b>")

    def handle_message(self, message: dict[str, Any]) -> None:
        user = message.get("from")
        text = message.get("text")
        if not user or not text:
            return

        chat_id = int(message["chat"]["id"])
        user_id = int(user["id"])
        if user_id != ADMIN_ID and self.supabase.is_banned(user_id):
            return

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
                "Введите положительную целую сумму, например <code>100</code>.",
            )
            return

        command, args = parse_command(text)
        command = BUTTON_ACTIONS.get(text.strip(), command)
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
                            "\nРеферал засчитан. Пригласивший получил +50 монет."
                        )
                    self.send(chat_id, "\n".join(message_parts))
                    return

                if command == "admin_menu":
                    if user_id == ADMIN_ID:
                        self.show_admin_panel(chat_id)
                    return

                if command == "withdraw_menu":
                    self.send(
                        chat_id,
                        "Выберите сумму вывода или введите свою сумму:",
                        reply_markup=WITHDRAW_KEYBOARD,
                    )
                    return

                if command == "case":
                    reward = random.randint(5, 100)
                    wallet = self.supabase.credit(user_id, reward)
                    zeno = self.supabase.get_zeno_balance(user_id)
                    self.send(
                        chat_id,
                        f"Кейс открыт.\n\nВаша награда: <b>+{reward} монет</b>\n\n"
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
                            f"Ежедневный бонус уже получен. Возвращайтесь через "
                            f"<b>{wait}</b>.",
                        )
                        return
                    zeno = self.supabase.get_zeno_balance(user_id)
                    self.send(
                        chat_id,
                        f"Ежедневный бонус начислен: <b>+10 монет</b>\n\n"
                        f"{format_wallet(wallet, zeno)}",
                    )
                    return

                if command == "referral":
                    link = f"https://t.me/{self.bot_username}?start=ref_{user_id}"
                    self.send(
                        chat_id,
                        "<b>Ваша реферальная ссылка</b>\n\n"
                        f"<code>{escape(link)}</code>\n\n"
                        "Пригласите друга — вы получите +50 монет после его "
                        "первого запуска бота.",
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
                            "Введите сумму вывода одним сообщением, например "
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
                self.send(chat_id, "Админ-панель закрыта.")
                return
            if action in ("users", "total"):
                try:
                    with self.operation_lock:
                        users, total = self.supabase.admin_stats()
                    if action == "users":
                        self.send(chat_id, f"Всего пользователей: <b>{users}</b>")
                    else:
                        self.send(
                            chat_id,
                            f"Всего валюты в системе: <b>{total}</b> монет",
                        )
                except Exception as error:
                    self.send_error(chat_id, error)
                return
            prompts = {
                "grant": "Введите Telegram ID и сумму для выдачи через пробел:",
                "take": "Введите Telegram ID и сумму для списания через пробел:",
                "balance": "Введите Telegram ID пользователя:",
                "broadcast": "Введите текст сообщения для рассылки:",
                "ban": "Введите Telegram ID пользователя для блокировки:",
                "unban": "Введите Telegram ID пользователя для разблокировки:",
            }
            if action in prompts:
                self.pending_admin[ADMIN_ID] = action
                self.send(chat_id, prompts[action])
            return

        if not data.startswith("withdraw:"):
            return
        value = data.split(":", 1)[1]
        if value == "custom":
            self.pending_withdraw.add(user_id)
            self.send(
                chat_id,
                "Введите сумму вывода одним сообщением, например <code>100</code>.",
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


def start_health_server() -> ThreadingHTTPServer:
    port = int(os.getenv("PORT", "8080"))
    server = ThreadingHTTPServer(("0.0.0.0", port), HealthHandler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    log.info("Health server listening on port %s", port)
    return server


def main() -> None:
    token = required_env("BOT_TOKEN")
    supabase = SupabaseClient()
    telegram = TelegramApi(token)
    bot = WalletBot(telegram, supabase)
    health_server = start_health_server()

    def shutdown(_signum: int, _frame: Any) -> None:
        bot.stop()
        health_server.shutdown()

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)
    bot.run()


if __name__ == "__main__":
    main()