const telegram = window.Telegram?.WebApp;
const appState = { data: null, activeView: "home" };
const $ = (selector) => document.querySelector(selector);

if (telegram) {
  telegram.ready();
  telegram.expand();
  telegram.enableClosingConfirmation?.();
}

const initData = telegram?.initData || "";
const apiHeaders = {
  "Content-Type": "application/json",
  "X-Telegram-Init-Data": initData,
};

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatNumber(value) {
  return new Intl.NumberFormat("ru-RU").format(Number(value || 0));
}

function formatRemaining(isoDate) {
  if (!isoDate) return "сейчас";
  const seconds = Math.max(0, Math.floor((new Date(isoDate) - Date.now()) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.ceil((seconds % 3600) / 60);
  if (hours > 24) return `${Math.floor(hours / 24)} дн.`;
  if (hours > 0) return `${hours} ч. ${minutes} мин.`;
  return `${Math.max(1, minutes)} мин.`;
}

function showToast(message, tone = "success") {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.toggle("danger", tone === "danger");
  toast.classList.add("show");
  window.clearTimeout(showToast.timeout);
  showToast.timeout = window.setTimeout(() => toast.classList.remove("show"), 2800);
}

function showError(message) {
  const panel = $("#error-panel");
  panel.textContent = message;
  panel.style.display = "block";
}

function clearError() {
  const panel = $("#error-panel");
  panel.textContent = "";
  panel.style.display = "none";
}

function setLoading(loading) {
  $("#loading-state").classList.toggle("hidden", !loading);
}

async function request(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { ...apiHeaders, ...(options.headers || {}) },
  });
  const payload = await response.json().catch(() => ({
    ok: false,
    error: "Сервер вернул некорректный ответ.",
  }));
  if (!response.ok || payload.ok === false) {
    const error = new Error(payload.error || "Операция не выполнена.");
    Object.assign(error, payload);
    throw error;
  }
  return payload;
}

async function loadState() {
  if (!initData) {
    setLoading(false);
    $("#auth-modal").classList.remove("hidden");
    return;
  }
  clearError();
  setLoading(true);
  try {
    appState.data = await request("/api/state");
    render();
  } catch (error) {
    showError(error.message);
  } finally {
    setLoading(false);
  }
}

function render() {
  const data = appState.data;
  if (!data) return;
  const { wallet, daily, case: caseData, season, user } = data;

  $("#user-name").textContent = user.firstName;
  $("#earn-balance").textContent = formatNumber(wallet.earnBalance);
  $("#zeno-balance").textContent = formatNumber(wallet.zenoBalance);
  $("#case-remaining").textContent = caseData.remaining;
  $("#case-limit").textContent = `${caseData.hourlyLimit} в час`;
  $("#season-number").textContent = `#${season.number}`;
  $("#season-pill").textContent = `#${season.number}`;
  $("#season-info").textContent = `#${season.number}`;
  $("#season-rank").textContent = `#${season.rank}`;
  $("#season-points").textContent = formatNumber(season.points);
  $("#season-progress-fill").style.width = `${Math.max(0, Math.min(100, season.progress))}%`;
  $("#season-progress-text").textContent = `${season.progress}% от лидера`;
  $("#season-time").textContent = `ещё ${formatRemaining(season.endsAt)}`;
  $("#referral-link").textContent = data.referralLink;

  const dailyButton = document.querySelector('[data-action="daily"]');
  dailyButton.disabled = !daily.ready;
  $("#daily-status").textContent = daily.ready
    ? "+10 монет каждый день"
    : `снова через ${formatRemaining(daily.nextAt)}`;

  const leader = season.top[0];
  $("#leader-preview").innerHTML = leader
    ? `<div class="leader-avatar">♛</div><div><span>Лидер сезона</span><strong>${escapeHtml(
        leader.name,
      )} · ${formatNumber(leader.points)} очков</strong></div>`
    : `<span>Пока никто не набрал очков</span>`;

  $("#leaderboard").innerHTML = season.top.length
    ? season.top
        .map((row) => {
          const medal = ["🥇", "🥈", "🥉"][row.place - 1];
          return `<div class="leader-row ${row.isCurrent ? "current" : ""}">
            <span class="leader-place ${medal ? "medal" : ""}">${medal || `${row.place}.`}</span>
            <span class="leader-name">${escapeHtml(row.name)}${row.isCurrent ? " · вы" : ""}</span>
            <span class="leader-score">${formatNumber(row.points)}</span>
          </div>`;
        })
        .join("")
    : '<div class="empty-leaderboard">Пока никто не набрал очков.</div>';
}

function setView(viewName) {
  appState.activeView = viewName;
  document.querySelectorAll(".view").forEach((view) => {
    view.classList.toggle("hidden", view.id !== `${viewName}-view`);
  });
  document.querySelectorAll(".nav-item").forEach((item) => {
    item.classList.toggle("active", item.dataset.view === viewName);
  });
  if (telegram?.HapticFeedback) telegram.HapticFeedback.selectionChanged();
}

async function runAction(action, body = {}) {
  const buttons = document.querySelectorAll(`[data-action="${action}"]`);
  buttons.forEach((button) => {
    button.disabled = true;
    button.classList.add("working");
  });
  try {
    const result = await request("/api/action", {
      method: "POST",
      body: JSON.stringify({ action, ...body }),
    });
    appState.data = result;
    render();
    const actionResult = result.lastAction;
    if (actionResult?.type === "case") {
      showToast(
        actionResult.reward > 0
          ? `🎁 +${formatNumber(actionResult.reward)} монет`
          : "Кейс открыт — в этот раз без награды",
      );
    } else if (actionResult?.type === "daily") {
      showToast("☀️ +10 монет начислено");
    } else if (actionResult?.type === "withdraw") {
      showToast(`✅ ${formatNumber(actionResult.amount)} монет переведено`);
    }
  } catch (error) {
    if (error.code === "daily_cooldown" && error.nextAt) {
      showToast(`Бонус будет доступен через ${formatRemaining(error.nextAt)}`, "danger");
    } else if (error.code === "case_limit" && error.nextAt) {
      showToast(`Следующий кейс через ${formatRemaining(error.nextAt)}`, "danger");
    } else {
      showToast(error.message, "danger");
    }
  } finally {
    buttons.forEach((button) => {
      button.classList.remove("working");
    });
    render();
  }
}

function openWithdraw() {
  $("#withdraw-modal").classList.remove("hidden");
  $("#withdraw-amount").focus();
  telegram?.BackButton?.show();
}

function closeWithdraw() {
  $("#withdraw-modal").classList.add("hidden");
  telegram?.BackButton?.hide();
}

document.querySelectorAll(".nav-item, [data-view]").forEach((button) => {
  button.addEventListener("click", () => {
    if (button.dataset.view) setView(button.dataset.view);
  });
});

document.querySelector('[data-action="case"]').addEventListener("click", () => runAction("case"));
document.querySelector('[data-action="daily"]').addEventListener("click", () => runAction("daily"));
document.querySelector('[data-action="withdraw"]').addEventListener("click", openWithdraw);
$("#refresh-button").addEventListener("click", loadState);
$("#close-withdraw").addEventListener("click", closeWithdraw);
$("#withdraw-modal").addEventListener("click", (event) => {
  if (event.target.id === "withdraw-modal") closeWithdraw();
});

document.querySelectorAll("[data-amount]").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll("[data-amount]").forEach((item) => item.classList.remove("selected"));
    button.classList.add("selected");
    $("#withdraw-amount").value = button.dataset.amount;
  });
});

$("#withdraw-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const amount = Number.parseInt($("#withdraw-amount").value, 10);
  if (!Number.isInteger(amount) || amount <= 0) {
    showToast("Введите положительную сумму", "danger");
    return;
  }
  closeWithdraw();
  await runAction("withdraw", { amount });
});

$("#copy-referral").addEventListener("click", async () => {
  if (!appState.data?.referralLink) return;
  try {
    await navigator.clipboard.writeText(appState.data.referralLink);
    showToast("Ссылка скопирована");
  } catch {
    showToast("Не удалось скопировать ссылку", "danger");
  }
});

telegram?.BackButton?.onClick(closeWithdraw);
loadState();