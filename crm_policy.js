(function(root) {
  function isSecurePublicEvidenceUrl(value) {
    try {
      const source = new URL(String(value || ''));
      return source.protocol === 'https:' && Boolean(source.hostname) && !source.username && !source.password;
    } catch (error) {
      return false;
    }
  }

  function isContactSuppressed(state) {
    return Boolean(state && state.doNotContact === true);
  }

  function buildPayPalMeLink(base, amount) {
    const euros = Number(amount);
    if (!Number.isInteger(euros) || euros < 1 || euros > 1000000) return '';
    try {
      const url = new URL(String(base || ''));
      if (url.protocol !== 'https:' || !(url.hostname === 'paypal.me' || url.hostname.endsWith('.paypal.me')) || url.pathname === '/') return '';
      if (url.search || url.hash || !/^\/[a-z0-9._-]+\/?$/i.test(url.pathname) || url.username || url.password) return '';
      return url.href.replace(/\/+$/, '') + '/' + euros;
    } catch (error) {
      return '';
    }
  }

  function isPayPalMeLink(value) {
    try {
      const url = new URL(String(value || ''));
      return url.protocol === 'https:' &&
        (url.hostname === 'paypal.me' || url.hostname.endsWith('.paypal.me')) &&
        /^\/[a-z0-9._-]+\/\d{1,7}$/i.test(url.pathname) &&
        !url.username && !url.password;
    } catch (error) {
      return false;
    }
  }

  const api = { isSecurePublicEvidenceUrl, isContactSuppressed, buildPayPalMeLink, isPayPalMeLink };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.KynextCrmPolicy = api;
})(typeof window !== 'undefined' ? window : globalThis);
