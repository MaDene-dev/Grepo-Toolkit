const nodemailer = require("nodemailer");
const logger = require("./logger");

class Mailer {
  constructor(config) {
    this.config = config.email;
    this.enabled = config.email?.enabled && process.env.SMTP_USER && process.env.SMTP_PASS;

    if (!this.enabled) {
      logger.info("[Mail] E-mail uitgeschakeld of SMTP_USER/SMTP_PASS niet ingesteld.");
      return;
    }

    this.transporter = nodemailer.createTransport({
      host:   this.config.smtp_host,
      port:   this.config.smtp_port,
      secure: false,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });
  }

  async send(subject, body) {
    if (!this.enabled) return;
    try {
      await this.transporter.sendMail({
        from:    `"Grepolis Bot 🏛️" <${process.env.SMTP_USER}>`,
        to:      this.config.to,
        subject: subject,
        text:    body,
        html:    `<pre style="font-family:monospace;font-size:14px">${body}</pre>`,
      });
      logger.info(`[Mail] Verzonden: ${subject}`);
    } catch (err) {
      logger.warn(`[Mail] Versturen mislukt: ${err.message}`);
    }
  }
}

module.exports = Mailer;
