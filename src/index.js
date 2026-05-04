const Session      = require("./auth/session");
const GrepolisAPI  = require("./api/grepolis");
const VillageAgent = require("./modules/village-agent");
const StatsWriter  = require("./utils/stats-writer");
const Mailer       = require("./utils/mailer");
const logger       = require("./utils/logger");
const config       = require("../config.json");

// ── Secrets laden ──────────────────────────────────────────
if (process.env.GREPO_EMAIL)    config.account.username = process.env.GREPO_EMAIL;
if (process.env.GREPO_PASSWORD) config.account.password = process.env.GREPO_PASSWORD;
if (process.env.SMTP_TO)        config.email.to         = process.env.SMTP_TO;

if (process.env.GREPO_ACCOUNT) {
  try {
    const acc = JSON.parse(process.env.GREPO_ACCOUNT);
    if (acc.world)     config.account.world     = acc.world;
    if (acc.player_id) config.account.player_id = acc.player_id;
    if (acc.towns)     config.account.towns     = acc.towns;
  } catch (_) { logger.warn("[Boot] GREPO_ACCOUNT geen geldige JSON"); }
}

// ── Sessie-ID + trigger source ─────────────────────────────
const now           = new Date();
const sessionId     = now.toISOString().replace(/[-:T.Z]/g, "").slice(0, 15);
const triggerSource = process.env.TRIGGER_SOURCE || "cron";

// ── Auto-stop ──────────────────────────────────────────────
const SESSIE_MIN   = config.opties?.sessie_minuten ?? 45;
const AUTO_STOP_MS = SESSIE_MIN * 60 * 1000;
const autoStopAt   = new Date(Date.now() + AUTO_STOP_MS);

const IS_GHA = !!process.env.GITHUB_ACTIONS;
if (IS_GHA) {
  setTimeout(() => {
    logger.info("[Boot] Sessie-tijd verstreken — afsluiten.");
    process.exit(0);
  }, AUTO_STOP_MS);
}

function nlTime(d = new Date()) {
  return d.toLocaleTimeString("nl-BE", { timeZone: "Europe/Brussels", hour: "2-digit", minute: "2-digit" });
}

function getCurrentBlock() {
  const blokken = config.dagschema?.blokken ?? [];
  const beTz = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Brussels" }));
  const mins  = beTz.getHours() * 60 + beTz.getMinutes();
  for (const b of blokken) {
    if (!b.actief) continue;
    const [vh, vm] = b.van.split(":").map(Number);
    const [th, tm] = b.tot === "24:00" ? [24, 0] : b.tot.split(":").map(Number);
    if (mins >= vh * 60 + vm && mins < th * 60 + tm) {
      const iv = config.intervals?.[b.interval];
      return { ...b, interval: iv, key: b.interval };
    }
  }
  return null;
}

async function boot() {
  logger.info(`[Boot] Grepo Toolkit v2 | ${sessionId} | ${triggerSource}`);
  logger.info(`[Boot] Sessie stop om ${nlTime(autoStopAt)}`);

  const stats  = new StatsWriter(config);
  const mailer = new Mailer(config);

  const sessionData = {
    session_id: sessionId, world: config.account.world,
    triggered_at: now.toISOString(), started_at: null, ended_at: null,
    trigger_source: triggerSource, exit_reason: "unknown",
    interval_key: null, rounds: 0, wood: 0, stone: 0, silver: 0,
    farms: 0, failed_rounds: 0, login_method: null, duration_sec: 0,
  };

  // ── PRE-CHECK ──────────────────────────────────────────────
  // Pauze check
  const paused = await stats.isPaused();
  if (paused) {
    const status = await stats.readStatus();
    const until  = status?.paused_until === "manual" ? "manuele hervatting" : `tot ${status?.paused_until}`;
    logger.info(`[Pre-check] Bot gepauzeerd (${until}) → sessie beëindigd.`);
    sessionData.exit_reason = "paused";
    await stats.saveSession({ ...sessionData, ended_at: new Date().toISOString() });
    process.exit(0);
  }

  // Harvest queue check
  const activeTask = await stats.getActiveQueueTask();
  let harvestTask  = null;

  if (activeTask?.status === "pending" || activeTask?.status === "running") {
    harvestTask = activeTask;
    logger.info(`[Pre-check] Harvest taak actief: ${harvestTask.rounds_done}/${harvestTask.rounds_total} rondes | interval ${harvestTask.interval_key}`);
    sessionData.interval_key = harvestTask.interval_key;
  } else {
    // Normaal dagschema
    const blok = getCurrentBlock();
    if (!blok) {
      logger.info("[Pre-check] Geen actief blok → sessie beëindigd.");
      sessionData.exit_reason = "no-block";
      await stats.updateStatus({ bot_status: "idle", last_session_exit: "no-block" });
      await stats.saveSession({ ...sessionData, ended_at: new Date().toISOString() });
      process.exit(0);
    }
    logger.info(`[Pre-check] Blok: ${blok.van}–${blok.tot} → ${blok.key} (${blok.interval?.label}) ✓`);
    sessionData.interval_key = blok.key;

    // Cooldown check voor B/C/D
    const intervalMins = blok.interval?.interval_minutes ?? 10;
    let loginDelayMs = 0;
    const lastHarvest = await stats.getLastHarvest();
    if (lastHarvest) {
      const nextPossible = new Date(lastHarvest.getTime() + intervalMins * 60 * 1000);
      logger.info(`[Pre-check] Laatste ophaling: ${nlTime(lastHarvest)} → volgende mogelijk: ${nlTime(nextPossible)}`);

      if (intervalMins >= 40) {
        const bufferMs = (config.opties?.precheck_buffer_min ?? 3) * 60 * 1000;
        if (nextPossible >= new Date(autoStopAt.getTime() - bufferMs)) {
          logger.info(`[Pre-check] ${nlTime(nextPossible)} valt na sessie-stop → geen ronde mogelijk → sessie beëindigd.`);
          sessionData.exit_reason = "pre-check-skip";
          await stats.updateStatus({ bot_status: "idle", last_session_exit: "pre-check-skip" });
          await stats.saveSession({ ...sessionData, ended_at: new Date().toISOString() });
          process.exit(0);
        }
      }
      const loginAt = new Date(nextPossible.getTime() - 45_000);
      loginDelayMs = Math.max(0, loginAt.getTime() - Date.now());
      if (loginDelayMs > 1000) logger.info(`[Pre-check] Wacht tot ${nlTime(loginAt)} voor login`);
    }

    if (loginDelayMs > 1000) await new Promise(r => setTimeout(r, loginDelayMs));
  }

  logger.info(`[Pre-check] Status: actief, niet gepauzeerd ✓`);

  // ── LOGIN ──────────────────────────────────────────────────
  const session = new Session(config);
  try {
    await session.login();
    sessionData.login_method = session.loginMethod ?? "cookies";
    sessionData.started_at   = new Date().toISOString();
  } catch (err) {
    logger.error(`[Sessie] Login mislukt: ${err.message}`);
    sessionData.exit_reason = "error";
    await stats.saveSession({ ...sessionData, ended_at: new Date().toISOString() });
    process.exit(1);
  }

  // ── AGENT STARTEN ──────────────────────────────────────────
  try {
    const api   = new GrepolisAPI(session, config);
    const agent = new VillageAgent(api, config, mailer, stats, sessionData);
    agent.autoStopAt   = autoStopAt;
    agent.harvestTask  = harvestTask;
    agent.start();
  } catch (err) {
    process.stderr.write(`[Boot] Fout bij starten: ${err.message}\n${err.stack}\n`);
    process.exit(1);
  }
}

process.on("uncaughtException", (err) => {
  process.stderr.write(`[Boot] CRASH: ${err.message}\n${err.stack}\n`);
  logger.error(`[Boot] Onverwachte fout: ${err.message}`);
  process.exit(1);
});

boot();
