const local = host => host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.localhost');

export function serverURL(value) {
  let url;
  try { url = new URL(String(value || '').trim()); }
  catch { throw new Error('Enter a complete server address, including https:// and its port.'); }
  if (url.username || url.password) throw new Error('Enter credentials in the sign-in fields, not the server address.');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local(url.hostname) && globalThis.location?.protocol === 'http:')) {
    throw new Error('Use a trusted HTTPS server address. HTTP is available only for localhost development.');
  }
  url.search = ''; url.hash = '';
  return url.href.replace(/\/+$/, '');
}

export function endpoint(server, path = '', params = {}) {
  const base = new URL(`${server.url.replace(/\/+$/, '')}/`);
  const value = String(path);
  const url = new URL(/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(value) ? value : value.replace(/^\/+/, ''), base);
  if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname) || url.username || url.password) {
    throw new Error('The server returned an address outside its configured location.');
  }
  Object.entries(params).forEach(([key, value]) => { if (value != null) url.searchParams.set(key, String(value)); });
  return url.href;
}

export async function request(server, path, { method = 'GET', body, params, headers = {}, timeout = 20000, empty = false, signal } = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, timeout);
  const auth = { Accept: 'application/json', ...(server.token ? { Authorization: `Bearer ${server.token}` } : {}), ...headers };
  for (const key of Object.keys(auth)) if (auth[key] == null) delete auth[key];
  if (body !== undefined) auth['Content-Type'] = 'application/json';
  try {
    const response = await fetch(endpoint(server, path, params), {
      method, headers: auth, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal, credentials: 'omit', mode: 'cors', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer',
    });
    if (!response.ok) {
      const error = new Error(response.status === 401 || response.status === 403
        ? 'The server denied access. Sign in again or check this account’s permissions.'
        : `The server returned HTTP ${response.status}. Check its address and try again.`);
      error.status = response.status;
      throw error;
    }
    if (empty || response.status === 204) return null;
    const text = await response.text();
    if (!text.trim()) return {};
    try { return JSON.parse(text); }
    catch { throw new Error('This address did not return server API data. Check the server type and address.'); }
  } catch (error) {
    if (signal?.aborted) throw new DOMException('Request canceled', 'AbortError');
    if (controller.signal.aborted) throw new Error('The server took too long to respond. Check that it is online.');
    if (error instanceof TypeError) throw new Error('Could not reach the server. Check HTTPS, your connection, and browser access (CORS).');
    throw error;
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', abort);
  }
}
