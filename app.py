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

    def update_users_state(self, state: dict[str, Any]) -> None:
        self.request(
            "bot_state?state_key=eq.users",
            method="PATCH",
            body={"state_value": state},
            prefer="return=minimal",
        )

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

    def delete_webhook(self) -> None:
        self.call("deleteWebhook", {"drop_pending_updates": False})

    def get_updates(self, offset: int) -> list[dict[str, Any]]:
        return self.call(
            "getUpdates",
            {"offset": offset, "timeout": 25, "allowed_updates": ["message"]},
            timeout=35,
        )

    def send_message(self, chat_id: int, text: str) -> None:
        self.call(
            "sendMessage",
            {
                "chat_id": chat_id,
                "text": text,
                "parse_mode": "HTML",
                "disable_web_page_preview": True,
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


HELP_TEXT = (
    "<b>Zeno Wallet</b>\n\n"
    "Зарабатывайте монеты и переводите их в Zeno.\n\n"
    "/case — открыть кейс с наградой от 5 до 100 монет\n"
    "/daily — получить ежедневный бонус +10\n"
    "/referral — получить реферальную ссылку\n"
    "/balance — посмотреть баланс\n"
    "/withdraw [сумма] — вывести монеты в Zeno"
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
        self.telegram.send_message(chat_id, message)

    def handle_message(self, message: dict[str, Any]) -> None:
        user = message.get("from")
        text = message.get("text")
        if not user or not text:
            return

        chat_id = int(message["chat"]["id"])
        user_id = int(user["id"])
        command, args = parse_command(text)
        if not command:
            return

        try:
            with self.operation_lock:
                if command == "start":
                    self.supabase.ensure_wallet(user_id)
                    message_parts = [HELP_TEXT]
                    inviter = referral_id(args)
                    if inviter and self.supabase.claim_referral(inviter, user_id):
                        message_parts.append(
                            "\nРеферал засчитан. Пригласивший получил +50 монет."
                        )
                    self.telegram.send_message(chat_id, "\n".join(message_parts))
                    return

                if command == "case":
                    reward = random.randint(5, 100)
                    wallet = self.supabase.credit(user_id, reward)
                    zeno = self.supabase.get_zeno_balance(user_id)
                    self.telegram.send_message(
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
                        self.telegram.send_message(
                            chat_id,
                            f"Ежедневный бонус уже получен. Возвращайтесь через "
                            f"<b>{wait}</b>.",
                        )
                        return
                    zeno = self.supabase.get_zeno_balance(user_id)
                    self.telegram.send_message(
                        chat_id,
                        f"Ежедневный бонус начислен: <b>+10 монет</b>\n\n"
                        f"{format_wallet(wallet, zeno)}",
                    )
                    return

                if command == "referral":
                    link = f"https://t.me/{self.bot_username}?start=ref_{user_id}"
                    self.telegram.send_message(
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
                    self.telegram.send_message(chat_id, format_wallet(wallet, zeno))
                    return

                if command == "withdraw":
                    amount = parse_amount(args[0] if args else None)
                    if amount is None:
                        self.telegram.send_message(
                            chat_id,
                            "Укажите положительную целую сумму.\n"
                            "Пример: <code>/withdraw 100</code>",
                        )
                        return
                    withdrawn, wallet, zeno = self.supabase.withdraw(user_id, amount)
                    if not withdrawn:
                        self.telegram.send_message(
                            chat_id,
                            f"Недостаточно заработанных монет.\n\nВаш баланс: "
                            f"<b>{wallet['earn_balance']}</b> монет",
                        )
                        return
                    self.telegram.send_message(
                        chat_id,
                        f"Вывод выполнен: <b>{amount} монет</b> переведено в Zeno.\n\n"
                        f"{format_wallet(wallet, zeno or 0)}",
                    )
                    return

                self.telegram.send_message(chat_id, HELP_TEXT)
        except Exception as error:
            self.send_error(chat_id, error)

    def run(self) -> None:
        self.telegram.delete_webhook()
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