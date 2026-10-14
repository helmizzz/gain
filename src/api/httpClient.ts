export interface ApiErrorPayload {
  success?: false;
  error?: string;
  code?: string;
  category?: string;
  requestId?: string;
}

export class ApiRequestError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly category?: string;
  readonly requestId?: string;

  constructor(status: number, payload: ApiErrorPayload) {
    super(payload.error || 'Permintaan ke server gagal.');
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = payload.code;
    this.category = payload.category;
    this.requestId = payload.requestId;
  }
}

function notifySecurityElevationRequired(error: ApiRequestError): void {
  if (error.code !== 'SESSION_ELEVATION_REQUIRED' || typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('gain:security-elevation-required', {
    detail: { message: error.message, requestId: error.requestId },
  }));
}

async function parseApiResponse<T>(response: Response): Promise<T & ApiErrorPayload> {
  const payload = await response.json().catch(() => null) as (T & ApiErrorPayload) | null;
  return (payload || {}) as T & ApiErrorPayload;
}

async function maybeRefreshAuthorizationToken(authorizationToken?: string): Promise<string | undefined> {
  return authorizationToken;
}

export async function postJson<T>(url: string, body: unknown, signal?: AbortSignal, authorizationToken?: string, extraHeaders?: Record<string,string>): Promise<T> {
  const baseHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
  if (extraHeaders) Object.assign(baseHeaders, extraHeaders);

  const execute = async (token?: string) => {
    const headers = { ...baseHeaders };
    if (token) headers.Authorization = `Bearer ${token}`;
    return fetch(url, { method: 'POST', headers, body: JSON.stringify(body), cache: 'no-store', credentials: 'same-origin', signal });
  };

  let response = await execute(authorizationToken);
  let payload = await parseApiResponse<T>(response);

  if (response.status === 401 && authorizationToken) {
    const refreshedToken = await maybeRefreshAuthorizationToken(authorizationToken);
    if (refreshedToken && refreshedToken !== authorizationToken) {
      response = await execute(refreshedToken);
      payload = await parseApiResponse<T>(response);
    }
  }

  if (!response.ok || payload?.success === false) {
    const error = new ApiRequestError(response.status, payload || {});
    notifySecurityElevationRequired(error);
    throw error;
  }

  if (!payload) throw new ApiRequestError(response.status, { error: 'Respons server tidak valid.' });
  return payload;
}

export async function getJson<T>(url: string, authorizationToken?: string): Promise<T> {
  const execute = async (token?: string) => {
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    return fetch(url, { method: 'GET', headers, cache: 'no-store', credentials: 'same-origin' });
  };

  let response = await execute(authorizationToken);
  let payload = await parseApiResponse<T>(response);
  if (response.status === 401 && authorizationToken) {
    const refreshedToken = await maybeRefreshAuthorizationToken(authorizationToken);
    if (refreshedToken && refreshedToken !== authorizationToken) {
      response = await execute(refreshedToken);
      payload = await parseApiResponse<T>(response);
    }
  }

  if (!response.ok || payload?.success === false) {
    const error = new ApiRequestError(response.status, payload || {});
    notifySecurityElevationRequired(error);
    throw error;
  }
  if (!payload) throw new ApiRequestError(response.status, { error: 'Respons server tidak valid.' });
  return payload;
}

export async function patchJson<T>(url: string, body: unknown, authorizationToken?: string): Promise<T> {
  const execute = async (token?: string) => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    return fetch(url, { method: 'PATCH', headers, body: JSON.stringify(body), cache: 'no-store', credentials: 'same-origin' });
  };

  let response = await execute(authorizationToken);
  let payload = await parseApiResponse<T>(response);
  if (response.status === 401 && authorizationToken) {
    const refreshedToken = await maybeRefreshAuthorizationToken(authorizationToken);
    if (refreshedToken && refreshedToken !== authorizationToken) {
      response = await execute(refreshedToken);
      payload = await parseApiResponse<T>(response);
    }
  }

  if (!response.ok || payload?.success === false) {
    const error = new ApiRequestError(response.status, payload || {});
    notifySecurityElevationRequired(error);
    throw error;
  }
  if (!payload) throw new ApiRequestError(response.status, { error: 'Respons server tidak valid.' });
  return payload;
}

export async function deleteJson<T>(url: string, authorizationToken?: string): Promise<T> {
  const execute = async (token?: string) => {
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    return fetch(url, { method: 'DELETE', headers, cache: 'no-store', credentials: 'same-origin' });
  };

  let response = await execute(authorizationToken);
  let payload = await parseApiResponse<T>(response);
  if (response.status === 401 && authorizationToken) {
    const refreshedToken = await maybeRefreshAuthorizationToken(authorizationToken);
    if (refreshedToken && refreshedToken !== authorizationToken) {
      response = await execute(refreshedToken);
      payload = await parseApiResponse<T>(response);
    }
  }

  if (!response.ok || payload?.success === false) {
    const error = new ApiRequestError(response.status, payload || {});
    notifySecurityElevationRequired(error);
    throw error;
  }
  if (!payload) throw new ApiRequestError(response.status, { error: 'Respons server tidak valid.' });
  return payload;
}

