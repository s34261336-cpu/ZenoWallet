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
const minesRuntime = {
  selectedBet: 10,
  markupReady: false,
  pendingCell: null,
  pendingGameId: null,
  pendingAction: null,
};
const arenaRuntime = {
  pollTimer: null,
  countdownTimer: null,
  pollInFlight: false,
  notice: "",
  raceTimer: null,
  raceAnimating: false,
  lastAnimatedRoundId: null,
  lastObservedRoundId: null,
  lastObservedRoundStatus: null,
};
const ARENA_POLL_INTERVAL_MS = 3000;

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

function getTelegramPhotoUrl() {
  const photoUrl = telegram?.initDataUnsafe?.user?.photo_url;
  return typeof photoUrl === "string" ? photoUrl : "";
}

function applyPhotoAvatar(avatar, photoUrl) {
  avatar.classList.toggle("has-photo", Boolean(photoUrl));
  avatar.style.setProperty(
    "--avatar-image",
    photoUrl ? `url("${photoUrl.replaceAll('"', "%22")}")` : "none",
  );
}

function setAvatars(user, progress) {
  const photoUrl = getTelegramPhotoUrl();
  const initials = getInitials(user?.firstName);
  document.querySelectorAll(".avatar-ring").forEach((avatar) => {
    avatar.style.setProperty("--ring-progress", `${Math.max(0, Math.min(100, progress))}%`);
    applyPhotoAvatar(avatar, photoUrl);
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
    premiumFee: 100,
  };
  const activeBetButtons = document.querySelectorAll("[data-roulette-bet]");
  const modeButtons = document.querySelectorAll("[data-roulette-mode]");
  const spinButton = $("#roulette-spin");
  const rouletteGame = $("#roulette-game");
  const available = roulette.available !== false;
  const premiumFee = Number(roulette.premiumFee || 100);
  const isPremium = selectedRouletteMode === "premium";
  const freeSpinsAvailable = Number(roulette.freeSpinsRemaining || 0) > 0;
  const canAffordExtraSpin =
    Number(data.wallet.zenoBalance || 0) >= Number(roulette.ztCost || 1);
  const selectedBet = Number.parseInt(selectedRouletteBet, 10) || 0;
  const canAffordPremium =
    Number(data.wallet.earnBalance || 0) >= selectedBet + premiumFee;
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
      ? `Премиум-спин: ${premiumFee} монет + ставка`
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
        ? `Премиум-режим: комиссия ${premiumFee} монет и ставка списываются с основного баланса.`
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

function ensureMinesMarkup() {
  const view = $("#mining-view");
  if (!view || minesRuntime.markupReady) return;
  view.innerHTML = `
    <button class="back-link" data-view="games" type="button">← Назад</button>
    <div class="section-heading rocket-heading">
      <div>
        <span class="eyebrow">Игровая зона</span>
        <h2>Мины <span class="crash-title-mark mining-title-mark">MINES</span></h2>
      </div>
      <span class="season-pill mining-live-pill"><i></i> LIVE</span>
    </div>
    <p class="crash-intro">Открой монеты на поле 5×5. Три клетки — мины. Чем больше открыл, тем выше множитель.</p>
    <section class="mines-game" aria-label="Игра Мины">
      <div class="mines-board-card">
        <div class="mines-board-heading">
          <div><span class="eyebrow">Раунд</span><strong id="mines-round-status">Новая игра</strong></div>
          <div class="mines-live-balance"><span>Баланс</span><strong><b id="mines-balance">—</b> монет</strong></div>
        </div>
        <div class="mines-grid" id="mines-grid" role="grid" aria-label="Поле 5 на 5"></div>
        <div class="mines-multiplier-row"><span><b id="mines-cells-opened">0</b> клеток</span><strong id="mines-multiplier">1.00x</strong></div>
      </div>
      <div class="mines-panel">
        <div class="mines-panel-heading">
          <div><span class="eyebrow">Ставка</span><strong id="mines-selected-bet">10 монет</strong></div>
          <span class="mines-free-pill" id="mines-free-status">5 бесплатных игр</span>
        </div>
        <div class="crash-bet-grid mines-bet-grid" role="group" aria-label="Размер ставки">
          <button type="button" data-mines-bet="10">10</button>
          <button type="button" data-mines-bet="50">50</button>
          <button type="button" data-mines-bet="100">100</button>
          <button type="button" data-mines-bet="500">500</button>
        </div>
        <div class="mines-cost-line"><span id="mines-cost-label">Первые 5 игр бесплатно</span><strong id="mines-zt-cost">0 ZT</strong></div>
        <div class="mines-actions">
          <button class="primary-button mines-start-button" id="mines-start" data-action="mines_start" type="button">Начать игру <span>↗</span></button>
          <button class="mines-cashout-button" id="mines-cashout" data-action="mines_cashout" type="button" disabled>Забрать <strong id="mines-cashout-value">0 монет</strong></button>
        </div>
        <p class="crash-hint" id="mines-hint">Открой первую клетку, чтобы начать охоту за множителем.</p>
      </div>
    </section>
    <section class="mines-rules-card">
      <div class="section-heading compact-heading"><div><span class="eyebrow">Множители</span><h3>Риск растёт с каждой монетой</h3></div><span class="history-count">3 мины</span></div>
      <div class="mines-multiplier-grid"><span><b>1</b><strong>1.1x</strong></span><span><b>3</b><strong>1.5x</strong></span><span><b>5</b><strong>2x</strong></span><span><b>10</b><strong>5x</strong></span><span><b>20</b><strong>20x</strong></span></div>
      <p>Кнопка «Забрать» фиксирует ставку × множитель. Мина завершает игру и сжигает ставку.</p>
    </section>
    <section class="crash-history-card mines-history-card">
      <div class="section-heading compact-heading"><div><span class="eyebrow">Последние раунды</span><h3>История Мины</h3></div><span class="history-count">10 максимум</span></div>
      <div class="mines-history" id="mines-history"><div class="crash-history-empty">Игр пока нет</div></div>
    </section>`;
  minesRuntime.markupReady = true;
}

function renderMining(data) {
  ensureMinesMarkup();
  const mines = data.mines || {
    available: false,
    bets: [10, 50, 100, 500],
    freeGamesRemaining: 5,
    nextZtCost: 5,
    active: null,
    history: [],
  };
  const active = mines.active;
  const lastAction = data.lastAction?.type?.startsWith("mines_") ? data.lastAction : null;
  const balance = Number(data.wallet?.earnBalance || 0);
  const selectedBet = active ? Number(active.bet) : Number(minesRuntime.selectedBet);
  const busyStart =
    busyActions.has("mines_start") ||
    minesRuntime.pendingAction === "mines_start";
  const busyReveal = busyActions.has("mines_reveal");
  const busyCashout =
    busyActions.has("mines_cashout") ||
    minesRuntime.pendingAction === "mines_cashout";
  const opened = new Set((active?.openedCells || []).map(Number));
  const pendingCell =
    minesRuntime.pendingGameId === active?.id ? minesRuntime.pendingCell : null;
  const revealedMines = lastAction?.minePositions || [];
  const ended = !active && lastAction?.type === "mines_reveal" && lastAction.result === "lost";

  $("#mines-balance").textContent = formatNumber(balance);
  $("#mines-selected-bet").textContent = `${formatNumber(selectedBet)} монет`;
  $("#mines-cells-opened").textContent = formatNumber(active?.cellsOpened || lastAction?.cellsOpened || 0);
  $("#mines-multiplier").textContent = formatMultiplier(active?.multiplier || lastAction?.multiplier || 1);
  $("#mines-round-status").textContent = active
    ? `Открыто ${active.cellsOpened} из 22`
    : ended ? "Мина! Ставка сгорела" : "Новая игра";
  $("#mines-free-status").textContent = mines.freeGamesRemaining > 0
    ? `${mines.freeGamesRemaining} бесплатных игр`
    : `Дальше ${formatNumber(mines.nextZtCost)} ZT`;
  $("#mines-cost-label").textContent = mines.freeGamesRemaining > 0
    ? "Первые 5 игр бесплатно"
    : "Плата за следующий раунд";
  $("#mines-zt-cost").textContent = mines.freeGamesRemaining > 0 ? "0 ZT" : `${formatNumber(mines.nextZtCost)} ZT`;

  document.querySelectorAll("[data-mines-bet]").forEach((button) => {
    button.classList.toggle("selected", Number(button.dataset.minesBet) === selectedBet);
    button.disabled = Boolean(active) || busyStart;
  });

  const grid = $("#mines-grid");
  if (grid) {
    grid.innerHTML = Array.from({ length: 25 }, (_, index) => {
      const isOpen = opened.has(index);
      const isMine = revealedMines.includes(index);
      const isClickedMine = lastAction?.type === "mines_reveal" && lastAction.cell === index && lastAction.mine;
      const isPending = pendingCell === index;
      const classes = ["mines-cell"];
      if (isOpen) classes.push("safe");
      if (isMine) classes.push("mine");
      if (isClickedMine) classes.push("explode");
      if (isPending) classes.push("pending");
      return `<button class="${classes.join(" ")}" data-mines-cell="${index}" type="button" role="gridcell" aria-label="Клетка ${index + 1}" ${!active || isOpen || busyReveal || isPending ? "disabled" : ""}>${isPending ? "…" : isOpen ? "✦" : isMine ? "✹" : ""}</button>`;
    }).join("");
  }

  const startButton = $("#mines-start");
  const cashoutButton = $("#mines-cashout");
  const canStart = mines.available !== false && !active && !busyStart && balance >= selectedBet;
  startButton.disabled = !canStart;
  startButton.innerHTML = mines.available === false
    ? "Игра не настроена"
    : minesRuntime.pendingAction === "mines_start"
      ? "Запускаем…"
      : balance < selectedBet
        ? `Нужно ещё ${formatNumber(selectedBet - balance)} монет`
        : "Начать игру <span>↗</span>";
  cashoutButton.disabled = !active || active.cellsOpened < 1 || busyCashout || busyReveal;
  const cashoutValue = active
    ? `${formatNumber(Math.floor(active.bet * active.multiplier))} монет`
    : "0 монет";
  cashoutButton.innerHTML = minesRuntime.pendingAction === "mines_cashout"
    ? "Забираем…"
    : `Забрать <strong id="mines-cashout-value">${cashoutValue}</strong>`;
  $("#mines-hint").textContent = mines.available === false
    ? "Администратору нужно выполнить обновлённый supabase/schema.sql в Supabase."
    : active
      ? "Продолжай открывать клетки или забери выигрыш, пока мина не нашла тебя."
      : ended
        ? "Раунд завершён. Выбери ставку и начни новую игру."
        : "Открой первую клетку, чтобы начать охоту за множителем.";
  renderMiningHistory(mines.history);
}

function renderMiningHistory(history) {
  const container = $("#mines-history");
  if (!container) return;
  if (!history?.length) {
    container.innerHTML = '<div class="crash-history-empty">Игр пока нет</div>';
    return;
  }
  container.innerHTML = history
    .map((item) => {
      const won = item.result === "won";
      return `
        <div class="mining-history-row ${won ? "win" : "loss"}">
          <span><i></i>${won ? "Забрано" : "Мина"} · ${formatNumber(item.bet)} монет</span>
          <strong>${won ? `+${formatNumber(item.payout)} монет` : "− ставка"}</strong>
        </div>`;
    })
    .join("");
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

function getArenaSecondsRemaining(round) {
  if (!round?.endsAt || round.status !== "open") return 0;
  const endAt = Date.parse(round.endsAt);
  if (!Number.isFinite(endAt)) return 0;
  return Math.max(0, Math.ceil((endAt - (Date.now() + serverClockOffsetMs)) / 1000));
}

function updateArenaCountdown() {
  const arena = appState.data?.arena;
  const round = arena?.round;
  const countdown = $("#arena-countdown");
  const timer = $("#arena-timer");
  const timerLabel = $("#arena-timer-label");
  const timerUnit = $("#arena-timer-unit");
  const joinButton = $("#arena-join-button");
  const track = document.querySelector(".arena-round-track > span");
  if (!countdown) return;

  const setTimerMode = (mode, value) => {
    timer?.classList.toggle("is-resolving", mode === "resolving");
    timer?.classList.toggle("is-finished", mode === "finished");
    if (timerLabel) timerLabel.hidden = mode !== "countdown";
    if (timerUnit) timerUnit.hidden = mode !== "countdown";
    countdown.textContent = value;
    timer?.setAttribute(
      "aria-label",
      mode === "resolving"
        ? "Определяем победителя"
        : mode === "finished"
          ? "Раунд завершён"
          : "Время до закрытия ставок",
    );
  };

  if (!round) {
    setTimerMode("countdown", "--");
    if (track) track.style.width = "0%";
    return;
  }

  if (round.status !== "open") {
    setTimerMode(
      arenaRuntime.raceAnimating ? "resolving" : "finished",
      arenaRuntime.raceAnimating ? "Определяем победителя…" : "Завершено",
    );
    if (track) track.style.width = "100%";
    return;
  }

  const seconds = getArenaSecondsRemaining(round);
  setTimerMode("countdown", String(seconds));

  const startedAt = Date.parse(round.startedAt || "");
  const endsAt = Date.parse(round.endsAt || "");
  if (track && Number.isFinite(startedAt) && Number.isFinite(endsAt)) {
    const duration = Math.max(1, endsAt - startedAt);
    const elapsed = Math.max(0, Math.min(duration, Date.now() + serverClockOffsetMs - startedAt));
    track.style.width = `${Math.round((elapsed / duration) * 100)}%`;
  }

  if (seconds === 0 && joinButton && !busyActions.has("arena_join")) {
    joinButton.disabled = true;
    joinButton.querySelector("span").textContent = "Приём закрыт";
  }
}

function renderArenaHistory(history) {
  const container = $("#arena-history");
  if (!container) return;
  const rounds = Array.isArray(history) ? history : [];
  if (!rounds.length) {
    container.innerHTML = `
      <div class="arena-history-empty">
        <span class="arena-history-empty-mark" aria-hidden="true">—</span>
        <span><strong>История появится здесь</strong><small>Завершённые раунды и их победители</small></span>
      </div>`;
    return;
  }
  container.innerHTML = rounds
    .map((round) => {
      const winner = escapeHtml(round.winnerName || "Участник");
      const finishedAt = round.finishedAt
        ? new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit" }).format(
            new Date(round.finishedAt),
          )
        : "";
      return `
        <div class="arena-history-row">
          <span class="arena-history-row-mark" aria-hidden="true">${escapeHtml(
            round.winnerAvatar || getInitials(round.winnerName),
          )}</span>
          <span class="arena-history-row-copy">
            <strong>${winner}</strong>
            <small>Раунд #${formatNumber(round.id)}${finishedAt ? ` · ${finishedAt}` : ""}</small>
          </span>
          <span class="arena-history-row-prize">
            <strong>${formatNumber(round.payout || 0)}</strong>
            <small>из ${formatNumber(round.totalPot || 0)} ZT</small>
          </span>
        </div>`;
    })
    .join("");
}

function maybeAnimateArenaRound(round) {
  if (!round?.id) {
    arenaRuntime.lastObservedRoundId = null;
    arenaRuntime.lastObservedRoundStatus = null;
    return;
  }

  if (arenaRuntime.lastObservedRoundId !== round.id) {
    if (arenaRuntime.raceTimer !== null) {
      window.clearTimeout(arenaRuntime.raceTimer);
      arenaRuntime.raceTimer = null;
    }
    arenaRuntime.raceAnimating = false;
    arenaRuntime.lastObservedRoundId = round.id;
    arenaRuntime.lastObservedRoundStatus = round.status;
    return;
  }

  const justFinished =
    round.status === "finished" && arenaRuntime.lastObservedRoundStatus === "open";
  arenaRuntime.lastObservedRoundStatus = round.status;
  if (!justFinished || arenaRuntime.lastAnimatedRoundId === round.id) return;

  arenaRuntime.lastAnimatedRoundId = round.id;
  arenaRuntime.raceAnimating = true;
  if (arenaRuntime.raceTimer !== null) {
    window.clearTimeout(arenaRuntime.raceTimer);
  }
  arenaRuntime.raceTimer = window.setTimeout(() => {
    arenaRuntime.raceAnimating = false;
    arenaRuntime.raceTimer = null;
    if (appState.data?.arena?.round?.id === round.id) {
      renderArena(appState.data);
    }
  }, window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? 350 : 2600);
}

function renderArenaRace(round) {
  const stage = $("#arena-race-stage");
  const lanes = $("#arena-race-lanes");
  if (!stage || !lanes) return;

  const sections = [
    { letter: "С", color: "coral" },
    { letter: "М", color: "mint" },
    { letter: "И", color: "blue" },
  ];

  stage.classList.toggle("is-finished", round?.status === "finished");
  stage.classList.toggle("is-animating", arenaRuntime.raceAnimating);
  stage.dataset.state = round?.status || "waiting";
  stage.style.setProperty("--arena-orb-x", "50%");
  lanes.innerHTML = sections
    .map(
      (section, index) => `
        <div class="arena-race-lane arena-lane-${section.color}" data-lane="${section.letter}" aria-label="Секция ${section.letter}">
          <span class="arena-lane-glow" aria-hidden="true"></span>
          <span class="arena-lane-letter">${section.letter}</span>
        </div>`,
    )
    .join("");
  const orb = document.createElement("span");
  orb.className = "arena-race-orb";
  orb.setAttribute("aria-hidden", "true");
  stage.querySelector(".arena-race-orb")?.remove();
  stage.append(orb);
}

function renderArena(data) {
  const arena = data.arena || {};
  const round = arena.round;
  const participants = Array.isArray(round?.participants) ? round.participants : [];
  maybeAnimateArenaRound(round);
  const walletBalance = Math.max(0, Number(data.wallet?.zenoBalance || 0));
  const input = $("#arena-bet-input");
  const joinButton = $("#arena-join-button");
  if (!input || !joinButton) return;

  const available = arena.available !== false;
  const open = available && round?.status === "open";
  const secondsRemaining = open ? getArenaSecondsRemaining(round) : 0;
  const canStartRound = !round || round.status === "finished";
  const canAddToRound = open && secondsRemaining > 0;
  const canPlaceBet = available && (canStartRound || canAddToRound);
  const minBet = Math.max(1, Number(arena.minBet || 1));
  const maxBet = Math.max(minBet, Number(arena.maxBet || 10_000));
  if (!input.value.trim()) input.value = String(minBet);
  const rawBet = input.value.trim();
  const parsedBet = rawBet === "" ? 0 : Number(rawBet);
  const validBet =
    Number.isSafeInteger(parsedBet) &&
    parsedBet >= minBet &&
    parsedBet <= maxBet &&
    parsedBet <= walletBalance;
  const currentBet = open ? Number(round?.myEntry?.bet || 0) : 0;
  const additionalBet = validBet ? parsedBet : 0;
  const projectedBet = currentBet + additionalBet;
  const projectedPot = (open ? Number(round?.totalPot || 0) : 0) + additionalBet;
  const projectedChance =
    projectedPot > 0 && projectedBet > 0
      ? Math.min(100, (projectedBet / projectedPot) * 100)
      : 0;
  const numberFormat = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 });

  $("#arena-round-id").textContent = round?.id ? `Игра #${round.id}` : "Ожидание ставки";
  $("#arena-round-state").textContent = !available
    ? "Недоступна"
    : round?.status === "finished" && arenaRuntime.raceAnimating
      ? "Определяем победителя"
      : round?.status === "finished"
        ? "Завершено"
      : round?.status === "open"
        ? "Ставки открыты"
        : "Ожидание ставки";
  $("#arena-min-bet").textContent = formatNumber(minBet);
  $("#arena-pool").innerHTML = `${formatNumber(round?.totalPot || 0)} <small>✦</small>`;
  $("#arena-balance").textContent = `${formatNumber(walletBalance)} ✦`;
  $("#arena-bank").textContent = `${formatNumber(currentBet)} ✦`;
  renderArenaRace(round);

  const betChips = $("#arena-bet-chips");
  if (betChips) {
    const participantBets = participants
      .slice(-4)
      .map((participant) => Number(participant.bet || 0))
      .filter((bet) => Number.isSafeInteger(bet) && bet > 0);
    const presets = [
      minBet,
      Math.min(maxBet, minBet * 2),
      Math.min(maxBet, minBet * 5),
      Math.min(maxBet, 15),
    ];
    const amounts = participantBets.length ? participantBets : [...new Set(presets)];
    let selectedChipAssigned = false;
    betChips.innerHTML = amounts
      .map((amount, index) => {
        const disabled =
          !available ||
          !canPlaceBet ||
          busyActions.has("arena_join") ||
          amount > walletBalance ||
          amount > maxBet;
        const selected = amount === parsedBet && !selectedChipAssigned;
        if (selected) selectedChipAssigned = true;
        return `
          <button
            class="${selected ? "is-selected" : ""}"
            type="button"
            data-arena-bet="${amount}"
            style="--chip-index:${index}"
            ${disabled ? "disabled" : ""}
            aria-pressed="${selected}"
          >${formatNumber(amount)} <i aria-hidden="true">✦</i></button>`;
      })
      .join("");
  }

  const participantCount = document.querySelector(".arena-participant-count");
  if (participantCount) {
    participantCount.textContent = `${participants.length} ${
      participants.length === 1 ? "участник" : "участников"
    }`;
  }
  const contestants = $("#arena-contestants");
  contestants.innerHTML = participants.length
    ? participants
        .map((participant) => {
          const isBot = Boolean(participant.isBot);
          const name = escapeHtml(participant.name || "Участник");
          const photoUrl = participant.isMe ? getTelegramPhotoUrl() : "";
          const classes = [
            "arena-contestant",
            isBot ? "arena-contestant-bot" : "",
            participant.isMe ? "arena-contestant-me" : "",
            participant.isWinner && !arenaRuntime.raceAnimating
              ? "arena-contestant-winner"
              : "",
          ]
            .filter(Boolean)
            .join(" ");
          return `
            <article class="${classes}">
              <span
                class="arena-contestant-mark${photoUrl ? " has-photo" : ""}"
                ${photoUrl ? `data-photo-avatar="${escapeHtml(photoUrl)}"` : ""}
                aria-hidden="true"
              >${photoUrl ? "" : escapeHtml(participant.avatar || getInitials(participant.name))}</span>
              <span class="arena-contestant-name">
                <strong>${name}</strong>
              </span>
              <span class="arena-contestant-stake">
                <strong>${formatNumber(participant.bet)} ZT</strong><small>ставка</small>
              </span>
              <span class="arena-contestant-chance">
                <strong>${numberFormat.format(Number(participant.chance || 0))}%</strong><small>шанс</small>
              </span>
            </article>`;
        })
        .join("")
    : '<div class="arena-contestants-hint">Поставь, чтобы начать раунд.</div>';

  const winner = round?.winner;
  const resolvingWinner =
    round?.status === "finished" && arenaRuntime.raceAnimating;
  if (round?.status === "finished" && winner && !resolvingWinner) {
    const winnerName = escapeHtml(winner.name || "Участник");
    const winnerPhotoUrl = winner.isMe ? getTelegramPhotoUrl() : "";
    const resultText =
      round.myResult === "won"
        ? `Ты победил и получил ${formatNumber(winner.payout || round.payout || 0)} ZT`
        : round.myResult === "lost"
          ? "В этот раз победил другой участник"
          : `Ставка ${formatNumber(winner.bet || 0)} ZT · шанс ${numberFormat.format(
              Number(winner.chance || 0),
            )}%`;
    $("#arena-winner-panel").innerHTML = `
      <span
        class="arena-winner-symbol${winnerPhotoUrl ? " has-photo" : ""}"
        ${winnerPhotoUrl ? `data-photo-avatar="${escapeHtml(winnerPhotoUrl)}"` : ""}
        aria-hidden="true"
      >${winnerPhotoUrl ? "" : escapeHtml(winner.avatar || getInitials(winner.name))}</span>
      <span><small>ПОБЕДИТЕЛЬ РАУНДА</small><strong>${resultText} · ${winnerName}</strong></span>
      <span class="arena-winner-prize">${formatNumber(winner.payout || round.payout || 0)}<small>ZT</small></span>`;
    $("#arena-winner-panel").classList.remove("hidden");
  } else {
    $("#arena-winner-panel").innerHTML = `
      <span class="arena-winner-symbol" aria-hidden="true">01</span>
      <span><small>ПОБЕДИТЕЛЬ РАУНДА</small><strong>${
        resolvingWinner
          ? "Определяем победителя…"
          : round?.myEntry
            ? "Ты в раунде. Итог будет после таймера."
            : "Определится после окончания таймера"
      }</strong></span>
      <span class="arena-winner-prize">90%<small>пула</small></span>`;
    $("#arena-winner-panel").classList.add("hidden");
  }

  document
    .querySelectorAll("#arena-contestants [data-photo-avatar], #arena-winner-panel [data-photo-avatar]")
    .forEach((avatar) => applyPhotoAvatar(avatar, avatar.dataset.photoAvatar || ""));

  if (!available) {
    $("#arena-notice").textContent =
      "Арена пока не настроена. Администратору нужно выполнить supabase/arena.sql.";
  } else if (!round) {
    $("#arena-notice").textContent = "Поставь, чтобы запустить арену.";
  } else if (resolvingWinner) {
    $("#arena-notice").textContent = "Ставки закрыты. Определяем победителя…";
  } else if (round.status === "finished") {
    $("#arena-notice").textContent = "Раунд завершён. Поставь, чтобы начать следующий.";
  } else if (round.myEntry) {
    $("#arena-notice").textContent = `Твоя ставка: ${formatNumber(
      currentBet,
    )} ZT. Можешь добавить ставку до закрытия входа.`;
  } else {
    $("#arena-notice").textContent = "Вход открыт. Ставка будет списана с баланса сразу.";
  }
  if (arenaRuntime.notice) $("#arena-notice").textContent = arenaRuntime.notice;

  input.min = String(minBet);
  input.max = String(Math.min(maxBet, walletBalance));
  input.disabled =
    !canPlaceBet || busyActions.has("arena_join");
  const allInButton = document.querySelector("[data-arena-all-in]");
  if (allInButton) {
    allInButton.disabled =
      !available ||
      !canPlaceBet ||
      busyActions.has("arena_join") ||
      walletBalance < minBet;
  }
  const canJoin =
    canPlaceBet &&
    validBet &&
    !busyActions.has("arena_join");
  joinButton.disabled = !canJoin;
  joinButton.setAttribute("aria-busy", String(busyActions.has("arena_join")));
  joinButton.querySelector("span").textContent = busyActions.has("arena_join")
    ? "Ставим…"
    : !available
      ? "Арена недоступна"
      : open && secondsRemaining <= 0
        ? "Приём закрыт"
        : open && round.myEntry
          ? "Поставить ещё"
          : open
            ? "Поставить"
            : "Начать раунд";
  $("#arena-bet-summary").innerHTML = `
    <div><span>Твой шанс победы</span><strong>${
      projectedChance > 0 ? `${numberFormat.format(projectedChance)}%` : "—%"
    }</strong></div>
    <div><span>Приз победителю</span><strong>90% пула</strong></div>`;

  renderArenaHistory(arena.history);
  updateArenaCountdown();
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
  const seasonPoints = Math.max(0, Number(season.points || 0));
  const giftPathTarget = 300;
  const giftPathProgress = Math.max(
    0,
    Math.min(100, (seasonPoints / giftPathTarget) * 100),
  );
  const giftProgressFill = $("#gift-progress-fill");
  const giftProgressLabel = $("#gift-progress-label");
  const giftProgressTrack = document.querySelector(".gift-progress-track");
  if (giftProgressFill) giftProgressFill.style.width = `${giftPathProgress}%`;
  if (giftProgressTrack) {
    giftProgressTrack.style.setProperty("--gift-progress", `${giftPathProgress}%`);
  }
  if (giftProgressLabel) {
    giftProgressLabel.textContent = `${formatNumber(
      Math.min(seasonPoints, giftPathTarget),
    )} / ${giftPathTarget}`;
  }
  document.querySelectorAll("[data-gift-points]").forEach((reward) => {
    reward.classList.toggle(
      "unlocked",
      seasonPoints >= Number(reward.dataset.giftPoints || 0),
    );
  });
  const rouletteData = data.roulette || {};
  const minesData = data.mines || {};
  const homeRouletteAttempts = $("#home-roulette-attempts");
  const homeMinesAttempts = $("#home-mines-attempts");
  if (homeRouletteAttempts) {
    homeRouletteAttempts.textContent = `${Number(
      rouletteData.freeSpinsRemaining || 0,
    )}/${Number(rouletteData.freeSpinsPerDay || 0)} спинов`;
  }
  if (homeMinesAttempts) {
    homeMinesAttempts.textContent = `${Number(
      minesData.freeGamesRemaining || 0,
    )} игр`;
  }
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
  renderMining(data);
  renderArena(data);

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

async function refreshArenaState({ silent = true } = {}) {
  if (
    appState.activeView !== "arena" ||
    !appState.data ||
    arenaRuntime.pollInFlight
  ) {
    return;
  }
  arenaRuntime.pollInFlight = true;
  try {
    const payload = await request("/webapp/api/arena/state");
    appState.data = { ...appState.data, arena: payload.arena };
    arenaRuntime.notice = "";
    render();
  } catch (error) {
    if (error.code === "arena_setup_required") {
      appState.data = {
        ...appState.data,
        arena: {
          ...(appState.data.arena || {}),
          available: false,
        },
      };
      arenaRuntime.notice = error.message;
      render();
    } else {
      arenaRuntime.notice = "Не удалось обновить раунд. Повторяем подключение…";
      const notice = $("#arena-notice");
      if (notice) notice.textContent = arenaRuntime.notice;
      if (!silent) showToast(error.message, "danger");
    }
  } finally {
    arenaRuntime.pollInFlight = false;
  }
}

function startArenaLiveUpdates() {
  if (arenaRuntime.pollTimer === null) {
    arenaRuntime.pollTimer = window.setInterval(
      () => refreshArenaState(),
      ARENA_POLL_INTERVAL_MS,
    );
  }
  if (arenaRuntime.countdownTimer === null) {
    arenaRuntime.countdownTimer = window.setInterval(updateArenaCountdown, 250);
  }
  void refreshArenaState();
}

function stopArenaLiveUpdates() {
  if (arenaRuntime.pollTimer !== null) {
    window.clearInterval(arenaRuntime.pollTimer);
    arenaRuntime.pollTimer = null;
  }
  if (arenaRuntime.countdownTimer !== null) {
    window.clearInterval(arenaRuntime.countdownTimer);
    arenaRuntime.countdownTimer = null;
  }
}

function setView(viewName) {
  const normalizedView = viewName === "more" ? "profile" : viewName;
  appState.activeView = normalizedView;
  if (normalizedView === "arena") startArenaLiveUpdates();
  else stopArenaLiveUpdates();
  if (normalizedView !== "rocket") closeCrashBetSheet();
  document.querySelectorAll(".view").forEach((view) => {
    view.classList.toggle("hidden", view.id !== `${normalizedView}-view`);
  });
  document.body.classList.remove(
    "screen-home",
    "screen-games",
    "screen-rocket",
    "screen-roulette",
    "screen-mining",
    "screen-season",
    "screen-profile",
    "nested-screen",
  );
  document.body.classList.add(`screen-${normalizedView}`);
  document.body.classList.toggle("nested-screen", !MAIN_VIEWS.has(normalizedView));
  document.body.classList.toggle("arena-active", normalizedView === "arena");
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
    } else if (
      action === "mines_start" &&
      actionResult?.type === "mines_start"
    ) {
      appState.data = {
        ...appState.data,
        lastAction: actionResult,
        wallet: {
          ...appState.data.wallet,
          earnBalance: Number(
            result.wallet?.earnBalance ?? actionResult.balance ?? appState.data.wallet.earnBalance,
          ),
          zenoBalance: Number(
            result.wallet?.zenoBalance ?? appState.data.wallet.zenoBalance,
          ),
        },
        mines: {
          ...appState.data.mines,
          active: actionResult.active,
          freeGamesRemaining: Number(
            actionResult.freeGamesRemaining ?? appState.data.mines.freeGamesRemaining,
          ),
          nextZtCost: Number(
            actionResult.nextZtCost ?? appState.data.mines.nextZtCost,
          ),
        },
      };
    } else if (
      action === "arena_join" &&
      actionResult?.type === "arena_join"
    ) {
      appState.data = {
        ...appState.data,
        lastAction: actionResult,
        wallet: {
          ...appState.data.wallet,
          earnBalance: Number(
            result.wallet?.earnBalance ?? appState.data.wallet.earnBalance,
          ),
          zenoBalance: Number(
            result.wallet?.zenoBalance ?? appState.data.wallet.zenoBalance,
          ),
        },
        arena: result.arena || appState.data.arena,
      };
      arenaRuntime.notice = "";
    } else if (
      action === "mines_reveal" &&
      actionResult?.type === "mines_reveal" &&
      appState.data.mines?.active
    ) {
      const currentMines = appState.data.mines;
      const currentActive = currentMines.active;
      const historyItem = {
        id: Number(actionResult.gameId),
        bet: Number(currentActive.bet),
        cellsOpened: Number(actionResult.cellsOpened),
        multiplier: Number(actionResult.multiplier),
        result: actionResult.mine ? "lost" : "active",
        payout: 0,
        createdAt: new Date().toISOString(),
      };
      appState.data = {
        ...appState.data,
        lastAction: actionResult,
        mines: {
          ...currentMines,
          active: actionResult.mine
            ? null
            : {
                ...currentActive,
                cellsOpened: Number(actionResult.cellsOpened),
                multiplier: Number(actionResult.multiplier),
                openedCells: [
                  ...(currentActive.openedCells || []),
                  Number(actionResult.cell),
                ],
              },
          history: actionResult.mine
            ? [historyItem, ...(currentMines.history || [])].slice(0, 10)
            : currentMines.history,
        },
      };
    } else if (
      action === "mines_cashout" &&
      actionResult?.type === "mines_cashout"
    ) {
      const currentMines = appState.data.mines;
      const currentActive = currentMines?.active;
      const historyItem = {
        id: Number(actionResult.gameId),
        bet: Number(actionResult.bet || currentActive?.bet || 0),
        cellsOpened: Number(actionResult.cellsOpened || currentActive?.cellsOpened || 0),
        multiplier: Number(actionResult.multiplier || currentActive?.multiplier || 1),
        result: "won",
        payout: Number(actionResult.payout || 0),
        createdAt: new Date().toISOString(),
      };
      appState.data = {
        ...appState.data,
        lastAction: actionResult,
        wallet: {
          ...appState.data.wallet,
          earnBalance: Number(
            result.wallet?.earnBalance ?? actionResult.balance ?? appState.data.wallet.earnBalance,
          ),
        },
        mines: {
          ...currentMines,
          active: null,
          history: [historyItem, ...(currentMines.history || [])].slice(0, 10),
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
    } else if (actionResult?.type === "mines_reveal") {
      if (actionResult.mine) {
        showToast("Мина! Ставка сгорела", "danger");
        telegram?.HapticFeedback?.notificationOccurred("error");
      } else {
        showToast(`Безопасно · ${formatMultiplier(actionResult.multiplier)}`);
        telegram?.HapticFeedback?.impactOccurred("medium");
      }
    } else if (actionResult?.type === "mines_cashout") {
      showToast(
        `Забрано ${formatNumber(actionResult.payout)} монет на ${formatMultiplier(actionResult.multiplier)}`,
      );
      telegram?.HapticFeedback?.notificationOccurred("success");
    } else if (actionResult?.type === "arena_join") {
      showToast(`Ставка ${formatNumber(actionResult.bet)} ZenoToken добавлена в раунд`);
      telegram?.HapticFeedback?.notificationOccurred("success");
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
    if (action === "arena_join") {
      arenaRuntime.notice = error.message;
      void refreshArenaState();
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
    if (action === "mines_reveal") {
      minesRuntime.pendingCell = null;
      minesRuntime.pendingGameId = null;
    }
    if (action.startsWith("mines_")) {
      minesRuntime.pendingAction = null;
    }
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

document.querySelectorAll(".nav-item[data-action]").forEach((button) => {
  button.addEventListener("click", () => {
    setView("home");
    runAction(button.dataset.action);
  });
});

document.querySelector('[data-action="case"]').addEventListener("click", () => runAction("case"));
document.querySelector('[data-action="daily"]').addEventListener("click", () => runAction("daily"));
document.querySelector('[data-action="withdraw"]').addEventListener("click", openWithdraw);
$("#arena-bet-input")?.addEventListener("input", () => {
  arenaRuntime.notice = "";
  if (appState.data) renderArena(appState.data);
});
$("#arena-bet-input")?.addEventListener("keydown", (event) => {
  if (event.key === "Enter") $("#arena-join-button")?.click();
});
$("#arena-join-button")?.addEventListener("click", () => {
  const input = $("#arena-bet-input");
  const bet = Number(input?.value);
  if (!Number.isSafeInteger(bet) || bet <= 0) {
    showToast("Введи целую сумму ставки", "danger");
    input?.focus();
    return;
  }
  if (bet > Number(appState.data?.wallet?.zenoBalance || 0)) {
    showToast("Недостаточно ZenoToken для этой ставки", "danger");
    return;
  }
  runAction("arena_join", { bet });
});
$("#arena-bet-chips")?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-arena-bet]");
  if (!button || button.disabled) return;
  {
    const input = $("#arena-bet-input");
    const amount = Number(button.dataset.arenaBet || 0);
    const balance = Number(appState.data?.wallet?.zenoBalance || 0);
    if (!input || !Number.isFinite(amount)) return;
    input.value = String(Math.min(amount, balance));
    arenaRuntime.notice = "";
    if (appState.data) renderArena(appState.data);
  }
});
document.querySelector("[data-arena-all-in]")?.addEventListener("click", () => {
  const input = $("#arena-bet-input");
  const balance = Number(appState.data?.wallet?.zenoBalance || 0);
  if (!input) return;
  const maxBet = Number(appState.data?.arena?.maxBet || 10_000);
  input.value = String(Math.max(0, Math.floor(Math.min(balance, maxBet))));
  arenaRuntime.notice = "";
  if (appState.data) renderArena(appState.data);
});
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
    renderRoulette(appState.data);
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

document.addEventListener("click", (event) => {
  const viewButton = event.target.closest(".nav-item, [data-view]");
  if (viewButton?.dataset.view) {
    setView(viewButton.dataset.view);
    return;
  }

  const betButton = event.target.closest("[data-mines-bet]");
  if (betButton) {
    minesRuntime.selectedBet = Number(betButton.dataset.minesBet);
    renderMining(appState.data);
    return;
  }

  const cellButton = event.target.closest("[data-mines-cell]");
  if (cellButton) {
    const active = appState.data?.mines?.active;
    if (
      !active ||
      busyActions.has("mines_reveal") ||
      minesRuntime.pendingGameId === active.id
    ) return;
    const cell = Number(cellButton.dataset.minesCell);
    minesRuntime.pendingCell = cell;
    minesRuntime.pendingGameId = active.id;
    cellButton.classList.add("pending");
    cellButton.disabled = true;
    cellButton.textContent = "…";
    runAction("mines_reveal", {
      gameId: Number(active.id),
      cell,
    });
    return;
  }

  if (event.target.closest("#mines-start")) {
    if (!appState.data?.mines?.active) {
      minesRuntime.pendingAction = "mines_start";
      const startButton = event.target.closest("#mines-start");
      startButton.disabled = true;
      startButton.textContent = "Запускаем…";
      runAction("mines_start", { bet: minesRuntime.selectedBet });
    }
    return;
  }

  if (event.target.closest("#mines-cashout")) {
    const gameId = appState.data?.mines?.active?.id;
    if (gameId) {
      minesRuntime.pendingAction = "mines_cashout";
      const cashoutButton = event.target.closest("#mines-cashout");
      cashoutButton.disabled = true;
      cashoutButton.textContent = "Забираем…";
      runAction("mines_cashout", { gameId: Number(gameId) });
    }
  }
});

$("#refresh-button").addEventListener("click", loadState);
document.addEventListener("visibilitychange", () => {
  if (appState.activeView === "arena") {
    if (document.visibilityState === "hidden") stopArenaLiveUpdates();
    else startArenaLiveUpdates();
  }
});
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