const RESEND_EMAILS_ENDPOINT = 'https://api.resend.com/emails';
const EMAIL_DRIVERS = new Set(['disabled', 'preview', 'resend']);

export class EmailDeliveryError extends Error {
  constructor(message, { status = 0, code = 'delivery_failed', cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'EmailDeliveryError';
    this.status = status;
    this.code = code;
  }
}

function emitLog(logger, level, event, details = {}) {
  try {
    logger?.[level]?.({ event, ...details });
  } catch {
    // Observability must never turn a successful delivery into an application error.
  }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function safeRecipient(value) {
  const email = String(value || '').trim().toLowerCase();
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email) || /[\r\n]/.test(email)) {
    throw new EmailDeliveryError('O destinatário do e-mail é inválido.');
  }
  return email;
}

function safeActionUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (!['http:', 'https:'].includes(url.protocol) || !url.hash) throw new Error();
    return url.toString();
  } catch {
    throw new EmailDeliveryError('O link do e-mail é inválido.');
  }
}

function expiryDescription(expiresAt) {
  const remainingMinutes = Math.max(1, Math.ceil((Date.parse(expiresAt) - Date.now()) / 60_000));
  if (remainingMinutes >= 120 && remainingMinutes % 60 === 0) {
    const hours = remainingMinutes / 60;
    return `${hours} ${hours === 1 ? 'hora' : 'horas'}`;
  }
  return `${remainingMinutes} ${remainingMinutes === 1 ? 'minuto' : 'minutos'}`;
}

function emailDocument({ eyebrow, title, description, actionLabel, actionUrl, expiry }) {
  const escapedUrl = escapeHtml(actionUrl);
  return `<!doctype html>
<html lang="pt-BR">
  <body style="margin:0;background:#1B1B1B;color:#F5E7D7;font-family:Arial,Helvetica,sans-serif;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#1B1B1B;padding:32px 16px;">
      <tr><td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background:#242424;border:1px solid rgba(245,231,215,.18);border-radius:20px;overflow:hidden;">
          <tr><td style="height:6px;background:#BF531A;font-size:0;line-height:0;">&nbsp;</td></tr>
          <tr><td style="padding:36px;">
            <div style="font-size:22px;font-weight:700;color:#F5E7D7;">Beta <span style="color:#BF531A;">/</span> <span style="font-size:15px;font-weight:400;color:#C5CACD;">cursos</span></div>
            <div style="margin-top:32px;color:#BF531A;font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;">${escapeHtml(eyebrow)}</div>
            <h1 style="margin:10px 0 14px;color:#F5E7D7;font-size:28px;line-height:1.2;">${escapeHtml(title)}</h1>
            <p style="margin:0;color:#C5CACD;font-size:16px;line-height:1.65;">${escapeHtml(description)}</p>
            <p style="margin:28px 0;">
              <a href="${escapedUrl}" style="display:inline-block;padding:14px 22px;border-radius:10px;background:#BF531A;color:#F5E7D7;text-decoration:none;font-weight:700;">${escapeHtml(actionLabel)}</a>
            </p>
            <p style="margin:0;color:#C5CACD;font-size:13px;line-height:1.6;">O link expira em ${escapeHtml(expiry)} e só pode ser usado uma vez.</p>
            <p style="margin:24px 0 0;color:#8f9699;font-size:12px;line-height:1.6;word-break:break-all;">Se o botão não funcionar, copie este endereço:<br>${escapedUrl}</p>
            <p style="margin:24px 0 0;color:#8f9699;font-size:12px;line-height:1.6;">Se você não solicitou esta mensagem, ignore-a. Nenhuma alteração será realizada.</p>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
}

function registrationMessage(input) {
  const actionUrl = safeActionUrl(input.confirmUrl);
  const expiry = expiryDescription(input.expiresAt);
  return {
    to: safeRecipient(input.to),
    subject: 'Confirme seu e-mail | Beta Cursos',
    html: emailDocument({
      eyebrow: 'Confirmação de cadastro',
      title: 'Conclua sua conta na Beta Cursos',
      description: 'Abra o link abaixo para confirmar seu endereço e definir seu nome e sua senha.',
      actionLabel: 'Confirmar meu e-mail',
      actionUrl,
      expiry,
    }),
    text: `Conclua sua conta na Beta Cursos\n\nAbra o link para confirmar seu endereço e definir sua senha:\n${actionUrl}\n\nO link expira em ${expiry} e só pode ser usado uma vez. Se você não solicitou esta mensagem, ignore-a.`,
    actionUrl,
    idempotencyKey: String(input.idempotencyKey || '').slice(0, 256),
  };
}

function passwordResetMessage(input) {
  const actionUrl = safeActionUrl(input.resetUrl);
  const expiry = expiryDescription(input.expiresAt);
  const name = String(input.name || '').trim();
  const greeting = name ? `${name}, abra o link abaixo` : 'Abra o link abaixo';
  return {
    to: safeRecipient(input.to),
    subject: 'Recupere sua senha | Beta Cursos',
    html: emailDocument({
      eyebrow: 'Segurança da conta',
      title: 'Defina uma nova senha',
      description: `${greeting} para criar uma nova senha. Ao concluir, as sessões antigas serão encerradas.`,
      actionLabel: 'Criar nova senha',
      actionUrl,
      expiry,
    }),
    text: `Recuperação de senha da Beta Cursos\n\n${greeting} para criar uma nova senha:\n${actionUrl}\n\nAo concluir, as sessões antigas serão encerradas. O link expira em ${expiry} e só pode ser usado uma vez. Se você não solicitou esta mensagem, ignore-a.`,
    actionUrl,
    idempotencyKey: String(input.idempotencyKey || '').slice(0, 256),
  };
}

export function createEmailSender(config = {}, options = {}) {
  const driver = String(config.driver || 'disabled').trim().toLowerCase();
  if (!EMAIL_DRIVERS.has(driver)) throw new TypeError(`Driver de e-mail inválido: ${driver}`);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const logger = options.logger || console;
  const required = Boolean(config.required);
  const enabled = driver !== 'disabled';
  const configured = driver !== 'resend' || Boolean(
    String(config.from || '').trim()
    && String(config.resendApiKey || '').trim()
    && typeof fetchImpl === 'function',
  );
  const delivery = {
    attempts: 0,
    successes: 0,
    failures: 0,
    consecutiveFailures: 0,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastFailureCode: null,
    lastProviderStatus: null,
  };

  function status() {
    const configurationOk = configured && (!required || enabled);
    const deliveryOk = !required || delivery.consecutiveFailures === 0;
    const ok = configurationOk && deliveryOk;
    return {
      ok,
      driver,
      enabled,
      required,
      configured,
      status: !configurationOk
        ? 'misconfigured'
        : !enabled
          ? 'disabled'
          : delivery.consecutiveFailures > 0
            ? 'degraded'
            : 'ready',
      providerProbe: 'not_performed',
      delivery: { ...delivery },
    };
  }

  async function deliver(message, type) {
    if (driver === 'disabled') {
      throw new EmailDeliveryError('O envio de e-mail está desativado.', {
        code: 'email_disabled',
      });
    }
    if (driver === 'preview') {
      return { id: `preview-${type}`, previewUrl: message.actionUrl };
    }
    if (!configured) {
      throw new EmailDeliveryError('O provedor de e-mail não está configurado.', {
        code: 'email_not_configured',
      });
    }
    if (typeof fetchImpl !== 'function') {
      throw new EmailDeliveryError('O cliente HTTP do provedor de e-mail não está disponível.', {
        code: 'email_not_configured',
      });
    }
    let response;
    try {
      response = await fetchImpl(RESEND_EMAILS_ENDPOINT, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${config.resendApiKey}`,
          'Content-Type': 'application/json',
          ...(message.idempotencyKey ? { 'Idempotency-Key': message.idempotencyKey } : {}),
        },
        body: JSON.stringify({
          from: config.from,
          to: [message.to],
          subject: message.subject,
          html: message.html,
          text: message.text,
          ...(config.replyTo ? { reply_to: config.replyTo } : {}),
        }),
        signal: AbortSignal.timeout(Number(config.timeoutMs) || 10_000),
      });
    } catch (error) {
      throw new EmailDeliveryError('Não foi possível conectar ao provedor de e-mail.', {
        code: 'email_provider_unreachable',
        cause: error,
      });
    }
    if (!response.ok) {
      throw new EmailDeliveryError(`O provedor de e-mail recusou o envio (${response.status}).`, {
        code: 'email_provider_rejected',
        status: response.status,
      });
    }
    const payload = await response.json().catch(() => ({}));
    return { id: String(payload.id || ''), previewUrl: '' };
  }

  async function monitoredSend(input, type, buildMessage) {
    delivery.attempts += 1;
    delivery.lastAttemptAt = new Date().toISOString();
    try {
      const result = await deliver(buildMessage(input), type);
      delivery.successes += 1;
      delivery.consecutiveFailures = 0;
      delivery.lastSuccessAt = new Date().toISOString();
      delivery.lastFailureCode = null;
      delivery.lastProviderStatus = null;
      emitLog(logger, 'info', driver === 'preview' ? 'email_preview_created' : 'email_delivery_succeeded', {
        driver,
        type,
      });
      return result;
    } catch (error) {
      const deliveryError = error instanceof EmailDeliveryError
        ? error
        : new EmailDeliveryError('Não foi possível enviar o e-mail.', {
          code: 'email_delivery_failed',
          cause: error,
        });
      delivery.failures += 1;
      delivery.consecutiveFailures += 1;
      delivery.lastFailureAt = new Date().toISOString();
      delivery.lastFailureCode = deliveryError.code;
      delivery.lastProviderStatus = deliveryError.status || null;
      emitLog(logger, 'error', 'email_delivery_failed', {
        driver,
        type,
        code: deliveryError.code,
        ...(deliveryError.status ? { providerStatus: deliveryError.status } : {}),
      });
      throw deliveryError;
    }
  }

  return Object.freeze({
    driver,
    status,
    sendRegistration(input) {
      return monitoredSend(input, 'complete_registration', registrationMessage);
    },
    sendPasswordReset(input) {
      return monitoredSend(input, 'reset_password', passwordResetMessage);
    },
    async healthcheck() {
      return status();
    },
    async close() {},
  });
}
