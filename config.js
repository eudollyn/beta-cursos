/* ============================================================
   BETA CURSOS — CONFIGURAÇÃO DE HOSPEDAGEM

   No Sites ou em um CloudFront que encaminha /api para o backend, mantenha
   apiBaseUrl vazio. Se o frontend estiver no S3 e a API em outro domínio,
   informe apenas a origem HTTPS da API, sem senha ou segredo.
   ============================================================ */

'use strict';

(function createBetaConfig() {
  // A equipe de hospedagem deve alterar somente estes valores públicos.
  const deployment = {
    apiBaseUrl: '',
    crossOriginCredentials: 'omit',
    allowLocalFallback: false,
  };
  const source = window.BETA_CONFIG && typeof window.BETA_CONFIG === 'object'
    ? { ...deployment, ...window.BETA_CONFIG }
    : deployment;

  function normalizeApiBase(value) {
    const raw = String(value || '').trim().replace(/\/+$/, '');
    if (!raw) return '';
    try {
      const parsed = new URL(raw);
      const localHttp = parsed.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(parsed.hostname);
      if (parsed.protocol !== 'https:' && !localHttp) return '';
      parsed.hash = '';
      parsed.search = '';
      return parsed.href.replace(/\/+$/, '');
    } catch (_) {
      return '';
    }
  }

  const apiBaseUrl = normalizeApiBase(source.apiBaseUrl);
  const isLocalPreview = window.location.protocol === 'file:'
    || ['localhost', '127.0.0.1'].includes(window.location.hostname);
  const allowLocalFallback = source.allowLocalFallback === true || isLocalPreview;

  function apiUrl(value) {
    const raw = String(value || '').trim();
    if (/^https:\/\//i.test(raw)) return raw;
    if (!/^\/api(?:\/|$|\?)/i.test(raw)) {
      throw new TypeError('A rota da API precisa começar com /api/.');
    }
    return apiBaseUrl ? `${apiBaseUrl}${raw}` : raw;
  }

  function mediaUrl(value) {
    const raw = String(value || '').trim();
    if (/^\/api(?:\/|$|\?)/i.test(raw)) return apiUrl(raw);
    return raw;
  }

  function credentialsFor(value) {
    const resolved = apiUrl(value);
    if (!/^https:\/\//i.test(resolved)) return 'same-origin';
    try {
      return new URL(resolved).origin === window.location.origin
        ? 'same-origin'
        : (source.crossOriginCredentials === 'include' ? 'include' : 'omit');
    } catch (_) {
      return 'omit';
    }
  }

  async function authorizationHeaders() {
    if (typeof source.getAccessToken !== 'function') return {};
    const token = String(await source.getAccessToken() || '').trim();
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  window.BetaConfig = Object.freeze({
    apiBaseUrl,
    allowLocalFallback,
    apiUrl,
    mediaUrl,
    credentialsFor,
    authorizationHeaders,
  });
})();
