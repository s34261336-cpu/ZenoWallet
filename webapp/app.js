const telegram = window.Telegram?.WebApp;
const appState = { data: null, activeView: "home" };
const busyActions = new Set();
let serverClockOffsetMs = 0;
let hasServerClock = false;
let lastCrashToastKey = "";
let lastRouletteToastKey = "";
const crashRuntime = {
  gameId: null,
  frame: null,
  settleTimer: null,
  countdownTimer: null,
  startedAtMs: null,
  startedPerfMs: null,
  visualCatchupStartedPerfMs: null,
  visualCatchupElapsedMs: 0,
  settleRetryTimer: null,
  lastFramePerfMs: null,
  lagCashoutRequested: false,
  bounds: null,
  phase: null,
  displayMultiplier: null,
  crashed: false,
  settling: false,
  countdownActive: false,
  countdownResolve: null,
};
let selectedCrashBet = "10";
const CRASH_PRESET_BETS = new Set(["10", "50", "100"]);
let selectedRouletteBet = "10";
let selectedRouletteMode = "standard";
const ROULETTE_PRESET_BETS = new Set(["10", "50", "100", "500"]);
const ROULETTE_SEGMENTS = {
  standard: [
    { label: "50x", multiplier: 50, icon: "★" },
    { label: "2x", multiplier: 2, icon: "✦" },
    { label: "10x", multiplier: 10, icon: "★" },
    { label: "Мимо", multiplier: 0, icon: "—" },
    { label: "5x", multiplier: 5, icon: "★" },
    { label: "3x", multiplier: 3, icon: "✦" },
    { label: "Мимо", multiplier: 0, icon: "—" },
    { label: "2x", multiplier: 2, icon: "✦" },
  ],
  premium: [
    { label: "50x", multiplier: 50, icon: "★" },
    { label: "10x", multiplier: 10, icon: "★" },
    { label: "20x", multiplier: 20, icon: "★" },
    { label: "5x", multiplier: 5, icon: "★" },
    { label: "3x", multiplier: 3, icon: "✦" },
    { label: "2x", multiplier: 2, icon: "✦" },
    { label: "Мимо", multiplier: 0, icon: "—" },
    { label: "10x", multiplier: 10, icon: "★" },
  ],
};
const rouletteRuntime = {
  spinning: false,
  finishTimer: null,
  frame: null,
  lastFrameAt: null,
  rotation: 28,
  previousWallet: null,
  previousRoulette: null,
};
const CRASH_START_COUNTDOWN_MS = 5000;
const REQUEST_TIMEOUT_MS = 15000;
const ROULETTE_SPIN_DURATION_MS = 3500;
const ROULETTE_SPIN_EXTRA_TURNS = 3;
const ROULETTE_SPIN_SPEED_DEG_PER_SEC = 720;
const MAIN_VIEWS = new Set(["home", "games", "season", "profile"]);
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

function formatMultiplier(value) {
  return `${Number(value || 1).toFixed(2)}x`;
}

function getCrashMultiplier(startedAt) {
  const elapsed = getCrashElapsedSeconds(startedAt);
  return 1 + 0.07 * elapsed + 0.025 * elapsed * elapsed;
}

function getTimingNow() {
  return typeof window.performance?.now === "function" ? window.performance.now() : Date.now();
}

function syncServerClock(serverNow, requestStartedAt, requestFinishedAt) {
  const serverNowMs = Date.parse(String(serverNow || ""));
  if (!Number.isFinite(serverNowMs)) return;
  const roundTripMs = Math.max(0, requestFinishedAt - requestStartedAt);
  const estimatedClientAtServerMs = Date.now() - roundTripMs / 2;
  const sampleOffsetMs = serverNowMs - estimatedClientAtServerMs;
  serverClockOffsetMs = hasServerClock
    ? serverClockOffsetMs * 0.8 + sampleOffsetMs * 0.2
    : sampleOffsetMs;
  hasServerClock = true;
}

function getCrashTravelProgress(multiplier) {
  const current = Math.max(1, Number(multiplier || 1));
  // Keep the path tied to the visible multiplier, not to this round's
  // crash point. A short 1.20x round should end near the launch area
  // instead of making the rocket jump to the top of the chart.
  const progress = Math.log(current) / Math.log(6);
  return Math.max(0, Math.min(0.96, progress));
}

function getCrashTrajectoryPoint(progress) {
  const t = Math.max(0, Math.min(1, progress));
  const inverseT = 1 - t;
  return {
    x:
      inverseT * inverseT * inverseT * 8 +
      3 * inverseT * inverseT * t * 24 +
      3 * inverseT * t * t * 62 +
      t * t * t * 100,
    y:
      inverseT * inverseT * inverseT * 91 +
      3 * inverseT * inverseT * t * 100 +
      3 * inverseT * t * t * 84 +
      t * t * t * 8,
  };
}

function getCrashTrajectoryAngle(progress) {
  const t = Math.max(0, Math.min(1, progress));
  const inverseT = 1 - t;
  const dx =
    3 * inverseT * inverseT * (24 - 8) +
    6 * inverseT * t * (62 - 24) +
    3 * t * t * (100 - 62);
  const dy =
    3 * inverseT * inverseT * (100 - 91) +
    6 * inverseT * t * (84 - 100) +
    3 * t * t * (8 - 84);
  return (Math.atan2(dy, dx) * 180) / Math.PI;
}

function getCrashFlightBounds() {
  const flightLine = $(".crash-flight-line");
  if (!flightLine) return { width: 1, height: 150 };
  if (!crashRuntime.bounds || crashRuntime.bounds.width < 10) {
    const bounds = flightLine.getBoundingClientRect();
    if (bounds.width >= 10 && bounds.height >= 10) {
      crashRuntime.bounds = { width: bounds.width, height: bounds.height };
    }
  }
  return crashRuntime.bounds || {
    width: flightLine.clientWidth || 1,
    height: flightLine.clientHeight || 150,
  };
}

function stopCrashAnimation() {
  if (crashRuntime.frame !== null) {
    if (typeof window.cancelAnimationFrame === "function") {
      window.cancelAnimationFrame(crashRuntime.frame);
    } else {
      window.clearTimeout(crashRuntime.frame);
    }
  }
  if (crashRuntime.settleTimer !== null) {
    window.clearTimeout(crashRuntime.settleTimer);
  }
  if (crashRuntime.countdownTimer !== null) {
    window.clearTimeout(crashRuntime.countdownTimer);
  }
  if (crashRuntime.countdownResolve) {
    const resolveCountdown = crashRuntime.countdownResolve;
    crashRuntime.countdownResolve = null;
    resolveCountdown(false);
  }
  if (crashRuntime.settleRetryTimer !== null) {
    window.clearTimeout(crashRuntime.settleRetryTimer);
  }
  crashRuntime.frame = null;
  crashRuntime.settleTimer = null;
  crashRuntime.countdownTimer = null;
  crashRuntime.countdownActive = false;
  crashRuntime.settleRetryTimer = null;
  crashRuntime.lastFramePerfMs = null;
  crashRuntime.lagCashoutRequested = false;
  crashRuntime.gameId = null;
  crashRuntime.startedAtMs = null;
  crashRuntime.startedPerfMs = null;
  crashRuntime.visualCatchupStartedPerfMs = null;
  crashRuntime.visualCatchupElapsedMs = 0;
  crashRuntime.bounds = null;
  crashRuntime.phase = null;
  crashRuntime.displayMultiplier = null;
  crashRuntime.crashed = false;
  crashRuntime.settling = false;
  $("#crash-stage")?.classList.remove("running", "crashed");
  $("#crash-stage")?.classList.remove("launching", "phase-low", "phase-mid", "phase-high");
  document.querySelectorAll(".crash-trajectory-progress, .crash-trajectory-glow").forEach((path) => {
    path.style.strokeDasharray = "1";
    path.style.strokeDashoffset = "1";
  });
  const rocket = $("#crash-rocket");
  rocket?.style.removeProperty("transform");
  rocket?.style.removeProperty("--flight-angle");
  const rocketTrail = $(".crash-rocket-trail");
  rocketTrail?.style.removeProperty("background");
  rocketTrail?.style.removeProperty("box-shadow");
}

function startCrashCountdown() {
  const stage = $("#crash-stage");
  const status = $("#crash-status");
  const multiplier = $("#crash-multiplier");
  const startButton = $("#crash-start");
  const openBetButton = $("#crash-open-bet");
  const countdownFill = $("#crash-countdown-fill");
  if (crashRuntime.countdownActive) return Promise.resolve(false);
  const countdownStartedAt = Date.now();
  const countdownEndAt = countdownStartedAt + CRASH_START_COUNTDOWN_MS;

  if (crashRuntime.countdownTimer !== null) {
    window.clearTimeout(crashRuntime.countdownTimer);
  }
  crashRuntime.countdownActive = true;
  stage?.classList.add("launching");
  stage?.classList.remove("running", "crashed");
  if (startButton) startButton.disabled = true;
  if (openBetButton) {
    openBetButton.disabled = true;
    openBetButton.classList.add("is-locked");
    openBetButton.setAttribute("aria-disabled", "true");
  }
  countdownFill?.style.setProperty(
    "--countdown-duration",
    `${CRASH_START_COUNTDOWN_MS}ms`,
  );

  return new Promise((resolve) => {
    crashRuntime.countdownResolve = resolve;
    const finish = (completed) => {
      crashRuntime.countdownTimer = null;
      crashRuntime.countdownActive = false;
      crashRuntime.countdownResolve = null;
      stage?.classList.remove("launching");
      if (completed) {
        if (multiplier) multiplier.textContent = "1.00x";
      } else if (openBetButton && !appState.data?.crash?.active) {
        openBetButton.disabled = false;
        openBetButton.classList.remove("is-locked");
        openBetButton.setAttribute("aria-disabled", "false");
      }
      resolve(completed);
    };
    const tick = () => {
      const remainingMs = Math.max(0, countdownEndAt - Date.now());
      if (remainingMs <= 0) {
        finish(true);
        return;
      }
      const remaining = Math.ceil(remainingMs / 1000);
      if (status) status.textContent = "Приём ставок";
      if (multiplier) multiplier.textContent = String(remaining);
      crashRuntime.countdownTimer = window.setTimeout(tick, 80);
    };
    tick();
  });
}

function updateCrashVisual(multiplier, crashAt) {
  const stage = $("#crash-stage");
  const rocket = $("#crash-rocket");
  const flightLine = $(".crash-flight-line");
  const trajectory = $("#crash-trajectory-progress");
  const trajectoryGlow = $(".crash-trajectory-glow");
  const travelProgress = getCrashTravelProgress(multiplier);
  const displayMultiplier = formatMultiplier(multiplier);
  const multiplierElement = $("#crash-multiplier");
  const cashoutElement = $("#crash-cashout-value");
  if (crashRuntime.displayMultiplier !== displayMultiplier) {
    if (multiplierElement) multiplierElement.textContent = displayMultiplier;
    if (cashoutElement) cashoutElement.textContent = displayMultiplier;
    crashRuntime.displayMultiplier = displayMultiplier;
  }
  const phase =
    multiplier >= 3.5
      ? "high"
      : multiplier >= 1.7
        ? "mid"
        : "low";
  if (crashRuntime.phase !== phase) {
    stage?.classList.remove("phase-low", "phase-mid", "phase-high");
    stage?.classList.add(`phase-${phase}`);
    crashRuntime.phase = phase;
  }
  for (const path of [trajectoryGlow, trajectory].filter(Boolean)) {
    path.style.strokeDasharray = "1";
    path.style.strokeDashoffset = `${1 - travelProgress}`;
  }
  if (rocket && flightLine) {
    const { width, height } = getCrashFlightBounds();
    const point = getCrashTrajectoryPoint(travelProgress);
    const left = (point.x / 100) * width;
    const top = (point.y / 100) * height;
    const flightAngle = getCrashTrajectoryAngle(travelProgress);
    rocket.style.setProperty("--flight-angle", `${flightAngle}deg`);
    rocket.style.transform =
      `translate3d(${left}px, ${top}px, 0) translate(-50%, -50%) rotate(${flightAngle}deg)`;
  }
  stage?.classList.add("running");
}

function getCrashElapsedSeconds(startedAt) {
  const parsedStartedAt = Date.parse(String(startedAt || ""));
  const now = getTimingNow();
  let actualElapsedMs;
  if (crashRuntime.startedPerfMs !== null) {
    actualElapsedMs = Math.max(0, now - crashRuntime.startedPerfMs);
  } else {
    const startedAtMs = Number.isFinite(parsedStartedAt)
      ? parsedStartedAt
      : crashRuntime.startedAtMs ?? Date.now() + serverClockOffsetMs;
    actualElapsedMs = Math.max(0, Date.now() + serverClockOffsetMs - startedAtMs);
  }

  if (crashRuntime.visualCatchupStartedPerfMs !== null) {
    const catchupDurationMs = 800;
    const catchupProgress = Math.min(
      1,
      Math.max(0, (now - crashRuntime.visualCatchupStartedPerfMs) / catchupDurationMs),
    );
    if (catchupProgress < 1) {
      const catchupTargetMs = crashRuntime.visualCatchupElapsedMs + catchupDurationMs;
      return (
        Math.min(actualElapsedMs, catchupTargetMs * catchupProgress) / 1000
      );
    }
    crashRuntime.visualCatchupStartedPerfMs = null;
  }

  return actualElapsedMs / 1000;
}

async function settleCrashRound(gameId) {
  let lastError = null;
  for (let attempt = 0; attempt < 14; attempt += 1) {
    try {
      await runAction(
        "crash_settle",
        { gameId },
        { silent: true },
      );
      if (appState.data?.crash?.active?.id !== gameId) return;
    } catch (error) {
      lastError = error;
      if (error.code !== "crash_not_ready") break;
    }
    if (attempt < 13) {
      await new Promise((resolve) => window.setTimeout(resolve, 450));
      await loadState();
      if (appState.data?.crash?.active?.id !== gameId) return;
    }
  }
  if (lastError && appState.data?.crash?.active?.id === gameId) {
    $("#crash-status").textContent = "Синхронизация результата…";
    crashRuntime.settleRetryTimer = window.setTimeout(() => {
      crashRuntime.settleRetryTimer = null;
      crashRuntime.settling = true;
      settleCrashRound(gameId).finally(() => {
        crashRuntime.settling = false;
      });
    }, 1500);
  }
}

function protectCrashRoundFromLag(gameId, reason) {
  if (
    crashRuntime.lagCashoutRequested ||
    crashRuntime.settling ||
    busyActions.has("crash_cashout") ||
    appState.data?.crash?.active?.id !== gameId
  ) {
    return;
  }
  crashRuntime.lagCashoutRequested = true;
  $("#crash-status").textContent = reason;
  runAction("crash_cashout", { gameId }, { silent: true })
    .catch(() => {})
    .finally(() => {
      crashRuntime.lagCashoutRequested = false;
    });
}

function startCrashAnimation(active) {
  if (
    crashRuntime.gameId === active.id &&
    (crashRuntime.frame !== null || crashRuntime.settling)
  ) {
    return;
  }
  stopCrashAnimation();
  crashRuntime.gameId = active.id;
  const parsedStartedAt = Date.parse(String(active.startedAt || ""));
  crashRuntime.startedAtMs = Number.isFinite(parsedStartedAt)
    ? parsedStartedAt
    : Date.now() + serverClockOffsetMs;
  const initialElapsedMs = Number.isFinite(parsedStartedAt)
    ? Math.max(0, Date.now() + serverClockOffsetMs - parsedStartedAt)
    : 0;
  crashRuntime.startedPerfMs = getTimingNow() - initialElapsedMs;
  crashRuntime.visualCatchupElapsedMs = initialElapsedMs;
  crashRuntime.visualCatchupStartedPerfMs = getTimingNow();
  crashRuntime.lastFramePerfMs = getTimingNow();

  const tick = () => {
    if (!appState.data?.crash?.active || appState.data.crash.active.id !== active.id) {
      crashRuntime.frame = null;
      return false;
    }
    const now = getTimingNow();
    const frameGapMs =
      crashRuntime.lastFramePerfMs === null
        ? 0
        : Math.max(0, now - crashRuntime.lastFramePerfMs);
    crashRuntime.lastFramePerfMs = now;
    if (frameGapMs >= 900) {
      protectCrashRoundFromLag(active.id, "Связь прервалась — забираем ставку…");
    }
    if (crashRuntime.lagCashoutRequested) {
      return true;
    }
    const multiplier = getCrashMultiplier(active.startedAt);
    updateCrashVisual(Math.min(multiplier, active.crashAt), active.crashAt);
    if (multiplier >= active.crashAt) {
      crashRuntime.frame = null;
      crashRuntime.crashed = true;
      $("#crash-cashout").disabled = true;
      $("#crash-status").textContent = `Монета Z улетела на ${formatMultiplier(active.crashAt)}`;
      $("#crash-stage").classList.add("crashed");
      if (!crashRuntime.settling) {
        crashRuntime.settling = true;
        settleCrashRound(active.id).finally(() => {
          crashRuntime.settling = false;
        });
      }
      return false;
    }
    return true;
  };

  const animate = () => {
    if (tick()) {
      if (typeof window.requestAnimationFrame === "function") {
        crashRuntime.frame = window.requestAnimationFrame(animate);
      } else {
        crashRuntime.frame = window.setTimeout(animate, 16);
      }
    }
  };
  animate();
}

function renderCrashHistory(history) {
  const container = $("#crash-history");
  if (!history?.length) {
    container.innerHTML = '<div class="crash-history-empty">Раундов пока нет</div>';
    return;
  }
  container.innerHTML = history
    .map((game) => {
      const won = game.result === "won";
      const time = new Date(game.createdAt).toLocaleTimeString("ru-RU", {
        hour: "2-digit",
        minute: "2-digit",
      });
      return `
        <div class="crash-history-row ${won ? "win" : "loss"}">
          <span class="crash-history-result"><i></i>${won ? "Забрал" : "Срыв"}</span>
          <strong>${formatMultiplier(game.multiplier)}</strong>
          <span class="crash-history-bet">${formatNumber(game.bet)} → ${won ? `+${formatNumber(game.payout)}` : `−${formatNumber(game.bet)}`}</span>
          <time>${time}</time>
        </div>`;
    })
    .join("");
}

function renderCrashRecentMultipliers(history) {
  const container = $("#crash-recent-multipliers");
  if (!container) return;
  const rounds = (history || []).slice(0, 8);
  container.innerHTML = rounds.length
    ? rounds
        .map((game) => {
          const multiplier = Number(game.multiplier || 1);
          const tone = multiplier >= 3.5 ? "high" : multiplier >= 2 ? "mid" : "low";
          return `<span class="crash-recent-pill ${tone}">${formatMultiplier(multiplier)}</span>`;
        })
        .join("")
    : '<span class="crash-recent-pill low">1.00x</span>';
}

function renderRouletteHistory(history) {
  const container = $("#roulette-history");
  if (!container) return;
  if (!history?.length) {
    container.innerHTML = '<div class="crash-history-empty">Игр пока нет</div>';
    return;
  }
  container.innerHTML = history
    .map((game) => {
      const multiplier = Number(game.multiplier || 0);
      const won = game.result === "won" && multiplier > 0;
      const label = multiplier >= 50 ? "Джекпот" : won ? "Выигрыш" : "Мимо";
      const modeLabel = game.mode === "premium" ? "Премиум" : "Обычная";
      const time = new Date(game.createdAt).toLocaleTimeString("ru-RU", {
        hour: "2-digit",
        minute: "2-digit",
      });
      return `
        <div class="crash-history-row ${won ? "win" : "loss"}">
          <span class="crash-history-result"><i></i>${label} <small>${modeLabel}</small></span>
          <strong>${won ? formatMultiplier(multiplier) : "—"}</strong>
          <span class="crash-history-bet">${formatNumber(game.bet)} → ${won ? `+${formatNumber(game.payout)}` : `−${formatNumber(game.bet)}`}</span>
          <time>${time}</time>
        </div>`;
    })
    .join("");
}

function stopRouletteSpin() {
  if (rouletteRuntime.finishTimer !== null) {
    window.clearTimeout(rouletteRuntime.finishTimer);
    rouletteRuntime.finishTimer = null;
  }
  if (rouletteRuntime.frame !== null) {
    window.cancelAnimationFrame(rouletteRuntime.frame);
    rouletteRuntime.frame = null;
  }
  rouletteRuntime.lastFrameAt = null;
  rouletteRuntime.spinning = false;
  rouletteRuntime.previousWallet = null;
  rouletteRuntime.previousRoulette = null;
  const wheel = $("#roulette-wheel");
  if (wheel) {
    wheel.classList.remove("spinning");
    wheel.style.transition = "none";
  }
}

function animateRouletteSpin(now) {
  if (
    !rouletteRuntime.spinning ||
    rouletteRuntime.finishTimer !== null ||
    rouletteRuntime.frame === null
  ) {
    rouletteRuntime.frame = null;
    rouletteRuntime.lastFrameAt = null;
    return;
  }
  const wheel = $("#roulette-wheel");
  if (!wheel) {
    stopRouletteSpin();
    return;
  }
  const lastFrameAt = rouletteRuntime.lastFrameAt ?? now;
  const elapsedMs = Math.min(50, Math.max(0, now - lastFrameAt));
  rouletteRuntime.lastFrameAt = now;
  rouletteRuntime.rotation +=
    (ROULETTE_SPIN_SPEED_DEG_PER_SEC * elapsedMs) / 1000;
  wheel.style.transform = `rotate(${rouletteRuntime.rotation}deg)`;
  rouletteRuntime.frame = window.requestAnimationFrame(animateRouletteSpin);
}

function startRouletteSpin() {
  const wheel = $("#roulette-wheel");
  if (!wheel) return;
  stopRouletteSpin();
  rouletteRuntime.previousWallet = appState.data?.wallet
    ? { ...appState.data.wallet }
    : null;
  rouletteRuntime.previousRoulette = appState.data?.roulette
    ? {
        ...appState.data.roulette,
        history: [...(appState.data.roulette.history || [])],
      }
    : null;
  wheel.style.transition = "none";
  wheel.style.transform = `rotate(${rouletteRuntime.rotation}deg)`;
  rouletteRuntime.spinning = true;
  rouletteRuntime.lastFrameAt = null;
  wheel.classList.add("spinning");
  selectedRouletteBet = null;
  document.querySelectorAll("[data-roulette-bet]").forEach((button) => {
    button.classList.remove("selected");
    button.disabled = true;
  });
  $("#roulette-result").textContent = "Колесо крутится…";
  $("#roulette-hint").textContent = "Смотрим, куда упадёт шарик…";
  rouletteRuntime.frame = window.requestAnimationFrame(animateRouletteSpin);
}

function finishRouletteSpin(actionResult) {
  const wheel = $("#roulette-wheel");
  if (!wheel) return;
  const multiplier = Number(actionResult?.multiplier || 0);
  const mode = actionResult?.mode || selectedRouletteMode;
  const angleByMultiplier =
    mode === "premium"
      ? {
          0: 90,
          2: 135,
          3: 180,
          5: 225,
          10: 315,
          20: 270,
          50: 0,
        }
      : {
          0: 225,
          2: 315,
          3: 135,
          5: 180,
          10: 270,
          50: 0,
        };
  const landingAngle = angleByMultiplier[multiplier] ?? 28;
  const currentRotation = rouletteRuntime.rotation;
  const currentModulo = ((currentRotation % 360) + 360) % 360;
  const correction = (landingAngle - currentModulo + 360) % 360;
  if (rouletteRuntime.frame !== null) {
    window.cancelAnimationFrame(rouletteRuntime.frame);
    rouletteRuntime.frame = null;
  }
  rouletteRuntime.lastFrameAt = null;
  wheel.classList.remove("spinning");
  wheel.style.transform = `rotate(${currentRotation}deg)`;
  void wheel.offsetWidth;
  rouletteRuntime.rotation =
    currentRotation + ROULETTE_SPIN_EXTRA_TURNS * 360 + correction;
  wheel.style.transition = `transform ${ROULETTE_SPIN_DURATION_MS}ms cubic-bezier(0.12, 0.78, 0.16, 1)`;
  wheel.style.transform = `rotate(${rouletteRuntime.rotation}deg)`;
  rouletteRuntime.finishTimer = window.setTimeout(() => {
    rouletteRuntime.spinning = false;
    rouletteRuntime.finishTimer = null;
    rouletteRuntime.previousWallet = null;
    rouletteRuntime.previousRoulette = null;
    const result = Number(actionResult?.multiplier || 0);
    render();
    $("#roulette-result").textContent =
      result > 0
        ? result >= 50
          ? "ДЖЕКПОТ · 50.00x"
          : `Выигрыш · ${formatMultiplier(result)}`
        : "Мимо · ставка сгорела";
    $("#roulette-hint").textContent =
      result > 0 ? "Результат записан в историю." : "Попробуй ещё раз завтра бесплатно.";
    const toastKey = [
      actionResult?.gameId ?? "",
      actionResult?.result ?? "",
      actionResult?.multiplier ?? "",
      actionResult?.payout ?? "",
    ].join(":");
    if (toastKey !== lastRouletteToastKey) {
      lastRouletteToastKey = toastKey;
      if (result > 0) {
        showToast(
          result >= 50
            ? "ДЖЕКПОТ · +50x к ставке"
            : `Выигрыш ${formatNumber(actionResult?.payout)} монет · ${formatMultiplier(result)}`,
        );
        telegram?.HapticFeedback?.notificationOccurred("success");
      } else {
        showToast("Мимо · ставка сгорела", "danger");
        telegram?.HapticFeedback?.notificationOccurred("error");
      }
    }
  }, ROULETTE_SPIN_DURATION_MS + 120);
}

function renderRouletteSegments(mode) {
  const container = $("#roulette-segments");
  if (!container) return;
  container.innerHTML = (ROULETTE_SEGMENTS[mode] || ROULETTE_SEGMENTS.standard)
    .map(
      (segment, index) => `
        <span
          class="roulette-segment-label ${segment.multiplier === 0 ? "miss" : ""}"
          style="--segment-index: ${index}"
        >
          <i>${segment.icon}</i>
          <strong>${segment.label}</strong>
        </span>`,
    )
    .join("");
}

function renderRoulette(data) {
  const roulette = data.roulette || {
    available: false,
    bets: [],
    freeSpinsPerDay: 3,
    freeSpinsRemaining: 0,
    history: [],
    ztCost: 1,
    premiumZtCost: 100,
  };
  const activeBetButtons = document.querySelectorAll("[data-roulette-bet]");
  const modeButtons = document.querySelectorAll("[data-roulette-mode]");
  const spinButton = $("#roulette-spin");
  const rouletteGame = $("#roulette-game");
  const available = roulette.available !== false;
  const premiumZtCost = Number(roulette.premiumZtCost || 100);
  const isPremium = selectedRouletteMode === "premium";
  const freeSpinsAvailable = Number(roulette.freeSpinsRemaining || 0) > 0;
  const canAffordExtraSpin =
    Number(data.wallet.zenoBalance || 0) >= Number(roulette.ztCost || 1);
  const canAffordPremium =
    Number(data.wallet.zenoBalance || 0) >= premiumZtCost;
  rouletteGame?.classList.toggle("premium-mode", isPremium);
  modeButtons.forEach((button) => {
    const selected = button.dataset.rouletteMode === selectedRouletteMode;
    button.classList.toggle("active", selected);
    button.setAttribute("aria-selected", String(selected));
  });
  renderRouletteSegments(selectedRouletteMode);
  $("#roulette-balance").textContent = formatNumber(data.wallet.earnBalance);
  $("#roulette-zt-balance").textContent = `${formatNumber(data.wallet.zenoBalance)} ZT`;
  $("#roulette-free-spins").textContent =
    `${roulette.freeSpinsRemaining} / ${roulette.freeSpinsPerDay}`;
  $("#roulette-cost").textContent =
    isPremium
      ? `Премиум-спин: ${premiumZtCost} ZT`
      : freeSpinsAvailable
        ? "Бесплатный спин"
        : `Доп. спин: ${roulette.ztCost} ZT`;
  renderRouletteHistory(roulette.history);

  activeBetButtons.forEach((button) => {
    button.classList.toggle(
      "selected",
      !rouletteRuntime.spinning &&
        button.dataset.rouletteBet === selectedRouletteBet,
    );
    button.disabled = !available || busyActions.has("roulette_play") || rouletteRuntime.spinning;
  });
  if (!available) {
    $("#roulette-result").textContent = "Игра не настроена";
    $("#roulette-hint").textContent = "Администратору нужно выполнить supabase/schema.sql в Supabase.";
  } else if (!rouletteRuntime.spinning && !rouletteRuntime.finishTimer) {
    $("#roulette-result").textContent = "Готов к прокруту";
    $("#roulette-hint").textContent =
      isPremium
        ? `Премиум-режим: один спин стоит ${premiumZtCost} ZT.`
        : roulette.freeSpinsRemaining > 0
          ? "Выбери ставку и используй бесплатный прокрут."
          : "Бесплатные прокруты закончились — понадобится 1 ZT.";
  }
  if (spinButton) {
    spinButton.disabled =
      !available ||
      busyActions.has("roulette_play") ||
      rouletteRuntime.spinning ||
      (isPremium ? !canAffordPremium : !freeSpinsAvailable && !canAffordExtraSpin);
    spinButton.innerHTML = isPremium
      ? `Крутить премиум <span>↗</span>`
      : freeSpinsAvailable
        ? `Крутить бесплатно <span>↗</span>`
        : `Крутить за ${roulette.ztCost} ZT <span>↗</span>`;
  }
}

function renderCrash(data) {
  const crash = data.crash || { active: null, history: [] };
  const active = crash.active;
  const crashBetLocked =
    Boolean(active) || crashRuntime.countdownActive || busyActions.has("crash_start");
  const customBetInput = $("#crash-custom-bet");
  const openBetButton = $("#crash-open-bet");
  const betSheet = $("#crash-bet-sheet");
  $("#crash-balance").textContent = formatNumber(data.wallet.earnBalance);
  renderCrashHistory(crash.history);
  renderCrashRecentMultipliers(crash.history);

  if (crash.available === false) {
    stopCrashAnimation();
    document.querySelectorAll("[data-crash-bet]").forEach((button) => {
      button.disabled = true;
    });
    if (customBetInput) customBetInput.disabled = true;
    $("#crash-status").textContent = "Игра не настроена";
    $("#crash-multiplier").textContent = "—";
    $("#crash-start").disabled = true;
    if (openBetButton) openBetButton.disabled = true;
    $("#crash-cashout").disabled = true;
    $("#crash-hint").textContent = "Администратору нужно выполнить supabase/schema.sql в Supabase.";
    return;
  }

  document.querySelectorAll("[data-crash-bet]").forEach((button) => {
    button.classList.toggle("selected", button.dataset.crashBet === selectedCrashBet);
    button.disabled = crashBetLocked;
  });
  if (customBetInput) {
    customBetInput.disabled = crashBetLocked;
  }

  if (!active) {
    stopCrashAnimation();
    $("#crash-status").textContent = "Готов к старту";
    $("#crash-multiplier").textContent = "1.00x";
    $("#crash-cashout-value").textContent = "1.00x";
    $("#crash-hint").textContent = "Сделай ставку, чтобы начать раунд.";
    $("#crash-start").disabled = crashBetLocked;
    if (openBetButton) {
      openBetButton.disabled = crashBetLocked;
      openBetButton.classList.toggle("is-locked", crashBetLocked);
      openBetButton.setAttribute("aria-disabled", String(crashBetLocked));
      openBetButton.classList.remove("hidden");
    }
    $("#crash-cashout").disabled = true;
    $("#crash-cashout").classList.add("hidden");
    betSheet?.classList.remove("active");
    betSheet?.setAttribute("aria-hidden", "true");
    if (customBetInput) {
      customBetInput.value = CRASH_PRESET_BETS.has(selectedCrashBet)
        || selectedCrashBet === "all"
        ? ""
        : selectedCrashBet;
    }
    $("#crash-selected-bet").textContent =
      selectedCrashBet === "all"
        ? "Весь баланс"
        : Number.parseInt(selectedCrashBet, 10) > 0
          ? `${formatNumber(selectedCrashBet)} ZT`
          : "Введи сумму";
    return;
  }

  selectedCrashBet = String(active.bet);
  if (customBetInput) customBetInput.value = String(active.bet);
  $("#crash-selected-bet").textContent = `${formatNumber(active.bet)} ZT`;
  $("#crash-status").textContent = "Ракета в полёте";
  $("#crash-hint").textContent = "Забери ставку сейчас — следующий тик может стать крашем.";
  $("#crash-start").disabled = true;
  if (openBetButton) {
    openBetButton.disabled = true;
    openBetButton.classList.add("is-locked");
    openBetButton.classList.remove("hidden");
    openBetButton.setAttribute("aria-disabled", "true");
  }
  $("#crash-cashout").disabled =
    crashRuntime.crashed || busyActions.has("crash_cashout");
  $("#crash-cashout").classList.remove("hidden");
  startCrashAnimation(active);
}

function showToast(message, tone = "success") {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.toggle("danger", tone === "danger");
  toast.classList.add("show");
  window.clearTimeout(showToast.timeout);
  showToast.timeout = window.setTimeout(() => toast.classList.remove("show"), 3000);
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
  const requestStartedAt = getTimingNow();
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
    syncServerClock(payload.serverNow, requestStartedAt, getTimingNow());
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
    appState.data = await request("/webapp/api/state");
    render();
  } catch (error) {
    showError(error.message);
  } finally {
    setLoading(false);
  }
}

function render() {
  const currentData = appState.data;
  if (!currentData) return;
  const data =
    rouletteRuntime.spinning &&
    rouletteRuntime.previousWallet &&
    rouletteRuntime.previousRoulette
      ? {
          ...currentData,
          wallet: rouletteRuntime.previousWallet,
          roulette: rouletteRuntime.previousRoulette,
        }
      : currentData;
  const { wallet, daily, case: caseData, season, user } = data;

  $("#user-name").textContent = user.firstName;
  $("#earn-balance").textContent = formatNumber(wallet.earnBalance);
  $("#zeno-balance").textContent = formatNumber(wallet.zenoBalance);
  $("#screen-balance").textContent = `${formatNumber(wallet.earnBalance)} ZT`;
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
  renderCrash(data);
  renderRoulette(data);

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
  const normalizedView = viewName === "more" ? "profile" : viewName;
  appState.activeView = normalizedView;
  if (normalizedView !== "rocket") closeCrashBetSheet();
  document.querySelectorAll(".view").forEach((view) => {
    view.classList.toggle("hidden", view.id !== `${normalizedView}-view`);
  });
  document.body.classList.remove(
    "screen-home",
    "screen-games",
    "screen-rocket",
    "screen-roulette",
    "screen-season",
    "screen-profile",
    "nested-screen",
  );
  document.body.classList.add(`screen-${normalizedView}`);
  document.body.classList.toggle("nested-screen", !MAIN_VIEWS.has(normalizedView));
  const navView = MAIN_VIEWS.has(normalizedView) ? normalizedView : null;
  document.querySelectorAll(".nav-item").forEach((item) => {
    item.classList.toggle("active", item.dataset.view === navView);
  });
  window.scrollTo(0, 0);
  if (telegram?.HapticFeedback) telegram.HapticFeedback.selectionChanged();
}

async function runAction(action, body = {}, options = {}) {
  if (busyActions.has(action) || !appState.data) return;
  const buttons = document.querySelectorAll(`[data-action="${action}"]`);
  busyActions.add(action);
  buttons.forEach((button) => {
    button.disabled = true;
    button.classList.add("working");
    button.setAttribute("aria-busy", "true");
  });
  try {
    const result = await request("/webapp/api/action", {
      method: "POST",
      body: JSON.stringify({ action, ...body }),
    });
    if (action === "crash_start") {
      if (crashRuntime.countdownTimer !== null) {
        window.clearTimeout(crashRuntime.countdownTimer);
        crashRuntime.countdownTimer = null;
      }
      $("#crash-stage")?.classList.remove("launching");
    }
    const actionResult = result.lastAction;
    if (action === "roulette_play" && actionResult?.type === "roulette_play") {
      finishRouletteSpin(actionResult);
    }
    if (action === "crash_start" && actionResult?.type === "crash_start") {
      appState.data = {
        ...appState.data,
        wallet: {
          ...appState.data.wallet,
          earnBalance: Number(
            result.wallet?.earnBalance ??
              actionResult.balance ??
              Math.max(
                0,
                Number(appState.data.wallet.earnBalance) - Number(actionResult.bet),
              ),
          ),
        },
        crash: {
          ...appState.data.crash,
          active: actionResult.active,
        },
      };
    } else {
      appState.data = result;
    }
    render();
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
    } else if (
      !options.suppressSuccessToast &&
      (actionResult?.type === "crash_cashout" ||
        actionResult?.type === "crash_settle") &&
      (!options.silent || actionResult?.type === "crash_settle")
    ) {
      const toastKey = [
        actionResult.gameId ?? "",
        actionResult.result ?? "",
        actionResult.multiplier ?? "",
        actionResult.payout ?? "",
      ].join(":");
      if (toastKey !== lastCrashToastKey) {
        lastCrashToastKey = toastKey;
        if (actionResult.result === "won") {
          showToast(
            `Забрано ${formatNumber(actionResult.payout)} монет на ${formatMultiplier(actionResult.multiplier)}`,
          );
          telegram?.HapticFeedback?.notificationOccurred("success");
        } else {
          showToast(
            `ПРОИГРЫШ на ${formatMultiplier(actionResult.multiplier)} · ставка сгорела`,
            "danger",
          );
          telegram?.HapticFeedback?.notificationOccurred("error");
        }
      }
    }
  } catch (error) {
    if (action === "roulette_play") {
      stopRouletteSpin();
      renderRoulette(appState.data);
    }
    if (!options.silent) {
      if (error.code === "daily_cooldown" && error.nextAt) {
        showToast(`Бонус будет доступен через ${formatRemaining(error.nextAt)}`, "danger");
      } else if (error.code === "case_limit" && error.nextAt) {
        showToast(`Следующий кейс через ${formatRemaining(error.nextAt)}`, "danger");
      } else {
        showToast(error.message, "danger");
      }
      return;
    }
    throw error;
  } finally {
    if (action === "crash_start") {
      if (crashRuntime.countdownTimer !== null) {
        window.clearTimeout(crashRuntime.countdownTimer);
        crashRuntime.countdownTimer = null;
      }
      $("#crash-stage")?.classList.remove("launching");
    }
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
    setView("profile");
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

function openCrashBetSheet() {
  if (
    appState.data?.crash?.active ||
    crashRuntime.countdownActive ||
    busyActions.has("crash_start")
  ) {
    return;
  }
  const sheet = $("#crash-bet-sheet");
  const backdrop = $("#crash-bet-sheet-backdrop");
  if (!sheet || !backdrop) return;
  backdrop.classList.remove("hidden");
  sheet.classList.add("active");
  sheet.setAttribute("aria-hidden", "false");
  document.body.classList.add("crash-sheet-open");
  window.setTimeout(() => $("#crash-custom-bet")?.focus(), 180);
}

function closeCrashBetSheet() {
  const sheet = $("#crash-bet-sheet");
  const backdrop = $("#crash-bet-sheet-backdrop");
  sheet?.classList.remove("active");
  sheet?.setAttribute("aria-hidden", "true");
  backdrop?.classList.add("hidden");
  document.body.classList.remove("crash-sheet-open");
}

document.querySelectorAll(".nav-item, [data-view]").forEach((button) => {
  button.addEventListener("click", () => {
    if (button.dataset.view) setView(button.dataset.view);
  });
});

document.querySelectorAll(".nav-item[data-action]").forEach((button) => {
  button.addEventListener("click", () => {
    setView("home");
    runAction(button.dataset.action);
  });
});

document.querySelector('[data-action="case"]').addEventListener("click", () => runAction("case"));
document.querySelector('[data-action="daily"]').addEventListener("click", () => runAction("daily"));
document.querySelector('[data-action="withdraw"]').addEventListener("click", openWithdraw);
document.querySelectorAll('[data-action="friends"]').forEach((button) => {
  button.addEventListener("click", copyReferral);
});

document.querySelectorAll("[data-crash-bet]").forEach((button) => {
  button.addEventListener("click", () => {
    if (
      appState.data?.crash?.active ||
      crashRuntime.countdownActive ||
      busyActions.has("crash_start")
    ) {
      return;
    }
    selectedCrashBet = button.dataset.crashBet;
    const customBetInput = $("#crash-custom-bet");
    if (customBetInput) customBetInput.value = "";
    document.querySelectorAll("[data-crash-bet]").forEach((item) => {
      item.classList.toggle("selected", item === button);
    });
    $("#crash-selected-bet").textContent =
      selectedCrashBet === "all"
        ? "Весь баланс"
        : `${formatNumber(selectedCrashBet)} ZT`;
  });
});

document.querySelectorAll("[data-roulette-bet]").forEach((button) => {
  button.addEventListener("click", () => {
    if (
      appState.data?.roulette?.available === false ||
      busyActions.has("roulette_play") ||
      rouletteRuntime.spinning
    ) {
      return;
    }
    selectedRouletteBet = button.dataset.rouletteBet;
    document.querySelectorAll("[data-roulette-bet]").forEach((item) => {
      item.classList.toggle("selected", item === button);
    });
  });
});

document.querySelectorAll("[data-roulette-mode]").forEach((button) => {
  button.addEventListener("click", () => {
    if (busyActions.has("roulette_play") || rouletteRuntime.spinning) return;
    selectedRouletteMode = button.dataset.rouletteMode || "standard";
    renderRoulette(appState.data);
  });
});

$("#crash-custom-bet").addEventListener("input", (event) => {
  if (
    appState.data?.crash?.active ||
    crashRuntime.countdownActive ||
    busyActions.has("crash_start")
  ) {
    return;
  }
  const input = event.currentTarget;
  const value = input.value.replace(/[^\d]/g, "");
  input.value = value;
  selectedCrashBet = value;
  document.querySelectorAll("[data-crash-bet]").forEach((button) => {
    button.classList.remove("selected");
  });
  $("#crash-selected-bet").textContent =
    Number.parseInt(value, 10) > 0 ? `${formatNumber(value)} ZT` : "Введи сумму";
});

$("#crash-open-bet").addEventListener("click", openCrashBetSheet);
$("#crash-close-bet").addEventListener("click", closeCrashBetSheet);
$("#crash-bet-sheet-backdrop").addEventListener("click", closeCrashBetSheet);

$("#crash-start").addEventListener("click", async () => {
  if (
    appState.data?.crash?.active ||
    crashRuntime.countdownActive ||
    busyActions.has("crash_start")
  ) {
    return;
  }
  const parsedBet = Number.parseInt(selectedCrashBet, 10);
  if (
    selectedCrashBet !== "all" &&
    (!Number.isSafeInteger(parsedBet) || parsedBet <= 0)
  ) {
    showToast("Введи сумму ставки", "danger");
    $("#crash-custom-bet").focus();
    return;
  }
  const bet = selectedCrashBet === "all" ? "all" : parsedBet;
  closeCrashBetSheet();
  const countdownCompleted = await startCrashCountdown();
  if (!countdownCompleted) return;
  runAction("crash_start", { bet });
});

$("#crash-cashout").addEventListener("click", () => {
  const gameId = appState.data?.crash?.active?.id;
  if (gameId && !crashRuntime.crashed) {
    runAction("crash_cashout", { gameId });
  }
});

$("#roulette-spin").addEventListener("click", () => {
  if (
    rouletteRuntime.spinning ||
    busyActions.has("roulette_play") ||
    appState.data?.roulette?.available === false
  ) {
    return;
  }
  const bet = Number.parseInt(selectedRouletteBet, 10);
  if (!ROULETTE_PRESET_BETS.has(String(bet))) {
    showToast("Выбери ставку 10, 50, 100 или 500", "danger");
    return;
  }
  startRouletteSpin();
  runAction("roulette_play", { bet, mode: selectedRouletteMode });
});

$("#refresh-button").addEventListener("click", loadState);
document.addEventListener("visibilitychange", () => {
  const activeGame = appState.data?.crash?.active;
  if (!activeGame) return;
  if (document.visibilityState === "hidden") {
    protectCrashRoundFromLag(activeGame.id, "Мини-апп свёрнут — забираем ставку…");
  } else {
    loadState();
  }
});
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
window.addEventListener("resize", () => {
  crashRuntime.bounds = null;
});
loadState();