/**
 * Thin fetch wrapper. Always sends the session cookie and surfaces the
 * server's error message rather than a bare status code.
 */
async function request(method, path, body, { raw = false } = {}) {
  const options = {
    method,
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
  };

  if (body instanceof FormData) {
    options.body = body;
  } else if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }

  const response = await fetch(`/api${path}`, options);

  if (response.status === 401 && !path.startsWith('/auth')) {
    window.dispatchEvent(new CustomEvent('auth:expired'));
  }

  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const error = new Error(payload?.error ?? `Request failed (${response.status})`);
    error.status = response.status;
    error.details = payload?.details ?? payload?.blockers ?? null;
    throw error;
  }

  return raw ? text : payload;
}

export const api = {
  get: (path) => request('GET', path),
  post: (path, body) => request('POST', path, body),
  put: (path, body) => request('PUT', path, body),
  patch: (path, body) => request('PATCH', path, body),
  del: (path) => request('DELETE', path),

  login: (email, password) => request('POST', '/auth/login', { email, password }),
  logout: () => request('POST', '/auth/logout'),
  me: () => request('GET', '/auth/me'),

  importPreview: (file, options = {}) => {
    const form = new FormData();
    form.append('file', file);
    for (const [key, value] of Object.entries(options)) form.append(key, String(value));
    return request('POST', '/contacts/import/preview', form);
  },
};

export function formatDate(value) {
  if (!value) return '--';
  const date = new Date(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

export function pct(value, total) {
  if (!total) return '0%';
  return `${Math.round((value / total) * 100)}%`;
}
