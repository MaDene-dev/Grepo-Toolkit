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
    this.autoStopAt  = null;
    this.running     = false;
    this.timer       = null;
    this.roundNum    = 0;
    this._recovering = false;
    this._nextReadyAt = null;

    // Cumulatieve stats
    this.totals = { wood: 0, stone: 0, silver: 0, farms: 0, failed: 0 };
  }

  start() {
    this.running = true;
    logger.info("[Village Agent] Gestart.");
    this.run();
  }

  stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
  }

  // ── Blok bepalen ──────────────────────────────────────────
  _getCurrentBlock() {
    const blokken = this.config.dagschema?.blokken ?? [];
    const now  = new Date();
    const beTz = new Date(now.toLocaleString("en-US", { timeZone: "Europe/Brussels" }));
    const mins = beTz.getHours() * 60 + beTz.getMinutes();

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

  // ── Delay berekening (log-normale jitter) ─────────────────
  _calcDelay(blok) {
    const timeOption = blok.interval.time_option_booty ?? blok.interval.time_option ?? 600;
    const minDelay   = timeOption * 1000 + 30_000;
    const base       = blok.interval.interval_minutes * 60 * 1000;
    const u1 = Math.random(), u2 = Math.random();
    const normal = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    const jitter = Math.abs(normal) * blok.interval.jitter_minutes * 60 * 1000;
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
    const now  = new Date();
    const beTz = new Date(now.toLocaleString("en-US", { timeZone: "Europe/Brussels" }));
    const mins = beTz.getHours() * 60 + beTz.getMinutes();
    const [th, tm] = blok.tot === "24:00" ? [24, 0] : blok.tot.split(":").map(Number);
    const minsLeft = th * 60 + tm - mins;
    return Math.max(0, Math.floor(minsLeft / (blok.interval.interval_minutes ?? 10)));
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

    const blok = this._getCurrentBlock();
    if (!blok) {
      logger.info("[Village Agent] Buiten actief blok → afsluiten.");
      await this._shutdown("no-block");
      return;
    }

    this.roundNum++;
    const start = Date.now();

    logger.info(`── Ronde #${this.roundNum} | ${nlTime()} | ${blok.key} ──`);

    // Update status
    await this.stats.updateStatus({
      bot_status:        "running",
      current_session_id: this.sessionData.session_id,
      current_round:     this.roundNum,
      current_block:     `${blok.van}-${blok.tot}`,
    });

    let wood = 0, stone = 0, silver = 0, farms = 0;
    let townSnapshots = [];

    try {
      this.api.resetTowns();
      const towns = await this.api.getTowns();
      const result = await this._farmAllTowns(towns, blok.key);
      wood    = result.wood   ?? 0;
      stone   = result.stone  ?? 0;
      silver  = result.iron   ?? 0;
      farms   = result.farms  ?? 0;
      townSnapshots = result.townSnapshots ?? [];
    } catch (err) {
      if (err.message === "SESSION_EXPIRED") {
        this.roundNum--;
        this.totals.failed++;
        if (this._recovering) {
          logger.error("[Village Agent] Herstel mislukt → afsluiten.");
          await this._shutdown("error");
          return;
        }
        this._recovering = true;
        logger.warn("[Village Agent] Sessie verlopen — herlogin via Puppeteer...");
        try {
          await this.api.session.login();
          this.api.resetTowns();
          this._recovering = false;
          logger.info("[Village Agent] Sessie hersteld! Snelle ronde over 30 seconden.");
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

    // Cumulatief bijhouden
    this.totals.wood   += wood;
    this.totals.stone  += stone;
    this.totals.silver += silver;
    this.totals.farms  += farms;
    this.sessionData.rounds++;

    if (farms > 0) {
      logger.info(`[Village Agent] ✓ Ronde #${this.roundNum} | ${farms} dorpen | 🪵${wood} 🪨${stone} 🪙${silver} | ${dur}s`);
      logger.info(`[Village Agent] Cumulatief | 🪵${this.totals.wood} 🪨${this.totals.stone} 🪙${this.totals.silver} | ${this.roundNum} rondes`);
    } else {
      logger.info(`[Village Agent] Ronde #${this.roundNum} | niets te halen | ${dur}s`);
    }

    // Sla ronde op
    await this.stats.saveRound({
      session_id:   this.sessionData.session_id,
      timestamp:    new Date().toISOString(),
      round_num:    this.roundNum,
      interval_key: blok.key,
      farms_total:  farms,
      wood, stone, silver,
      duration_sec: dur,
      world:        this.config.account.world,
    });

    // Sla town snapshots op
    if (townSnapshots.length > 0) {
      await this.stats.saveTownSnapshots(townSnapshots.map(s => ({
        ...s,
        session_id: this.sessionData.session_id,
        timestamp:  new Date().toISOString(),
      })));
    }

    this._schedule(blok, farms);
  }

  // ── Scheduling ────────────────────────────────────────────
  _schedule(blok, farms = 0) {
    if (!this.running) return;

    let delay = this._calcDelay(blok);

    // Cooldown snap: als dorpen in cooldown zijn en dat binnen X min afloopt
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

    const rondesLeft = this._estimateRondesLeft(blok);
    logger.info(`[Village Agent] Volgende ophaling: ${nlTime(nextRunAt)} | nog ~${rondesLeft} rondes in dit blok`);

    // Status updaten met volgende run
    this.stats.updateStatus({ next_run_at: nextRunAt.toISOString() });

    this.timer = setTimeout(() => this.run(), delay);
  }

  // ── Netjes afsluiten ──────────────────────────────────────
  async _shutdown(reason) {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);

    this.sessionData.exit_reason  = reason;
    this.sessionData.ended_at     = new Date().toISOString();
    this.sessionData.wood         = this.totals.wood;
    this.sessionData.stone        = this.totals.stone;
    this.sessionData.silver       = this.totals.silver;
    this.sessionData.farms        = this.totals.farms;
    this.sessionData.failed_rounds = this.totals.failed;
    this.sessionData.duration_sec = Math.round(
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
    });

    process.exit(0);
  }

  // ── Farm alle steden ──────────────────────────────────────
  async _farmAllTowns(towns, intervalKey) {
    const townResults  = [];
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

    // Opslagcheck + status log per stad (voor het claimen)
    const townsData = await this.api.getTowns();
    const drempel   = this.opties.opslag_drempel_pct ?? 95;

    for (const tr of townsWithReady) {
      const td = townsData.find(t => t.id === tr.town.id);
      if (!td?.storage_volume) continue;

      const cap  = td.storage_volume;
      const pW   = Math.round((td.wood  ?? 0) / cap * 100);
      const pS   = Math.round((td.stone ?? 0) / cap * 100);
      const pI   = Math.round((td.iron  ?? 0) / cap * 100);
      const wW   = pW >= 90 ? "⚠️" : pW >= 80 ? "!" : "";
      const wS   = pS >= 90 ? "⚠️" : pS >= 80 ? "!" : "";
      const wI   = pI >= 90 ? "⚠️" : pI >= 80 ? "!" : "";

      const gain = this.api.estimateGain(tr.town, tr.ready.length, intervalKey);
      const overflows = [
        (td.wood  ?? 0) + gain > cap * drempel / 100,
        (td.stone ?? 0) + gain > cap * drempel / 100,
        (td.iron  ?? 0) + gain > cap * drempel / 100,
      ].filter(Boolean).length;

      if (overflows >= 2) {
        logger.info(`[Village Agent]   ${tr.town.name} (${tr.ready.length} dorpen): SKIP — opslag vol 🪵${pW}%${wW} 🪨${pS}%${wS} 🪙${pI}%${wI}`);
        tr.skip = true;
      } else {
        logger.info(`[Village Agent]   ${tr.town.name} (${tr.ready.length} dorpen): opslag 🪵${pW}%${wW} 🪨${pS}%${wS} 🪙${pI}%${wI}`);
      }
    }

    const townsToFarm = townsWithReady.filter(r => !r.skip);
    if (townsToFarm.length === 0) return { wood:0, stone:0, iron:0, farms:0, townSnapshots:[] };

    await this._sleep(400 + Math.random() * 800);

    // Één claim call voor alle steden tegelijk (zoals de UI — één knop)
    // Bij multi-town: server bepaalt zelf welke farms klaar zijn per stad
    const allTowns  = townsToFarm.map(r => r.town);
    let totalFarms  = 0;
    for (const { ready } of townsToFarm) totalFarms += ready.length;

    // Pas 2% skip toe op het totaal aantal dorpen
    if (Math.random() < (this.opties.dorp_overslaan_kans ?? 0.02)) {
      logger.info("[Village Agent]   Één dorp overgeslagen (menselijk gedrag)");
      totalFarms = Math.max(0, totalFarms - 1);
    }

    if (totalFarms === 0) {
      logger.info("[Village Agent]   Alle dorpen overgeslagen (menselijk gedrag)");
      return { wood:0, stone:0, iron:0, farms:0, townSnapshots:[] };
    }

    try {
      const result = await this.api.claimLoads(allTowns, [], intervalKey);

      if (!result) {
        logger.warn("[Village Agent]   Claim geen resultaat");
        return { wood:0, stone:0, iron:0, farms:0, townSnapshots:[] };
      }

      // Na-data zit al in de claim response (towns array) — geen extra API call nodig
      const townsNa = this.api._townsNaData ?? [];
      const townSnapshots = [];

      for (const { town, ready } of townsToFarm) {
        const tdVoor = townsData.find(t => t.id === town.id);
        const tdNa   = townsNa.find(t => t.id === town.id);
        if (!tdVoor || !tdNa || !tdNa.storage_volume) continue;

        const cap  = tdNa.storage_volume;
        const pVW  = Math.round((tdVoor.wood  ?? 0) / (tdVoor.storage_volume || cap) * 100);
        const pVS  = Math.round((tdVoor.stone ?? 0) / (tdVoor.storage_volume || cap) * 100);
        const pVI  = Math.round((tdVoor.iron  ?? 0) / (tdVoor.storage_volume || cap) * 100);
        const pNW  = Math.round((tdNa.wood    ?? 0) / cap * 100);
        const pNS  = Math.round((tdNa.stone   ?? 0) / cap * 100);
        const pNI  = Math.round((tdNa.iron    ?? 0) / cap * 100);
        const wNW  = pNW >= 90 ? "⚠️" : pNW >= 80 ? "!" : "";
        const wNS  = pNS >= 90 ? "⚠️" : pNS >= 80 ? "!" : "";
        const wNI  = pNI >= 90 ? "⚠️" : pNI >= 80 ? "!" : "";

        logger.info(`[Village Agent]   ${town.name} (${ready.length} dorpen): voor 🪵${pVW}% 🪨${pVS}% 🪙${pVI}% → na 🪵${pNW}%${wNW} 🪨${pNS}%${wNS} 🪙${pNI}%${wNI}`);

        townSnapshots.push({
          town_id:     town.id,
          town_name:   town.name,
          wood:        tdNa.wood,
          stone:       tdNa.stone,
          silver:      tdNa.iron,
          storage_max: cap,
          pct_wood:    pNW,
          pct_stone:   pNS,
          pct_silver:  pNI,
        });
      }

      return {
        wood:  result.wood, stone: result.stone, iron: result.iron, farms: totalFarms,
        storageWood:  result.storageWood,
        storageStone: result.storageStone,
        storageIron:  result.storageIron,
        storageMax:   result.storageMax,
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
