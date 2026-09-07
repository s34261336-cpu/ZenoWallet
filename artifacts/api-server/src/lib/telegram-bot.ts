import { logger } from "./logger";
import {
  getSupabaseClient,
  logSupabaseError,
  type Wallet,
} from "./supabase";

type TelegramUser = {
  id: number;
  first_name?: string;
  username?: string;
};

type TelegramChat = {
  id: number;
};

type TelegramMessage = {
  message_id: number;
  chat: TelegramChat;
  from?: TelegramUser;
  text?: string;
};

type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
};

type TelegramResponse<T> = {
  ok: boolean;
  result?: T;
  description?: string;
};

type TelegramBotInfo = {
  username?: string;
};

const DAILY_COOLDOWN_HOURS = 24;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatDuration(ms: number): string {
  const totalMinutes = Math.max(1, Math.ceil(ms / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) {
    return `${minutes} мин.`;
  }
  return minutes === 0 ? `${hours} ч.` : `${hours} ч. ${minutes} мин.`;
}

function formatWallet(wallet: Wallet): string {
  return [
    "<b>Ваш баланс</b>",
    "",
    `Заработано: <b>${wallet.earn_balance}</b> монет`,
    `В Zeno: <b>${wallet.zeno_balance}</b> монет`,
  ].join("\n");
}

const HELP_TEXT = [
  "<b>Zeno Wallet</b>",
  "",
  "Зарабатывайте монеты и переводите их в Zeno.",
  "",
  "/case — открыть кейс с наградой от 5 до 100 монет",
  "/daily — получить ежедневный бонус +10",
  "/referral — получить реферальную ссылку",
  "/balance — посмотреть баланс",
  "/withdraw [сумма] — вывести монеты в Zeno",
].join("\n");

class TelegramApi {
  private readonly baseUrl: string;

  constructor(token: string) {
    this.baseUrl = `https://api.telegram.org/bot${token}`;
  }

  async call<T>(
    method: string,
    body: Record<string, unknown> = {},
    signal?: AbortSignal,
  ): Promise<T> {
    const response = await fetch(`${this.baseUrl}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    const payload = (await response.json()) as TelegramResponse<T>;
    if (!response.ok || !payload.ok) {
      throw new Error(
        `Telegram ${method} failed: ${payload.description ?? response.statusText}`,
      );
    }
    return payload.result as T;
  }

  getMe(): Promise<TelegramBotInfo> {
    return this.call<TelegramBotInfo>("getMe");
  }

  getUpdates(offset: number, signal: AbortSignal): Promise<TelegramUpdate[]> {
    return this.call<TelegramUpdate[]>(
      "getUpdates",
      { offset, timeout: 25, allowed_updates: ["message"] },
      signal,
    );
  }

  sendMessage(chatId: number, text: string): Promise<unknown> {
    return this.call("sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    });
  }
}

function parseCommand(text: string): { command: string; args: string[] } {
  const [rawCommand = "", ...args] = text.trim().split(/\s+/);
  const command = rawCommand
    .split("@")[0]
    .toLowerCase()
    .replace(/^\//, "");
  return { command, args };
}

function parsePositiveAmount(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) {
    return null;
  }
  const amount = Number(value);
  return Number.isSafeInteger(amount) && amount > 0 ? amount : null;
}

function getReferralId(args: string[]): number | null {
  const payload = args[0] ?? "";
  const rawId = payload.startsWith("ref_") ? payload.slice(4) : "";
  if (!/^\d+$/.test(rawId)) {
    return null;
  }
  const id = Number(rawId);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

async function sendError(
  telegram: TelegramApi,
  chatId: number,
  error: unknown,
): Promise<void> {
  logSupabaseError(error, "Zeno Wallet command failed");
  if (
    error instanceof Error &&
    /Could not find the table ['"]public\.wallet['"]/.test(error.message)
  ) {
    await telegram.sendMessage(
      chatId,
      [
        "Хранилище кошелька ещё не настроено.",
        "",
        "Администратору нужно один раз выполнить файл <code>supabase/schema.sql</code> в Supabase SQL Editor, затем повторить команду.",
      ].join("\n"),
    );
    return;
  }
  await telegram.sendMessage(
    chatId,
    "Не удалось выполнить операцию. Попробуйте ещё раз позже.",
  );
}

async function handleMessage(
  telegram: TelegramApi,
  botUsername: string,
  update: TelegramUpdate,
): Promise<void> {
  const message = update.message;
  const user = message?.from;
  const text = message?.text;
  if (!message || !user || !text) {
    return;
  }

  const supabase = getSupabaseClient();
  if (!supabase) {
    await telegram.sendMessage(
      message.chat.id,
      "Кошелёк ещё не настроен. Администратору нужно добавить настройки Supabase.",
    );
    return;
  }

  const { command, args } = parseCommand(text);
  if (!command) {
    return;
  }

  try {
    if (command === "start") {
      const referralId = getReferralId(args);
      let referralMessage = "";

      await supabase.ensureWallet(user.id);
      if (referralId !== null) {
        const referral = await supabase.claimReferral(referralId, user.id);
        if (referral.rewarded) {
          referralMessage =
            "\n\nРеферал засчитан. Пригласивший получил +50 монет.";
        }
      }

      await telegram.sendMessage(
        message.chat.id,
        `${HELP_TEXT}${referralMessage}`,
      );
      return;
    }

    if (command === "case") {
      const reward = Math.floor(Math.random() * 96) + 5;
      const wallet = await supabase.openCase(user.id, reward);
      await telegram.sendMessage(
        message.chat.id,
        `Кейс открыт.\n\nВаша награда: <b>+${reward} монет</b>\n\n${formatWallet(wallet)}`,
      );
      return;
    }

    if (command === "daily") {
      const result = await supabase.claimDaily(user.id);
      if (!result.claimed) {
        await telegram.sendMessage(
          message.chat.id,
          `Ежедневный бонус уже получен. Возвращайтесь через <b>${formatDuration(
            result.nextAvailableAt.getTime() - Date.now(),
          )}</b>.`,
        );
        return;
      }

      await telegram.sendMessage(
        message.chat.id,
        `Ежедневный бонус начислен: <b>+10 монет</b>\n\n${formatWallet(
          result.wallet,
        )}`,
      );
      return;
    }

    if (command === "referral") {
      const link = `https://t.me/${botUsername}?start=ref_${user.id}`;
      await telegram.sendMessage(
        message.chat.id,
        [
          "<b>Ваша реферальная ссылка</b>",
          "",
          `<code>${escapeHtml(link)}</code>`,
          "",
          "Пригласите друга — вы получите +50 монет после его первого запуска бота.",
        ].join("\n"),
      );
      return;
    }

    if (command === "balance") {
      const wallet = await supabase.ensureWallet(user.id);
      await telegram.sendMessage(message.chat.id, formatWallet(wallet));
      return;
    }

    if (command === "withdraw") {
      const amount = parsePositiveAmount(args[0]);
      if (amount === null) {
        await telegram.sendMessage(
          message.chat.id,
          "Укажите положительную целую сумму.\nПример: <code>/withdraw 100</code>",
        );
        return;
      }

      const result = await supabase.withdraw(user.id, amount);
      if (!result.withdrawn) {
        await telegram.sendMessage(
          message.chat.id,
          `Недостаточно заработанных монет.\n\nВаш баланс: <b>${result.wallet.earn_balance}</b> монет`,
        );
        return;
      }

      await telegram.sendMessage(
        message.chat.id,
        `Вывод выполнен: <b>${amount} монет</b> переведено в Zeno.\n\n${formatWallet(
          result.wallet,
        )}`,
      );
      return;
    }

    await telegram.sendMessage(message.chat.id, HELP_TEXT);
  } catch (error) {
    await sendError(telegram, message.chat.id, error);
  }
}

export function startTelegramBot(): void {
  const token = process.env["BOT_TOKEN"];
  if (!token) {
    logger.warn("BOT_TOKEN is not configured; Telegram bot is disabled");
    return;
  }

  const telegram = new TelegramApi(token);
  let offset = 0;
  let stopped = false;

  const stop = () => {
    stopped = true;
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);

  void (async () => {
    try {
      const bot = await telegram.getMe();
      const botUsername = bot.username ?? "zeno_wallet_bot";
      logger.info({ botUsername }, "Zeno Wallet Telegram bot started");

      while (!stopped) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 35_000);
        try {
          const updates = await telegram.getUpdates(offset, controller.signal);
          for (const update of updates) {
            offset = Math.max(offset, update.update_id + 1);
            await handleMessage(telegram, botUsername, update);
          }
        } catch (error) {
          if (!stopped) {
            logger.error({ err: error }, "Telegram polling failed");
            await new Promise((resolve) => setTimeout(resolve, 5_000));
          }
        } finally {
          clearTimeout(timeout);
        }
      }
    } catch (error) {
      logger.error({ err: error }, "Zeno Wallet Telegram bot stopped");
    }
  })();

  logger.info(
    { dailyCooldownHours: DAILY_COOLDOWN_HOURS },
    "Zeno Wallet bot configuration loaded",
  );
}