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
if (process.env.GAS_URL)        config.gas_url          = process.env.GAS_URL;
if (process.env.GAS_SECRET)     config.gas_secret       = process.env.GAS_SECRET;

if (process.env.GREPO_ACCOUNT) {
  try {
    const acc = JSON.parse(process.env.GREPO_ACCOUNT);
    if (acc.world)     config.account.world     = acc.world;
    if (acc.player_id) config.account.player_id = acc.player_id;
    if (acc.towns)     config.account.towns     = acc.towns;
  } catch (e) { logger.warn("[Boot] GREPO_ACCOUNT geen geldige JSON"); }
}

// ── Sessie-ID + trigger source ─────────────────────────────
const now       = new Date();
const sessionId = now.toISOString().replace(/[-:T.Z]/g, "").slice(0, 15);
const triggerSource = process.env.TRIGGER_SOURCE || "cron";

// ── GitHub Actions auto-stop ───────────────────────────────
const SESSIE_MINUTEN = config.opties?.sessie_minuten ?? 45;
const AUTO_STOP_MS   = SESSIE_MINUTEN * 60 * 1000;
const autoStopAt     = new Date(Date.now() + AUTO_STOP_MS);

const IS_GHA = !!process.env.GITHUB_ACTIONS;
if (IS_GHA) {
  setTimeout(() => {
    logger.info("[Boot] Sessie-tijd verstreken — afsluiten.");
    process.exit(0);
  }, AUTO_STOP_MS);
}

// ── Belgische tijd helper ──────────────────────────────────
function nlTime(d = new Date()) {
  return d.toLocaleTimeString("nl-BE", { timeZone: "Europe/Brussels", hour: "2-digit", minute: "2-digit" });
}

// ── Blok bepalen op basis van huidige tijd ─────────────────
function getCurrentBlock() {
  const blokken = config.dagschema?.blokken ?? [];
  const now  = new Date();
  const beTz = new Date(now.toLocaleString("en-US", { timeZone: "Europe/Brussels" }));
  const mins = beTz.getHours() * 60 + beTz.getMinutes();

  for (const b of blokken) {
    if (!b.actief) continue;
    const [vh, vm] = b.van.split(":").map(Number);
    const [th, tm] = b.tot === "24:00" ? [24, 0] : b.tot.split(":").map(Number);
    const van = vh * 60 + vm;
    const tot = th * 60 + tm;
    if (mins >= van && mins < tot) {
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
    session_id:    sessionId,
    world:         config.account.world,
    triggered_at:  now.toISOString(),
    started_at:    null,
    ended_at:      null,
    trigger_source: triggerSource,
    exit_reason:   "unknown",
    interval_key:  null,
    rounds:        0,
    wood:          0,
    stone:         0,
    silver:        0,
    farms:         0,
    failed_rounds: 0,
    login_method:  null,
    duration_sec:  0,
  };

  // ── PRE-CHECK FASE (geen login) ────────────────────────────
  const blok = getCurrentBlock();
  if (!blok) {
    logger.info("[Pre-check] Geen actief blok → sessie beëindigd.");
    sessionData.exit_reason = "no-block";
    await stats.updateStatus({ bot_status: "idle", last_session_exit: "no-block", current_session_id: sessionId });
    await stats.saveSession({ ...sessionData, ended_at: new Date().toISOString() });
    process.exit(0);
  }
  logger.info(`[Pre-check] Blok: ${blok.van}–${blok.tot} → ${blok.key} (${blok.interval?.label}) ✓`);
  sessionData.interval_key = blok.key;

  // Pauze check (fail-open: als GAS niet bereikbaar is, toch doorgaan)
  const paused = await stats.isPaused();
  if (paused) {
    const status = await stats.readStatus();
    const until  = status?.paused_until === "manual" ? "manuele hervatting" : `tot ${status?.paused_until}`;
    logger.info(`[Pre-check] Bot gepauzeerd (${until}) → sessie beëindigd.`);
    sessionData.exit_reason = "paused";
    await stats.saveSession({ ...sessionData, ended_at: new Date().toISOString() });
    process.exit(0);
  }
  logger.info(`[Pre-check] Status: actief, niet gepauzeerd ✓`);

  // Cooldown pre-check voor B/C/D (niet voor A — te kort interval)
  const intervalMins = blok.interval?.interval_minutes ?? 10;
  let loginDelayMs   = 0;

  if (intervalMins >= 40) {
    const lastHarvest = await stats.getLastHarvest();
    if (lastHarvest) {
      const nextPossible = new Date(lastHarvest.getTime() + intervalMins * 60 * 1000);
      const bufferMs     = (config.opties?.precheck_buffer_min ?? 3) * 60 * 1000;

      logger.info(`[Pre-check] Laatste ophaling: ${nlTime(lastHarvest)} → volgende mogelijk: ${nlTime(nextPossible)}`);

      if (nextPossible >= new Date(autoStopAt.getTime() - bufferMs)) {
        logger.info(`[Pre-check] ${nlTime(nextPossible)} valt na sessie-stop (${nlTime(autoStopAt)}) → geen ronde mogelijk → sessie beëindigd.`);
        sessionData.exit_reason = "pre-check-skip";
        await stats.updateStatus({ bot_status: "idle", last_session_exit: "pre-check-skip" });
        await stats.saveSession({ ...sessionData, ended_at: new Date().toISOString() });
        process.exit(0);
      }

      // Login net op tijd — 45s voor cooldown afloopt
      const loginAt  = new Date(nextPossible.getTime() - 45_000);
      loginDelayMs   = Math.max(0, loginAt.getTime() - Date.now());
      if (loginDelayMs > 1000) {
        logger.info(`[Pre-check] Ophaling valt binnen sessie → login om ${nlTime(loginAt)}`);
      }
    } else {
      logger.info(`[Pre-check] Geen vorige ophaling bekend → toch doorgaan ✓`);
    }
  } else {
    // Interval A: check laatste ophaling voor optimale starttijd
    const lastHarvest = await stats.getLastHarvest();
    if (lastHarvest) {
      const nextPossible = new Date(lastHarvest.getTime() + intervalMins * 60 * 1000);
      logger.info(`[Pre-check] Laatste ophaling: ${nlTime(lastHarvest)} → volgende mogelijk: ${nlTime(nextPossible)}`);
      const loginAt  = new Date(nextPossible.getTime() - 45_000);
      loginDelayMs   = Math.max(0, loginAt.getTime() - Date.now());
      if (loginDelayMs > 1000) {
        logger.info(`[Pre-check] Wacht tot ${nlTime(loginAt)} voor login ✓`);
      }
    }
  }

  // Wacht tot het juiste loginmoment
  if (loginDelayMs > 1000) {
    await new Promise(r => setTimeout(r, loginDelayMs));
  }

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
    await mailer.send("⚠️ Login mislukt", `Sessie ${sessionId}\nFout: ${err.message}`);
    process.exit(1);
  }

  // ── AGENT STARTEN ──────────────────────────────────────────
  const api   = new GrepolisAPI(session, config);
  const agent = new VillageAgent(api, config, mailer, stats, sessionData);
  agent.autoStopAt = autoStopAt;
  agent.start();
}

process.on("uncaughtException", async (err) => {
  logger.error(`[Boot] Onverwachte fout: ${err.message}`);
  setTimeout(() => process.exit(1), 2000);
});

boot();
