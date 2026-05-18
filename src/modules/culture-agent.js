"use strict";
const logger = require("../utils/logger");

// Grondstoffen per vieringstype
const COSTS = {
  party:   { wood: 15000, stone: 18000, iron: 15000 },
  theater: { wood: 10000, stone: 12000, iron: 10000 },
};

// 1 uur voor einde: RB aansturen
const PREP_SECS = 3600;

const TYPE_LABEL = { party: "Stadsfeest", theater: "Theater", triumph: "Zegetocht", games: "Olymp. Spelen" };

class CultureAgent {
  constructor(deps) {
    this.api    = deps.api;
    this.config = deps.config;
    this.stats  = deps.stats;
    // Runtime state
    this.playerKills  = 0;
    this.neededKills  = 300;
    this.culturalLevel = 0;
    this.culturalPoints = 0;
    this.culturalMax  = 0;
    this.citiesCur    = 0;
    this.citiesMax    = 0;
    // Per-town running celebrations: { town_id: { party?: {finished_at}, triumph?: {...}, ... } }
    this.running = {};
  }

  get _dorpen() { return this.config?.cultuur?.dorpen ?? []; }
  get _enabled() { return this.config?.cultuur?.enabled === true && this._dorpen.length > 0; }

  // ── Hoofdloop ─────────────────────────────────────────────────

  async run(allTowns) {
    if (!this._enabled) return { rbTargets: [] };

    logger.info("[Cultuur] Ronde starten...");
    const now = Math.floor(Date.now() / 1000);
    const rbTargets = [];
    let killsFetched = false;
    const statusPerTown = {};

    for (const dorp of this._dorpen) {
      const town = allTowns.find(t => t.id === dorp.town_id);
      if (!town) continue;
      await new Promise(r => setTimeout(r, 1200 + Math.random() * 800));

      try {
        const overview = await this.api.getCultureOverview(dorp.town_id);
        if (!overview) continue;

        // Parse state eenmalig per call
        const parsed = this._parse(overview, dorp.town_id);
        this.running[dorp.town_id] = parsed.running;

        if (!killsFetched && parsed.playerKills != null) {
          this.playerKills    = parsed.playerKills;
          this.neededKills    = parsed.neededKills;
          this.culturalLevel  = parsed.culturalLevel;
          this.culturalPoints = parsed.culturalPoints;
          this.culturalMax    = parsed.culturalMax;
          this.citiesCur      = parsed.citiesCur;
          this.citiesMax      = parsed.citiesMax;
          killsFetched = true;
        }

        const townStatus = { feest: null, theater: null, zegetocht: null };

        // ── Zegetocht ──────────────────────────────────────────
        if (dorp.zegetocht) {
          const result = await this._handleZegetocht(dorp, parsed);
          townStatus.zegetocht = result;
        }

        // ── Stadsfeest ─────────────────────────────────────────
        if (dorp.feest) {
          const result = await this._handleResource("party", dorp, town, parsed, now, rbTargets);
          townStatus.feest = result;
        }

        // ── Theater ────────────────────────────────────────────
        if (dorp.theater) {
          const result = await this._handleResource("theater", dorp, town, parsed, now, rbTargets);
          townStatus.theater = result;
        }

        statusPerTown[dorp.town_id] = townStatus;

      } catch (e) {
        logger.warn(`[Cultuur] Fout ${dorp.naam}: ${e.message}`);
      }
    }

    await this._saveStatus(statusPerTown);
    return { rbTargets };
  }

  // ── Zegetocht-logica ──────────────────────────────────────────

  async _handleZegetocht(dorp, parsed) {
    if (parsed.running.triumph) {
      const mins = Math.round((parsed.running.triumph.finished_at - Date.now() / 1000) / 60);
      return { status: "running", mins_left: Math.max(0, mins) };
    }
    if (!parsed.startable.triumph) {
      return { status: "not_startable" };
    }
    if (this.playerKills < this.neededKills) {
      return { status: "insufficient_kills", kills: this.playerKills, needed: this.neededKills };
    }

    logger.info(`[Cultuur] 🏆 Zegetocht starten in ${dorp.naam} (GP: ${this.playerKills})`);
    const res = await this.api.startCelebration("triumph", dorp.town_id);
    if (res?.success) {
      this.playerKills = res.player_kills ?? (this.playerKills - this.neededKills);
      this.neededKills = res.needed_kills_for_next ?? this.neededKills;
      if (res.finished_at) this.running[dorp.town_id].triumph = { finished_at: res.finished_at };
      logger.info(`[Cultuur] ✓ Zegetocht gestart | ${dorp.naam} | klaar: ${this._fmtTs(res.finished_at)} | GP rest: ${this.playerKills}`);
      return { status: "started", finished_at: res.finished_at };
    }
    return { status: "failed" };
  }

  // ── Resource-viering logica ───────────────────────────────────

  async _handleResource(type, dorp, town, parsed, now, rbTargets) {
    const costs = COSTS[type];
    const running = parsed.running[type];
    const label   = TYPE_LABEL[type];

    if (running) {
      const timeLeft = running.finished_at - now;
      if (timeLeft < PREP_SECS) {
        // < 1u resterend: RB aansturen
        logger.info(`[Cultuur] ⏰ ${dorp.naam} — ${label} eindigt over ${Math.round(timeLeft/60)}min → RB`);
        rbTargets.push({ town_id: dorp.town_id, naam: dorp.naam, resources: costs, reason: type });
        return { status: "ending_soon", mins_left: Math.round(timeLeft / 60) };
      }
      return { status: "running", mins_left: Math.round(timeLeft / 60) };
    }

    if (!parsed.startable[type]) {
      return { status: "not_startable" };
    }

    // Kan gestart worden: check grondstoffen
    const res = town.resources ?? {};
    const hasRes = (res.wood ?? 0) >= costs.wood
                && (res.stone ?? 0) >= costs.stone
                && (res.iron ?? 0) >= costs.iron;

    if (hasRes) {
      logger.info(`[Cultuur] 🎉 ${label} starten in ${dorp.naam}`);
      const result = await this.api.startCelebration(type, dorp.town_id);
      if (result?.success) {
        if (result.finished_at) this.running[dorp.town_id][type] = { finished_at: result.finished_at };
        logger.info(`[Cultuur] ✓ ${label} gestart | ${dorp.naam} | klaar: ${this._fmtTs(result.finished_at)}`);
        return { status: "started", finished_at: result.finished_at };
      }
      return { status: "failed" };
    } else {
      // Onvoldoende grondstoffen: RB sturen
      logger.info(`[Cultuur] ⚠️ ${dorp.naam} — onvoldoende voor ${label} → RB`);
      rbTargets.push({ town_id: dorp.town_id, naam: dorp.naam, resources: costs, reason: type });
      return { status: "insufficient_resources", have: res, need: costs };
    }
  }

  // ── HTML-parser ───────────────────────────────────────────────

  _parse(overview, townId) {
    const html = overview.html ?? "";

    // Running celebrations via CultureOverview.init([...], ...)
    const running = {};
    const initMatch = html.match(/CultureOverview\.init\(\s*(\[.*?\])/s);
    if (initMatch) {
      try {
        const arr = JSON.parse(initMatch[1]);
        for (const cel of arr) {
          if (cel.town_id === townId || arr.every(c => !c.town_id)) {
            running[cel.celebration_type] = { finished_at: cel.finished_at };
          }
        }
      } catch (_) {}
    }

    // Fallback: parse data-timestamp uit timer-divs (per-town)
    for (const type of ["party", "triumph", "theater", "games"]) {
      if (running[type]) continue;
      const re = new RegExp(`id="town_${townId}_timer_${type}"[^>]*data-timestamp="(\\d+)"`, "i");
      const m = html.match(re);
      if (m) running[type] = { finished_at: parseInt(m[1]) };
    }

    // Startable: button zonder disabled class
    const startable = {};
    for (const type of ["party", "triumph", "theater", "games"]) {
      const re = new RegExp(`class="confirm type_${type}\\s*"`, "i");
      startable[type] = re.test(html);
    }

    // Cultuurpunten en gevechtspunten uit HTML
    let playerKills = null, neededKills = 300;
    let culturalLevel = 0, culturalPoints = 0, culturalMax = 0, citiesCur = 0, citiesMax = 0;

    const cpMatch = html.match(/place_culture_count[^>]*>[^<]*<[^>]*\/>[^>]*>([\d]+)\/([\d]+)/);
    if (cpMatch) { culturalPoints = parseInt(cpMatch[1]); culturalMax = parseInt(cpMatch[2]); }

    const levelMatch = html.match(/Cultureel level:\s*([\d]+)/);
    if (levelMatch) culturalLevel = parseInt(levelMatch[1]);

    const citiesMatch = html.match(/Steden:\s*([\d]+)\/([\d]+)/);
    if (citiesMatch) { citiesCur = parseInt(citiesMatch[1]); citiesMax = parseInt(citiesMatch[2]); }

    const killsMatch = html.match(/points_count">([\d]+)\/([\d]+)/);
    if (killsMatch) { playerKills = parseInt(killsMatch[1]); neededKills = parseInt(killsMatch[2]); }

    return { running, startable, playerKills, neededKills, culturalLevel, culturalPoints, culturalMax, citiesCur, citiesMax };
  }

  // ── Status opslaan ────────────────────────────────────────────

  async _saveStatus(statusPerTown) {
    try {
      const celebrations = [];
      for (const [tid, types] of Object.entries(this.running)) {
        for (const [type, data] of Object.entries(types)) {
          const dorp = this._dorpen.find(d => d.town_id === parseInt(tid));
          celebrations.push({
            town_id:     parseInt(tid),
            town_name:   dorp?.naam ?? `stad ${tid}`,
            type,
            finished_at: data.finished_at,
          });
        }
      }
      await this.stats._post("saveCultureStatus", {
        celebrations,
        player_kills:     this.playerKills,
        needed_kills:     this.neededKills,
        cultural_level:   this.culturalLevel,
        cultural_points:  this.culturalPoints,
        cultural_max:     this.culturalMax,
        cities_cur:       this.citiesCur,
        cities_max:       this.citiesMax,
      });
    } catch (e) {
      logger.warn(`[Cultuur] Status opslaan mislukt: ${e.message}`);
    }
  }

  _fmtTs(ts) {
    if (!ts) return "—";
    return new Date(ts * 1000).toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit" });
  }
}

module.exports = { CultureAgent };
