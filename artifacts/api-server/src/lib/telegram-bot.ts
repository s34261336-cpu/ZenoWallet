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
  callback_query?: TelegramCallbackQuery;
};

type TelegramCallbackQuery = {
  id: string;
  from: TelegramUser;
  data?: string;
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
const ADMIN_ID = 5814345235;
function menuKeyboard(isAdmin: boolean): Record<string, unknown> {
  const keyboard = [
    [{ text: "Открыть кейс" }, { text: "Ежедневный бонус" }],
    [{ text: "Мой баланс" }, { text: "Пригласить друзей" }],
    [{ text: "Вывести монеты" }],
  ];
  if (isAdmin) {
    keyboard.push([{ text: "Админ-панель" }]);
  }
  return {
    keyboard,
    resize_keyboard: true,
    is_persistent: true,
    input_field_placeholder: "Выберите действие",
  };
}
const WITHDRAW_KEYBOARD = {
  inline_keyboard: [
    [
      { text: "10", callback_data: "withdraw:10" },
      { text: "50", callback_data: "withdraw:50" },
      { text: "100", callback_data: "withdraw:100" },
    ],
    [
      { text: "200", callback_data: "withdraw:200" },
      { text: "Ввести свою сумму", callback_data: "withdraw:custom" },
    ],
  ],
};
const ADMIN_KEYBOARD = {
  inline_keyboard: [
    [
      { text: "Выдать валюту", callback_data: "admin:grant" },
      { text: "Забрать валюту", callback_data: "admin:take" },
    ],
    [
      { text: "Баланс пользователя", callback_data: "admin:balance" },
      { text: "Количество юзеров", callback_data: "admin:users" },
    ],
    [{ text: "Всего валюты", callback_data: "admin:total" }],
    [{ text: "Рассылка всем", callback_data: "admin:broadcast" }],
    [
      { text: "Забанить юзера", callback_data: "admin:ban" },
      { text: "Разбанить", callback_data: "admin:unban" },
    ],
    [{ text: "Закрыть панель", callback_data: "admin:close" }],
  ],
};
const BUTTON_ACTIONS: Record<string, string> = {
  "Открыть кейс": "case",
  "Ежедневный бонус": "daily",
  "Мой баланс": "balance",
  "Пригласить друзей": "referral",
  "Вывести монеты": "withdraw_menu",
  "Админ-панель": "admin_menu",
};
const pendingWithdraw = new Set<number>();
const pendingAdmin = new Map<number, string>();

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

function formatWallet(wallet: Wallet, zenoBalance = wallet.zeno_balance): string {
  return [
    "<b>Ваш баланс</b>",
    "",
    `Заработано: <b>${wallet.earn_balance}</b> монет`,
    `В Zeno: <b>${zenoBalance}</b> монет`,
  ].join("\n");
}

const HELP_TEXT = [
  "<b>Zeno Wallet</b>",
  "",
  "Зарабатывайте монеты и переводите их в Zeno.",
  "",
  "Выберите действие в меню ниже.",
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

  setMyCommands(): Promise<unknown> {
    return this.call("setMyCommands", {
      commands: [{ command: "start", description: "Открыть главное меню" }],
    });
  }

  getUpdates(offset: number, signal: AbortSignal): Promise<TelegramUpdate[]> {
    return this.call<TelegramUpdate[]>(
      "getUpdates",
      {
        offset,
        timeout: 25,
        allowed_updates: ["message", "callback_query"],
      },
      signal,
    );
  }

  answerCallbackQuery(callbackId: string): Promise<unknown> {
    return this.call("answerCallbackQuery", {
      callback_query_id: callbackId,
    });
  }

  sendMessage(
    chatId: number,
    text: string,
    replyMarkup: Record<string, unknown> = menuKeyboard(chatId === ADMIN_ID),
  ): Promise<unknown> {
    return this.call("sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: replyMarkup,
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

async function processWithdraw(
  telegram: TelegramApi,
  supabase: NonNullable<ReturnType<typeof getSupabaseClient>>,
  chatId: number,
  userId: number,
  amount: number,
): Promise<void> {
  const result = await supabase.withdraw(userId, amount);
  if (!result.withdrawn) {
    await telegram.sendMessage(
      chatId,
      `Недостаточно заработанных монет.\n\nВаш баланс: <b>${result.wallet.earn_balance}</b> монет`,
    );
    return;
  }

  await telegram.sendMessage(
    chatId,
    `Вывод выполнен: <b>${amount} монет</b> переведено в Zeno.\n\n${formatWallet(
      result.wallet,
      result.zenoBalance,
    )}`,
  );
}

async function handleAdminInput(
  telegram: TelegramApi,
  supabase: NonNullable<ReturnType<typeof getSupabaseClient>>,
  chatId: number,
  text: string,
): Promise<void> {
  const action = pendingAdmin.get(ADMIN_ID);
  pendingAdmin.delete(ADMIN_ID);
  if (!action) {
    return;
  }

  if (action === "broadcast") {
    const userIds = await supabase.listUserIds();
    let delivered = 0;
    let failed = 0;
    for (const userId of userIds) {
      if (userId === ADMIN_ID || (await supabase.isBanned(userId))) {
        continue;
      }
      try {
        await telegram.sendMessage(
          userId,
          `<b>Сообщение от Zeno Wallet</b>\n\n${escapeHtml(text)}`,
        );
        delivered += 1;
      } catch {
        failed += 1;
      }
    }
    await telegram.sendMessage(
      chatId,
      `Рассылка завершена.\n\nДоставлено: <b>${delivered}</b>\nОшибок: <b>${failed}</b>`,
    );
    return;
  }

  const parts = text.trim().split(/\s+/);
  try {
    if (action === "grant" || action === "take") {
      if (parts.length !== 2 || !/^\d+$/.test(parts[0]) || !/^\d+$/.test(parts[1])) {
        throw new Error("Формат: Telegram ID и сумма через пробел");
      }
      const targetId = Number(parts[0]);
      const amount = Number(parts[1]);
      if (!Number.isSafeInteger(targetId) || !Number.isSafeInteger(amount) || amount <= 0) {
        throw new Error("ID и сумма должны быть положительными целыми числами");
      }
      const wallet = await supabase.adminAdjustEarn(
        targetId,
        action === "grant" ? amount : -amount,
      );
      const verb = action === "grant" ? "Выдано" : "Забрано";
      await telegram.sendMessage(
        chatId,
        `${verb}: <b>${amount}</b> монет.\nБаланс пользователя: <b>${wallet.earn_balance}</b>`,
      );
      return;
    }

    if (action === "balance") {
      if (parts.length !== 1 || !/^\d+$/.test(parts[0])) {
        throw new Error("Укажите Telegram ID пользователя");
      }
      const targetId = Number(parts[0]);
      const wallet = await supabase.ensureWallet(targetId);
      const zeno = await supabase.getZenoBalance(targetId);
      await telegram.sendMessage(chatId, formatWallet(wallet, zeno));
      return;
    }

    if (action === "ban" || action === "unban") {
      if (parts.length !== 1 || !/^\d+$/.test(parts[0])) {
        throw new Error("Укажите Telegram ID пользователя");
      }
      const targetId = Number(parts[0]);
      if (targetId === ADMIN_ID) {
        throw new Error("Нельзя изменить статус главного администратора");
      }
      await supabase.setBanned(targetId, action === "ban");
      await telegram.sendMessage(
        chatId,
        `Пользователь <b>${targetId}</b> ${
          action === "ban" ? "заблокирован" : "разблокирован"
        }.`,
      );
      return;
    }

    throw new Error("Неизвестное действие");
  } catch (error) {
    await telegram.sendMessage(
      chatId,
      `Не удалось выполнить действие: <b>${escapeHtml(
        error instanceof Error ? error.message : String(error),
      )}</b>`,
    );
  }
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

  try {
    if (user.id !== ADMIN_ID && (await supabase.isBanned(user.id))) {
      return;
    }
  } catch (error) {
    await sendError(telegram, message.chat.id, error);
    return;
  }

  if (user.id === ADMIN_ID && pendingAdmin.has(ADMIN_ID) && !text.startsWith("/")) {
    try {
      await handleAdminInput(telegram, supabase, message.chat.id, text);
    } catch (error) {
      await sendError(telegram, message.chat.id, error);
    }
    return;
  }

  const { command, args } = parseCommand(text);
  const action = BUTTON_ACTIONS[text.trim()];
  const selectedCommand = action ?? command;
  if (pendingWithdraw.has(user.id) && !text.startsWith("/")) {
    const amount = parsePositiveAmount(text.trim());
    if (amount !== null) {
      pendingWithdraw.delete(user.id);
      try {
        await processWithdraw(telegram, supabase, message.chat.id, user.id, amount);
      } catch (error) {
        await sendError(telegram, message.chat.id, error);
      }
      return;
    }
    await telegram.sendMessage(
      message.chat.id,
      "Введите положительную целую сумму, например <code>100</code>.",
    );
    return;
  }
  if (!selectedCommand) {
    return;
  }

  try {
    if (selectedCommand === "start") {
      const referralId = getReferralId(args);
      let referralMessage = "";

      await supabase.ensureWallet(user.id);
      await supabase.ensureUserState(user.id);
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

    if (selectedCommand === "admin_menu") {
      if (user.id === ADMIN_ID) {
        await telegram.sendMessage(
          message.chat.id,
          "<b>Админ-панель Zeno Wallet</b>\n\nВыберите нужное действие:",
          ADMIN_KEYBOARD,
        );
      }
      return;
    }

    if (selectedCommand === "withdraw_menu") {
      await telegram.sendMessage(
        message.chat.id,
        "Выберите сумму вывода или введите свою сумму:",
        WITHDRAW_KEYBOARD,
      );
      return;
    }

    if (selectedCommand === "case") {
      const reward = Math.floor(Math.random() * 96) + 5;
      const wallet = await supabase.openCase(user.id, reward);
      const zenoBalance = await supabase.getZenoBalance(user.id);
      await telegram.sendMessage(
        message.chat.id,
        `Кейс открыт.\n\nВаша награда: <b>+${reward} монет</b>\n\n${formatWallet(
          wallet,
          zenoBalance,
        )}`,
      );
      return;
    }

    if (selectedCommand === "daily") {
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

      const zenoBalance = await supabase.getZenoBalance(user.id);
      await telegram.sendMessage(
        message.chat.id,
        `Ежедневный бонус начислен: <b>+10 монет</b>\n\n${formatWallet(
          result.wallet,
          zenoBalance,
        )}`,
      );
      return;
    }

    if (selectedCommand === "referral") {
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

    if (selectedCommand === "balance") {
      const wallet = await supabase.ensureWallet(user.id);
      const zenoBalance = await supabase.getZenoBalance(user.id);
      await telegram.sendMessage(
        message.chat.id,
        formatWallet(wallet, zenoBalance),
      );
      return;
    }

    if (selectedCommand === "withdraw") {
      const amount = parsePositiveAmount(args[0]);
      if (amount === null) {
        pendingWithdraw.add(user.id);
        await telegram.sendMessage(
          message.chat.id,
          "Введите сумму вывода одним сообщением, например <code>100</code>.",
        );
        return;
      }

      await processWithdraw(telegram, supabase, message.chat.id, user.id, amount);
      return;
    }

    await telegram.sendMessage(message.chat.id, HELP_TEXT);
  } catch (error) {
    await sendError(telegram, message.chat.id, error);
  }
}

async function handleCallback(
  telegram: TelegramApi,
  update: TelegramUpdate,
): Promise<void> {
  const callback = update.callback_query;
  if (!callback) {
    return;
  }

  await telegram.answerCallbackQuery(callback.id);
  const data = callback.data ?? "";
  const userId = callback.from.id;
  const chatId = callback.message?.chat.id ?? userId;

  if (data.startsWith("admin:")) {
    if (userId !== ADMIN_ID) {
      return;
    }
    const action = data.slice("admin:".length);
    if (action === "close") {
      await telegram.sendMessage(chatId, "Админ-панель закрыта.");
      return;
    }
    if (action === "users" || action === "total") {
      const supabase = getSupabaseClient();
      if (!supabase) {
        return;
      }
      try {
        const stats = await supabase.adminStats();
        await telegram.sendMessage(
          chatId,
          action === "users"
            ? `Всего пользователей: <b>${stats.users}</b>`
            : `Всего валюты в системе: <b>${stats.total}</b> монет`,
      );
      } catch (error) {
        await sendError(telegram, chatId, error);
      }
      return;
    }
    const prompts: Record<string, string> = {
      grant: "Введите Telegram ID и сумму для выдачи через пробел:",
      take: "Введите Telegram ID и сумму для списания через пробел:",
      balance: "Введите Telegram ID пользователя:",
      broadcast: "Введите текст сообщения для рассылки:",
      ban: "Введите Telegram ID пользователя для блокировки:",
      unban: "Введите Telegram ID пользователя для разблокировки:",
    };
    if (prompts[action]) {
      pendingAdmin.set(ADMIN_ID, action);
      await telegram.sendMessage(chatId, prompts[action]);
    }
    return;
  }

  if (!data.startsWith("withdraw:")) {
    return;
  }

  const value = data.slice("withdraw:".length);
  if (value === "custom") {
    pendingWithdraw.add(userId);
    await telegram.sendMessage(
      chatId,
      "Введите сумму вывода одним сообщением, например <code>100</code>.",
    );
    return;
  }

  const amount = parsePositiveAmount(value);
  const supabase = getSupabaseClient();
  if (!supabase || amount === null) {
    return;
  }

  try {
    await processWithdraw(telegram, supabase, chatId, userId, amount);
  } catch (error) {
    await sendError(telegram, chatId, error);
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
      await telegram.setMyCommands();
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
            await handleCallback(telegram, update);
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