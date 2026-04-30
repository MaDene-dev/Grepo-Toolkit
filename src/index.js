const Session      = require("./auth/session");
const GrepolisAPI  = require("./api/grepolis");
const VillageAgent = require("./modules/village-agent");
const Mailer       = require("./utils/mailer");
const logger       = require("./utils/logger");
const config       = require("../config.json");

if (process.env.GREPO_EMAIL)    config.account.username = process.env.GREPO_EMAIL;
if (process.env.GREPO_PASSWORD) config.account.password = process.env.GREPO_PASSWORD;
if (process.env.SMTP_TO)        config.email.to         = process.env.SMTP_TO;

const IS_GHA = !!process.env.GITHUB_ACTIONS;
if (IS_GHA) {
  logger.info("[Boot] GitHub Actions modus: auto-stop na 45 minuten.");
  setTimeout(() => {
    logger.info("[Boot] 45 min verstreken, netjes afsluiten.");
    process.exit(0);
  }, 45 * 60 * 1000);
}

const RETRY_DELAY_MS = 5 * 60 * 1000;
let agent = null;

async function boot() {
  logger.info("=== Grepo Toolkit — Village Agent gestart ===");
  logger.info(`World: ${config.account.world}`);

  const mailer  = new Mailer(config);
  const session = new Session(config);

  try {
    await session.login();
  } catch (err) {
    logger.error(`[Boot] Login mislukt: ${err.message}`);

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
          `  5. Update het GREPO_COOKIES secret met de nieuwe inhoud`,
          ``,
          `De bot probeert opnieuw over 5 minuten.`,
        ].join("\n")
      );
    }

    logger.info(`[Boot] Opnieuw proberen over ${RETRY_DELAY_MS / 60000} minuten...`);
    setTimeout(boot, RETRY_DELAY_MS);
    return;
  }

  const api    = new GrepolisAPI(session);

  agent = new VillageAgent(api, config, mailer;
  agent.start();
}

process.on("uncaughtException",  (err) => {
  logger.error(`[Boot] Onverwachte fout: ${err.message}`);
  if (agent) agent.stop();
  setTimeout(boot, RETRY_DELAY_MS);
});
process.on("unhandledRejection", (r) => {
  logger.error(`[Boot] Unhandled rejection: ${r}`);
});

boot();
