/**
 * VillageAgent — orchestrator
 * Beheert de hoofdloop, sessie en timing.
 * Delegeert alle inhoudelijke logica naar sub-agents.
 */
const logger           = require("../utils/logger");
const FarmAgent        = require("./farm-agent");
const DataCollector    = require("./data-collector");
const ResourceBalancer = require("./resource-balancer");

function nlTime(d = new Date()) {
  return d.toLocaleTimeString("nl-BE", { timeZone: "Europe/Brussels", hour: "2-digit", minute: "2-digit" });
}

class VillageAgent {
  constructor(api, config, mailer, stats, sessionData) {
    this.api         = api;
    this.config      = config;
    this.mailer      = mailer;
    this.stats       = stats;
    this.sessionData = sessionData;
    this.intervals   = config.intervals ?? {};
    this.opties      = config.opties    ?? {};
    this.eilanden    = config.eilanden  ?? {};
    this.autoStopAt  = null;
    this.harvestTask = null;
    this.running     = false;
    this.timer       = null;
    this.roundNum    = 0;
    this._recovering = false;
    this.totals = { wood: 0, stone: 0, silver: 0, farms: 0, failed: 0 };

    const deps = { api, config, stats };
    this.farmAgent        = new FarmAgent(deps);
    this.dataCollector    = new DataCollector(deps);
    this.resourceBalancer = new ResourceBalancer(deps);
  }

  start() {
    this.running = true;
    if (this.harvestTask) {
      logger.info(`[Sessie] Harvest modus: ${this.harvestTask.rounds_done}/${this.harvestTask.rounds_total} rondes | interval ${this.harvestTask.interval_key}`);
      if (this.harvestTask.status === "pending") {
        this.stats.activateQueueTask(this.harvestTask.queue_id);
        this.harvestTask.status = "running";
      }
    }
    this.run();
  }

  stop() { this.running = false; if (this.timer) clearTimeout(this.timer); }

  _getCurrentBlock() {
    if (this.harvestTask) {
      const iv = this.intervals[this.harvestTask.interval_key];
      return { key: this.harvestTask.interval_key, interval: iv, van: "harvest", tot: "harvest" };
    }
    const blokken = this.config.dagschema?.blokken ?? [];
    const beTz = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Brussels" }));
    const mins  = beTz.getHours() * 60 + beTz.getMinutes();
    for (const b of blokken) {
      if (!b.actief) continue;
      const [vh, vm] = b.van.split(":").map(Number);
      const [th, tm] = b.tot === "24:00" ? [24, 0] : b.tot.split(":").map(Number);
      if (mins >= vh * 60 + vm && mins < th * 60 + tm)
        return { ...b, interval: this.intervals[b.interval], key: b.interval };
    }
    return null;
  }

  _calcDelay(blok) {
    const timeOption = blok.interval?.time_option_booty ?? blok.interval?.time_option ?? 600;
    const minDelay   = timeOption * 1000 + 30_000;
    const base       = (blok.interval?.interval_minutes ?? 10) * 60 * 1000;
    const u1 = Math.random(), u2 = Math.random();
    const normal = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    const jitter = Math.abs(normal) * (blok.interval?.jitter_minutes ?? 2) * 60 * 1000;
    const kans   = this.opties.extra_pauze_kans ?? 0.10;
    const minMin = this.opties.extra_pauze_min_min ?? 5;
    const maxMin = this.opties.extra_pauze_max_min ?? 10;
    const extra  = Math.random() < kans
      ? (minMin + Math.random() * (maxMin - minMin)) * 60 * 1000 : 0;
    if (extra > 0) logger.info(`[Sessie] Extra pauze (~${Math.round(extra/60000)} min)`);
    return Math.max(minDelay, base + jitter + extra);
  }

  _estimateRondesLeft(blok) {
    if (this.harvestTask)
      return Math.max(0, this.harvestTask.rounds_total - this.harvestTask.rounds_done);
    const beTz = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Brussels" }));
    const mins = beTz.getHours() * 60 + beTz.getMinutes();
    const [th, tm] = blok.tot === "24:00" ? [24, 0] : blok.tot.split(":").map(Number);
    return Math.max(0, Math.floor((th * 60 + tm - mins) / (blok.interval?.interval_minutes ?? 10)));
  }

  async run() {
    if (!this.running) return;

    if (this.roundNum > 0) {
      const paused = await this.stats.isPaused();
      if (paused) {
        const status = await this.stats.readStatus();
        const until  = status?.paused_until === "manual" ? "manuele hervatting" : `tot ${status?.paused_until}`;
        logger.info(`[Sessie] Bot gepauzeerd (${until}) -> afsluiten.`);
        await this._shutdown("paused");
        return;
      }
    }

    if (this.harvestTask && this.harvestTask.rounds_done >= this.harvestTask.rounds_total) {
      logger.info(`[Sessie] Harvest taak voltooid (${this.harvestTask.rounds_total} rondes)`);
      await this.stats.completeQueueTask(this.harvestTask.queue_id, {
        wood_total: this.totals.wood, stone_total: this.totals.stone, silver_total: this.totals.silver,
      });
      this.harvestTask = null;
    }

    const blok = this._getCurrentBlock();
    if (!blok && !this.harvestTask) {
      logger.info("[Sessie] Buiten actief blok -> afsluiten.");
      await this._shutdown("no-block");
      return;
    }

    this.roundNum++;
    const start = Date.now();
    const modeLabel = this.harvestTask
      ? `harvest ${this.harvestTask.rounds_done + 1}/${this.harvestTask.rounds_total}` : blok.key;
    logger.info(`-- Ronde #${this.roundNum} | ${nlTime()} | ${modeLabel} --`);

    await this.stats.updateStatus({
      bot_status: "running", current_session_id: this.sessionData.session_id,
      current_round: this.roundNum,
      current_block: this.harvestTask ? "harvest" : `${blok.van}-${blok.tot}`,
      task_mode: !!this.harvestTask, task_queue_id: this.harvestTask?.queue_id ?? "",
      task_rounds_total: this.harvestTask?.rounds_total ?? 0,
      task_rounds_done:  this.harvestTask?.rounds_done  ?? 0,
      task_interval:     this.harvestTask?.interval_key ?? "",
    });

    let wood = 0, stone = 0, silver = 0, farms = 0, townSnapshots = [];
    const isGasTrigger = ["gas","gas_override"].includes(this.sessionData.trigger_source);

    try {
      this.api.resetTowns();
      const allTowns = await this.api.getTowns();
      await this.stats.saveTowns(allTowns);
      await this.stats.syncEilanden(allTowns, this.eilanden);

      // 1. Data collectie (ronde 1 of GAS trigger)
      await this.dataCollector.run(this.roundNum, isGasTrigger);

      // 2. Resource Balancer (elke ronde)
      await this.resourceBalancer.run();

      // 3. Farm Agent (elke ronde)
      const intervalKey = this.harvestTask ? this.harvestTask.interval_key : blok.key;
      const result = await this.farmAgent.run(allTowns, intervalKey);
      wood          = result.wood   ?? 0;
      stone         = result.stone  ?? 0;
      silver        = result.iron   ?? 0;
      farms         = result.farms  ?? 0;
      townSnapshots = result.townSnapshots ?? [];

    } catch (err) {
      const needsRelogin = err.message === "SESSION_EXPIRED" || err.message === "Geen steden gevonden.";
      if (needsRelogin) {
        this.roundNum--; this.totals.failed++;
        if (this._recovering) { await this._shutdown("error"); return; }
        this._recovering = true;
        logger.warn(`[Sessie] Sessie verlopen -- herlogin...`);
        try {
          await this.api.session.login();
          this.api.resetTowns();
          this._recovering = false;
          logger.info("[Sessie] Sessie hersteld! Snelle ronde over 30s.");
          this.timer = setTimeout(() => this.run(), 30_000);
        } catch (loginErr) {
          logger.error(`[Sessie] Herverbinden mislukt: ${loginErr.message}`);
          await this._shutdown("error");
        }
        return;
      }
      logger.error(`[Sessie] Fout ronde #${this.roundNum}: ${err.message}`);
      this.totals.failed++;
    }

    const dur = ((Date.now() - start) / 1000).toFixed(1);
    this.totals.wood += wood; this.totals.stone += stone;
    this.totals.silver += silver; this.totals.farms += farms;
    this.sessionData.rounds++;

    if (this.harvestTask && (farms > 0 || this.farmAgent._hadStorageSkip)) {
      this.harvestTask.rounds_done++;
      this.harvestTask.wood_total   = (this.harvestTask.wood_total   ?? 0) + wood;
      this.harvestTask.stone_total  = (this.harvestTask.stone_total  ?? 0) + stone;
      this.harvestTask.silver_total = (this.harvestTask.silver_total ?? 0) + silver;
      await this.stats.updateQueueTask(this.harvestTask.queue_id, {
        rounds_done:  this.harvestTask.rounds_done,
        wood_total:   this.harvestTask.wood_total,
        stone_total:  this.harvestTask.stone_total,
        silver_total: this.harvestTask.silver_total,
      });
    }

    if (farms > 0) {
      logger.info(`[Sessie] Ronde #${this.roundNum} | ${farms} drp | 🪵${wood} 🪨${stone} 🪙${silver} | cum: 🪵${this.totals.wood} 🪨${this.totals.stone} 🪙${this.totals.silver}`);
    } else {
      logger.info(`[Sessie] Ronde #${this.roundNum} | niets te halen | ${dur}s`);
    }

    await this.stats.saveRound({
      session_id: this.sessionData.session_id, timestamp: new Date().toISOString(),
      round_num: this.roundNum, interval_key: this.harvestTask?.interval_key ?? blok?.key,
      farms_total: farms, wood, stone, silver, duration_sec: dur,
      world: this.config.account.world,
    });

    if (townSnapshots.length > 0) {
      await this.stats.saveTownSnapshots(townSnapshots.map(s => ({
        ...s, session_id: this.sessionData.session_id, timestamp: new Date().toISOString(),
      })));
    }

    if (this.api._townsNaData?.length > 0)
      await this.stats.saveTowns(this.api._townsNaData);

    this._schedule(blok, farms);
  }

  _schedule(blok, farms = 0) {
    if (!this.running) return;
    if (this.harvestTask && this.harvestTask.rounds_done >= this.harvestTask.rounds_total)
      this.harvestTask = null;

    let delay = this._calcDelay(blok ?? { interval: this.intervals[this.harvestTask?.interval_key ?? "A"] });

    const nextReady = this.farmAgent._nextReadyAt && isFinite(this.farmAgent._nextReadyAt)
      ? this.farmAgent._nextReadyAt : null;
    if (nextReady && farms === 0) {
      const cooldownMs = (nextReady * 1000) - Date.now();
      const snapMin    = this.opties.cooldown_snap_min ?? 4;
      if (cooldownMs > 0 && cooldownMs < snapMin * 60 * 1000) {
        logger.info(`[Sessie] Cooldown snap: ophaling over ${Math.ceil(cooldownMs/1000)}s`);
        delay = Math.max(cooldownMs + 5000, 60_000);
      }
    }
    this.farmAgent._nextReadyAt = null;

    const nextRunAt = new Date(Date.now() + delay);
    if (this.autoStopAt && nextRunAt >= this.autoStopAt) {
      logger.info(`[Sessie] Volgende ophaling (${nlTime(nextRunAt)}) valt na sessie-stop -> afsluiten.`);
      this._shutdown("auto-stop");
      return;
    }

    const rondesLeft = this._estimateRondesLeft(blok ?? {});
    const nlTimeSec = d => d.toLocaleTimeString("nl-BE", {timeZone:"Europe/Brussels",hour:"2-digit",minute:"2-digit",second:"2-digit"});
    logger.info(`[Sessie] Volgende ophaling: ${nlTimeSec(nextRunAt)} | nog ~${rondesLeft} rondes`);
    this.stats.updateStatus({ next_run_at: nextRunAt.toISOString(), task_rounds_done: this.harvestTask?.rounds_done ?? 0 });
    this.timer = setTimeout(() => this.run(), delay);
  }

  async _shutdown(reason) {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.sessionData.exit_reason   = reason;
    this.sessionData.ended_at      = new Date().toISOString();
    this.sessionData.wood          = this.totals.wood;
    this.sessionData.stone         = this.totals.stone;
    this.sessionData.silver        = this.totals.silver;
    this.sessionData.farms         = this.totals.farms;
    this.sessionData.failed_rounds = this.totals.failed;
    this.sessionData.duration_sec  = Math.round(
      (new Date(this.sessionData.ended_at) - new Date(this.sessionData.started_at ?? this.sessionData.triggered_at)) / 1000
    );
    const durMin = Math.round(this.sessionData.duration_sec / 60);
    logger.info(`[Sessie] Sessie afgerond | ${this.roundNum} rondes | 🪵${this.totals.wood} 🪨${this.totals.stone} 🪙${this.totals.silver} | ${durMin} min`);
    await this.stats.saveSession(this.sessionData);
    await this.stats.updateStatus({
      bot_status: "idle", current_session_id: this.sessionData.session_id,
      current_round: this.roundNum, last_session_exit: reason,
      last_login_method: this.sessionData.login_method,
      total_wood_today: this.totals.wood, total_stone_today: this.totals.stone,
      total_silver_today: this.totals.silver, task_mode: false,
    });
    process.exit(0);
  }
}

module.exports = VillageAgent;
