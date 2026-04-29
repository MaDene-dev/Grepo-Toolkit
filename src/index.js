const Session     = require("./auth/session");
const GrepolisAPI = require("./api/grepolis");
const Autofarm    = require("./modules/autofarm");
const Mailer      = require("./utils/mailer");
const logger      = require("./utils/logger");
const config      = require("../config.json");

if (process.env.GREPO_EMAIL)    config.account.username = process.env.GREPO_EMAIL;
if (process.env.GREPO_PASSWORD) config.account.password = process.env.GREPO_PASSWORD;
if (process.env.SMTP_TO)        config.email.to         = process.env.SMTP_TO;

const IS_GHA = !!process.env.GITHUB_ACTIONS;
if (IS_GHA) {
  logger.info("[Boot] GitHub Actions modus: auto-stop na 45 minuten.");
  setTimeout(() => { logger.info("[Boot] 45 min verstreken, netjes afsluiten."); process.exit(0); }, 45 * 60 * 1000);
}

const RETRY_DELAY_MS = 5 * 60 * 1000;
let autofarm = null;

async function boot() {
  logger.info("=== Grepolis Bot gestart ===");
  logger.info(`World: ${config.account.world}`);

  // Mailer vroeg aanmaken zodat we ook login-fouten kunnen mailen
  const mailer  = new Mailer(config);
  const session = new Session(config);

  try {
    await session.login();
  } catch (err) {
    logger.error(`Login mislukt: ${err.message}`);

    // Stuur mail bij login-fout — maar max 1x per sessie
    if (!global._loginMailSent) {
      global._loginMailSent = true;
      await mailer.send(
        "⚠️ Login mislukt — actie vereist",
      [
        `⚠️ LOGIN MISLUKT`,
        ``,
        `Tijdstip: ${new Date().toLocaleString("nl-BE")}`,
        `Wereld:   ${config.account.world.toUpperCase()}`,
        `Fout:     ${err.message}`,
        ``,
        `Waarschijnlijke oorzaak: cookies zijn verlopen.`,
        ``,
        `Wat te doen:`,
        `  1. Open Grepolis in Edge`,
        `  2. Log in en ga naar je game`,
        `  3. Klik op Cookie-Editor → Export → JSON`,
        `  4. Ga naar GitHub → Settings → Secrets`,
        `  5. Update GREPO_COOKIES met de nieuwe inhoud`,
        ``,
        `De bot probeert opnieuw over 5 minuten.`,
      ].join("\n")
      );
    }

    logger.info(`Opnieuw proberen over ${RETRY_DELAY_MS / 60000} minuten...`);
    setTimeout(boot, RETRY_DELAY_MS);
    return;
  }

  const api = new GrepolisAPI(session);
  autofarm  = new Autofarm(api, config, mailer);
  autofarm.start();

  if (!IS_GHA) {
    setInterval(async () => {
      logger.info("Sessie vernieuwen...");
      try {
        if (autofarm) autofarm.stop();
        await session.login();
        if (autofarm) autofarm.start();
      } catch (err) {
        logger.error(`Sessie vernieuwen mislukt: ${err.message}`);
        await mailer.send("⚠️ Sessie verlopen", `Fout: ${err.message}\n\nUpdate je cookies op GitHub.`);
        setTimeout(boot, RETRY_DELAY_MS);
      }
    }, (config.opties?.sessie_refresh_uren ?? 6) * 60 * 60 * 1000);
  }
}

process.on("uncaughtException",  (err) => { logger.error(`Fout: ${err.message}`); if (autofarm) autofarm.stop(); setTimeout(boot, RETRY_DELAY_MS); });
process.on("unhandledRejection", (r)   => { logger.error(`Rejection: ${r}`); });

boot();
