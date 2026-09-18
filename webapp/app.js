const telegram = window.Telegram?.WebApp;
const appState = { data: null, activeView: "home" };
const busyActions = new Set();
const REQUEST_TIMEOUT_MS = 15000;
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

function getInitials(name) {
  const words = String(name || "ZW")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return words
    .slice(0, 2)
    .map((word) => word[0])
    .join("")
    .toUpperCase() || "ZW";
}

function setAvatars(user, progress) {
  const telegramUser = telegram?.initDataUnsafe?.user;
  const photoUrl = telegramUser?.photo_url || "";
  const initials = getInitials(user?.firstName);
  document.querySelectorAll(".avatar-ring").forEach((avatar) => {
    avatar.style.setProperty("--ring-progress", `${Math.max(0, Math.min(100, progress))}%`);
    avatar.classList.toggle("has-photo", Boolean(photoUrl));
    avatar.style.setProperty(
      "--avatar-image",
      photoUrl ? `url("${photoUrl.replaceAll('"', "%22")}")` : "none",
    );
    avatar.innerHTML = photoUrl ? "" : `<span>${escapeHtml(initials)}</span>`;
  });
}

function getLevelProgress(points) {
  const safePoints = Math.max(0, Number(points || 0));
  const level = Math.floor(safePoints / 100) + 1;
  const current = safePoints % 100;
  return { level, current, percent: current };
}

function getSeasonTimeProgress(season) {
  const end = new Date(season.endsAt);
  const start = new Date(season.startsAt || Date.now());
  const total = Math.max(1, end.getTime() - start.getTime());
  const remaining = Math.max(0, end.getTime() - Date.now());
  return {
    daysLeft: Math.ceil(remaining / (24 * 60 * 60 * 1000)),
    percent: Math.max(0, Math.min(100, (remaining / total) * 100)),
  };
}

function renderHomeLeaders(top) {
  const container = $("#home-leaders");
  const leaders = (top || []).slice(0, 3);
  const current = (top || []).find((row) => row.isCurrent);
  const rows = current && !leaders.some((row) => row.isCurrent) ? [...leaders, current] : leaders;

  if (!rows.length) {
    container.innerHTML = '<div class="leader-empty">Пока никто не набрал очков</div>';
    return;
  }

  container.innerHTML = rows
    .map(
      (row) => `
        <div class="home-leader-row ${row.isCurrent ? "current" : ""}">
          <span class="home-leader-place">${row.place}.</span>
          <span class="home-leader-name">${escapeHtml(row.name)}${row.isCurrent ? " · ты" : ""}</span>
          <strong>${formatNumber(row.points)}</strong>
        </div>`,
    )
    .join("");
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
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(path, {
      ...options,
      signal: options.signal || controller.signal,
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
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error("Сервер отвечает слишком долго. Попробуйте ещё раз.");
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
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
  const caseButton = document.querySelector('[data-action="case"]');
  caseButton.disabled = !busyActions.has("case") && Number(caseData.remaining) <= 0;
  caseButton.setAttribute("aria-busy", busyActions.has("case") ? "true" : "false");
  document.querySelector('[data-action="withdraw"]').disabled = false;
  $("#season-number").textContent = `#${season.number}`;
  $("#season-pill").textContent = `#${season.number}`;
  $("#season-info").textContent = `#${season.number}`;
  $("#season-rank").textContent = `#${season.rank}`;
  $("#season-points").textContent = formatNumber(season.points);
  $("#season-progress-text").textContent = `${season.progress}% от лидера`;
  $("#season-time").textContent = `ещё ${formatRemaining(season.endsAt)}`;
  const seasonTime = getSeasonTimeProgress(season);
  $("#season-days-left").textContent = `${seasonTime.daysLeft} дн.`;
  $("#season-days-fill").style.width = `${seasonTime.percent}%`;
  $("#referral-link").textContent = data.referralLink;
  const level = getLevelProgress(season.points);
  $("#profile-level").textContent = level.level;
  $("#level-progress-fill").style.width = `${level.percent}%`;
  $("#level-progress-text").textContent = `${level.current} / 100 XP`;
  $("#profile-points").textContent = formatNumber(season.points);
  $("#profile-rank").textContent = `#${season.rank}`;
  $("#profile-balance").textContent = formatNumber(wallet.earnBalance);
  setAvatars(user, level.percent);
  renderHomeLeaders(season.top);

  const dailyButton = document.querySelector('[data-action="daily"]');
  dailyButton.disabled = !daily.ready;
  $("#daily-status").textContent = daily.ready
    ? "+10 монет каждый день"
    : `снова через ${formatRemaining(daily.nextAt)}`;

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
  if (busyActions.has(action) || !appState.data) return;
  const buttons = document.querySelectorAll(`[data-action="${action}"]`);
  busyActions.add(action);
  buttons.forEach((button) => {
    button.disabled = true;
    button.classList.add("working");
    button.setAttribute("aria-busy", "true");
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
      const caseButton = document.querySelector('[data-action="case"]');
      caseButton.classList.remove("reward-pop");
      void caseButton.offsetWidth;
      caseButton.classList.add("reward-pop");
      showToast(
        actionResult.reward > 0
          ? `Кейс открыт · +${formatNumber(actionResult.reward)} монет`
          : "Кейс открыт · в этот раз без награды",
      );
    } else if (actionResult?.type === "daily") {
      showToast("+10 монет начислено");
    } else if (actionResult?.type === "withdraw") {
      showToast(`${formatNumber(actionResult.amount)} монет переведено`);
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
    busyActions.delete(action);
    buttons.forEach((button) => {
      button.classList.remove("working");
      button.setAttribute("aria-busy", "false");
    });
    render();
  }
}

async function copyReferral() {
  if (!appState.data?.referralLink) return;
  try {
    await navigator.clipboard.writeText(appState.data.referralLink);
    showToast("Ссылка скопирована");
    setView("more");
  } catch {
    showToast("Не удалось скопировать ссылку", "danger");
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
document.querySelectorAll('[data-action="friends"]').forEach((button) => {
  button.addEventListener("click", copyReferral);
});
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

$("#copy-referral").addEventListener("click", copyReferral);

telegram?.BackButton?.onClick(closeWithdraw);
loadState();