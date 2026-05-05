const logger = require("../utils/logger");

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
    this._nextReadyAt = null;
    this.totals = { wood: 0, stone: 0, silver: 0, farms: 0, failed: 0 };
  }

  start() {
    this.running = true;
    if (this.harvestTask) {
      logger.info(`[Village Agent] Harvest modus: ${this.harvestTask.rounds_done}/${this.harvestTask.rounds_total} rondes | interval ${this.harvestTask.interval_key}`);
      if (this.harvestTask.status === "pending") {
        this.stats.activateQueueTask(this.harvestTask.queue_id);
        this.harvestTask.status = "running";
      }
    }
    this.run();
  }

  stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
  }

  // ── Blok bepalen ──────────────────────────────────────────
  _getCurrentBlock() {
    if (this.harvestTask) {
      // In harvest modus: gebruik het interval van de taak
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
      if (mins >= vh * 60 + vm && mins < th * 60 + tm) {
        const iv = this.intervals[b.interval];
        return { ...b, interval: iv, key: b.interval };
      }
    }
    return null;
  }

  // ── Eiland filtering ──────────────────────────────────────
  _filterTownsPerEiland(towns) {
    // Groepeer per eiland
    const eilandMap = {};
    for (const town of towns) {
      const key = `${town.island_x}_${town.island_y}`;
      if (!eilandMap[key]) eilandMap[key] = [];
      eilandMap[key].push(town);
    }

    const gefilterd = [];
    for (const [key, eilandTowns] of Object.entries(eilandMap)) {
      const eilandConfig = this.eilanden[key];
      if (eilandConfig?.primaire_stad_id) {
        const primair = eilandTowns.find(t => t.id === eilandConfig.primaire_stad_id);
        if (primair) {
          gefilterd.push(primair);
        } else {
          // Geconfigureerde stad niet gevonden → gebruik eerste als fallback
          gefilterd.push(eilandTowns[0]);
          logger.warn(`[Village Agent] Eiland ${key}: primaire stad ${eilandConfig.primaire_stad_id} niet gevonden, gebruik ${eilandTowns[0].name}`);
        }
      } else {
        // Eiland niet geconfigureerd → gebruik eerste stad als default
        gefilterd.push(eilandTowns[0]);
        // Waarschuw enkel als er meerdere steden zijn (dan is een keuze relevant)
        if (eilandTowns.length > 1) {
          const namen = eilandTowns.map(t => t.name).join(", ");
          logger.info(`[Village Agent] Eiland ${key}: meerdere steden, geen config → default: ${eilandTowns[0].name} | keuze: ${namen}`);
        }
      }
    }
    return gefilterd;
  }

  // ── Delay berekening ──────────────────────────────────────
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
    if (extra > 0) logger.info(`[Village Agent] Extra pauze (~${Math.round(extra/60000)} min)`);
    return Math.max(minDelay, base + jitter + extra);
  }

  _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  _estimateRondesLeft(blok) {
    if (this.harvestTask) {
      return Math.max(0, this.harvestTask.rounds_total - this.harvestTask.rounds_done);
    }
    const beTz = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Brussels" }));
    const mins = beTz.getHours() * 60 + beTz.getMinutes();
    const [th, tm] = blok.tot === "24:00" ? [24, 0] : blok.tot.split(":").map(Number);
    const minsLeft = th * 60 + tm - mins;
    return Math.max(0, Math.floor(minsLeft / (blok.interval?.interval_minutes ?? 10)));
  }

  // ── Hoofdloop ─────────────────────────────────────────────
  async run() {
    if (!this.running) return;

    // Pauze check tussen rondes
    if (this.roundNum > 0) {
      const paused = await this.stats.isPaused();
      if (paused) {
        const status = await this.stats.readStatus();
        const until  = status?.paused_until === "manual" ? "manuele hervatting" : `tot ${status?.paused_until}`;
        logger.info(`[Village Agent] Bot gepauzeerd (${until}) → afsluiten.`);
        await this._shutdown("paused");
        return;
      }
    }

    // Harvest: check of taak klaar is
    if (this.harvestTask && this.harvestTask.rounds_done >= this.harvestTask.rounds_total) {
      logger.info(`[Village Agent] Harvest taak voltooid (${this.harvestTask.rounds_total} rondes) → terug naar dagschema`);
      await this.stats.completeQueueTask(this.harvestTask.queue_id, {
        wood_total:   this.totals.wood,
        stone_total:  this.totals.stone,
        silver_total: this.totals.silver,
      });
      this.harvestTask = null; // Wis harvest modus → terug naar dagschema
    }

    const blok = this._getCurrentBlock();
    if (!blok && !this.harvestTask) {
      logger.info("[Village Agent] Buiten actief blok → afsluiten.");
      await this._shutdown("no-block");
      return;
    }

    this._hadStorageSkip = false;
    this.roundNum++;
    const start = Date.now();
    const modeLabel = this.harvestTask
      ? `harvest ${this.harvestTask.rounds_done + 1}/${this.harvestTask.rounds_total}`
      : blok.key;
    logger.info(`── Ronde #${this.roundNum} | ${nlTime()} | ${modeLabel} ──`);

    await this.stats.updateStatus({
      bot_status:         "running",
      current_session_id: this.sessionData.session_id,
      current_round:      this.roundNum,
      current_block:      this.harvestTask ? "harvest" : `${blok.van}-${blok.tot}`,
      task_mode:          !!this.harvestTask,
      task_queue_id:      this.harvestTask?.queue_id ?? "",
      task_rounds_total:  this.harvestTask?.rounds_total ?? 0,
      task_rounds_done:   this.harvestTask?.rounds_done ?? 0,
      task_interval:      this.harvestTask?.interval_key ?? "",
    });

    let wood = 0, stone = 0, silver = 0, farms = 0;
    let townSnapshots = [];

    try {
      this.api.resetTowns();
      const allTowns    = await this.api.getTowns();
      await this.stats.saveTowns(allTowns);
      // Sync nieuwe eilanden naar config.json
      await this.stats.syncEilanden(allTowns, this.eilanden);
      // Gebouwen ophalen: altijd bij GAS-trigger, anders max 5x per dag op vaste momenten
      const isGasTrigger = ["gas","gas_override"].includes(this.sessionData.trigger_source);
      if (this.roundNum === 1 && (isGasTrigger || this._shouldFetchBuildings())) {
        try {
          const buildings = await this.api.getBuildingOverview();
          await this.stats.saveBuildings(buildings);
        } catch (e) {
          logger.warn(`[Village Agent] Gebouwen ophalen mislukt: ${e.message}`);
        }
      }
      const towns       = this._filterTownsPerEiland(allTowns);
      const intervalKey = this.harvestTask ? this.harvestTask.interval_key : blok.key;
      const result      = await this._farmAllTowns(towns, intervalKey);
      wood          = result.wood   ?? 0;
      stone         = result.stone  ?? 0;
      silver        = result.iron   ?? 0;
      farms         = result.farms  ?? 0;
      townSnapshots = result.townSnapshots ?? [];
    } catch (err) {
      const needsRelogin = err.message === "SESSION_EXPIRED" || err.message === "Geen steden gevonden.";
      if (needsRelogin) {
        this.roundNum--;
        this.totals.failed++;
        if (this._recovering) {
          logger.error("[Village Agent] Herstel mislukt → afsluiten.");
          await this._shutdown("error");
          return;
        }
        this._recovering = true;
        logger.warn(`[Village Agent] Sessie verlopen (${err.message}) — herlogin...`);
        try {
          await this.api.session.login();
          this.api.resetTowns();
          this._recovering = false;
          logger.info("[Village Agent] Sessie hersteld! Snelle ronde over 30s.");
          this.timer = setTimeout(() => this.run(), 30_000);
        } catch (loginErr) {
          logger.error(`[Village Agent] Herverbinden mislukt: ${loginErr.message}`);
          await this._shutdown("error");
        }
        return;
      }
      logger.error(`[Village Agent] Fout ronde #${this.roundNum}: ${err.message}`);
      this.totals.failed++;
    }

    const dur = ((Date.now() - start) / 1000).toFixed(1);
    this.totals.wood   += wood;
    this.totals.stone  += stone;
    this.totals.silver += silver;
    this.totals.farms  += farms;
    this.sessionData.rounds++;

    // Harvest taak bijwerken — telt als er geclaimed werd OF opslag een stad blokkeerde
    if (this.harvestTask && (farms > 0 || this._hadStorageSkip)) {
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
      logger.info(`[Village Agent] ✓ Ronde #${this.roundNum} | ${farms} dorpen | 🪵${wood} 🪨${stone} 🪙${silver} | ${dur}s`);
      logger.info(`[Village Agent] Cumulatief | 🪵${this.totals.wood} 🪨${this.totals.stone} 🪙${this.totals.silver} | ${this.roundNum} rondes`);
    } else {
      logger.info(`[Village Agent] Ronde #${this.roundNum} | niets te halen | ${dur}s`);
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

    this._schedule(blok, farms);
  }

  // ── Scheduling ────────────────────────────────────────────
  _schedule(blok, farms = 0) {
    if (!this.running) return;

    // Harvest: check of taak klaar is na deze ronde (al afgehandeld in run(), hier enkel check)
    if (this.harvestTask && this.harvestTask.rounds_done >= this.harvestTask.rounds_total) {
      this.harvestTask = null; // fallback
    }

    let delay = this._calcDelay(blok ?? { interval: this.intervals[this.harvestTask?.interval_key ?? "A"] });

    // Cooldown snap
    const nextReady = this._nextReadyAt && isFinite(this._nextReadyAt) ? this._nextReadyAt : null;
    if (nextReady && farms === 0) {
      const cooldownMs = (nextReady * 1000) - Date.now();
      const snapMin    = this.opties.cooldown_snap_min ?? 4;
      if (cooldownMs > 0 && cooldownMs < snapMin * 60 * 1000) {
        const secs = Math.ceil(cooldownMs / 1000);
        logger.info(`[Village Agent] Cooldown snap: ophaling over ${secs}s`);
        delay = Math.max(cooldownMs + 5000, 60_000);
      }
    }
    this._nextReadyAt = null;

    const nextRunAt = new Date(Date.now() + delay);

    if (this.autoStopAt && nextRunAt >= this.autoStopAt) {
      logger.info(`[Village Agent] Volgende ophaling (${nlTime(nextRunAt)}) valt na sessie-stop → afsluiten.`);
      this._shutdown("auto-stop");
      return;
    }

    const rondesLeft = this._estimateRondesLeft(blok ?? {});
    const nlTimeSec = d => d.toLocaleTimeString('nl-BE', {timeZone:'Europe/Brussels',hour:'2-digit',minute:'2-digit',second:'2-digit'});
  logger.info(`[Village Agent] Volgende ophaling: ${nlTimeSec(nextRunAt)} | nog ~${rondesLeft} rondes`);

    this.stats.updateStatus({
      next_run_at: nextRunAt.toISOString(),
      task_rounds_done: this.harvestTask?.rounds_done ?? 0,
    });

    this.timer = setTimeout(() => this.run(), delay);
  }

  // ── Afsluiten ─────────────────────────────────────────────
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
    logger.info(`[Sessions] Sessie afgerond | ${this.roundNum} rondes | 🪵${this.totals.wood} 🪨${this.totals.stone} 🪙${this.totals.silver} | ${durMin} min`);

    await this.stats.saveSession(this.sessionData);
    await this.stats.updateStatus({
      bot_status:         "idle",
      current_session_id: this.sessionData.session_id,
      current_round:      this.roundNum,
      last_session_exit:  reason,
      last_login_method:  this.sessionData.login_method,
      total_wood_today:   this.totals.wood,
      total_stone_today:  this.totals.stone,
      total_silver_today: this.totals.silver,
      task_mode:          false,
    });

    process.exit(0);
  }

  // ── Gebouwen fetch check ─────────────────────────────────────
  _shouldFetchBuildings() {
    const buildingHours = [8, 11, 14, 18, 22]; // Belgische uren
    const beTz = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Brussels" }));
    const hour = beTz.getHours();
    const min  = beTz.getMinutes();
    // Alleen in het eerste kwartier na een van de vaste uren
    return buildingHours.includes(hour) && min < 15;
  }

  // ── Farm alle steden ──────────────────────────────────────
  async _farmAllTowns(towns, intervalKey) {
    const townResults    = [];
    let earliestCooldown = null;

    for (let i = 0; i < towns.length; i++) {
      const town = towns[i];
      try {
        const { owned, ready, nextReady } = await this.api.getFarmOverview(town);
        townResults.push({ town, owned, ready });
        if (nextReady && isFinite(nextReady)) {
          earliestCooldown = earliestCooldown ? Math.min(earliestCooldown, nextReady) : nextReady;
        }
        if (i < towns.length - 1) await this._sleep(400 + Math.random() * 400);
      } catch (err) {
        if (err.message === "SESSION_EXPIRED") throw err;
        logger.warn(`[Village Agent]   ${town.name} overview fout: ${err.message}`);
      }
    }

    const townsWithReady = townResults.filter(r => r.ready.length > 0);

    if (townsWithReady.length === 0) {
      if (earliestCooldown && isFinite(earliestCooldown)) this._nextReadyAt = earliestCooldown;
      logger.info("[Village Agent]   Geen dorpen klaar");
      return { wood:0, stone:0, iron:0, farms:0, townSnapshots:[] };
    }

    // Opslagcheck per stad (voor claimen)
    const townsData = await this.api.getTowns();
    const drempel   = this.opties.opslag_drempel_pct ?? 95;

    for (const tr of townsWithReady) {
      const td = townsData.find(t => t.id === tr.town.id);
      if (!td?.storage_volume) continue;
      const cap = td.storage_volume;
      const pW  = Math.round((td.wood  ?? 0) / cap * 100);
      const pS  = Math.round((td.stone ?? 0) / cap * 100);
      const pI  = Math.round((td.iron  ?? 0) / cap * 100);
      const wW  = pW >= 90 ? "⚠️" : pW >= 80 ? "!" : "";
      const wS  = pS >= 90 ? "⚠️" : pS >= 80 ? "!" : "";
      const wI  = pI >= 90 ? "⚠️" : pI >= 80 ? "!" : "";
      const gain = this.api.estimateGain(tr.town, tr.ready.length, intervalKey);
      const overflows = [
        (td.wood  ?? 0) + gain > cap * drempel / 100,
        (td.stone ?? 0) + gain > cap * drempel / 100,
        (td.iron  ?? 0) + gain > cap * drempel / 100,
      ].filter(Boolean).length;

      if (overflows >= 2) {
        logger.info(`[Village Agent]   ${tr.town.name} (${tr.ready.length} dorpen): SKIP — opslag 🪵${pW}%${wW} 🪨${pS}%${wS} 🪙${pI}%${wI} (te vol)`);
        tr.skip = true;
        this._hadStorageSkip = true;
      }
      // Geen "voor" log — enkel "na" log na het claimen
    }

    const townsToFarm = townsWithReady.filter(r => !r.skip);
    if (townsToFarm.length === 0) return { wood:0, stone:0, iron:0, farms:0, townSnapshots:[] };

    await this._sleep(400 + Math.random() * 800);

    // Één claim call (zoals UI)
    const allTowns = townsToFarm.map(r => r.town);
    let totalFarms = 0;
    for (const { ready } of townsToFarm) totalFarms += ready.length;

    if (Math.random() < (this.opties.dorp_overslaan_kans ?? 0.02)) {
      totalFarms = Math.max(0, totalFarms - 1);
    }

    try {
      const result = await this.api.claimLoads(allTowns, [], intervalKey);
      if (!result) {
        logger.warn("[Village Agent]   Claim geen resultaat");
        return { wood:0, stone:0, iron:0, farms:0, townSnapshots:[] };
      }

      // Voor/na vergelijking uit claim response
      const townsNa = this.api._townsNaData ?? [];
      const townSnapshots = [];

      for (const { town, ready } of townsToFarm) {
        const tdVoor = townsData.find(t => t.id === town.id);
        const tdNa   = townsNa.find(t => t.id === town.id);
        if (!tdVoor || !tdNa || !tdNa.storage_volume) continue;

        const cap = tdNa.storage_volume;
        const pVW = Math.round((tdVoor.wood  ?? 0) / (tdVoor.storage_volume || cap) * 100);
        const pVS = Math.round((tdVoor.stone ?? 0) / (tdVoor.storage_volume || cap) * 100);
        const pVI = Math.round((tdVoor.iron  ?? 0) / (tdVoor.storage_volume || cap) * 100);
        const pNW = Math.round((tdNa.wood    ?? 0) / cap * 100);
        const pNS = Math.round((tdNa.stone   ?? 0) / cap * 100);
        const pNI = Math.round((tdNa.iron    ?? 0) / cap * 100);
        const wNW = pNW >= 90 ? "⚠️" : pNW >= 80 ? "!" : "";
        const wNS = pNS >= 90 ? "⚠️" : pNS >= 80 ? "!" : "";
        const wNI = pNI >= 90 ? "⚠️" : pNI >= 80 ? "!" : "";
        const fmt = n => Math.round(n).toLocaleString("nl-BE");
        logger.info(`[Village Agent]   ${town.name} (${ready.length} dorpen): na 🪵${pNW}%${wNW} 🪨${pNS}%${wNS} 🪙${pNI}%${wNI} (${fmt(tdNa.wood)} / ${fmt(tdNa.stone)} / ${fmt(tdNa.iron)} | cap: ${fmt(cap)})`);

        townSnapshots.push({
          town_id: town.id, town_name: town.name,
          wood: tdNa.wood, stone: tdNa.stone, silver: tdNa.iron,
          storage_max: cap, pct_wood: pNW, pct_stone: pNS, pct_silver: pNI,
        });
      }

      return {
        wood: result.wood, stone: result.stone, iron: result.iron, farms: totalFarms,
        storageWood: result.storageWood, storageStone: result.storageStone,
        storageIron: result.storageIron, storageMax: result.storageMax,
        townSnapshots,
      };
    } catch (err) {
      if (err.message === "SESSION_EXPIRED") throw err;
      logger.warn(`[Village Agent]   Claim fout: ${err.message}`);
      return { wood:0, stone:0, iron:0, farms:0, townSnapshots:[] };
    }
  }
}

module.exports = VillageAgent;
