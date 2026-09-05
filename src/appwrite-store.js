import { SellerError, ensure, id } from './domain.js';

export function config(env = process.env) {
  const required = name => { const value = env[name]?.trim(); ensure(value, 'CONFIGURATION', 'Seller operations configuration is incomplete.', 503); return value; };
  const c = { endpoint: required('APPWRITE_FUNCTION_API_ENDPOINT').replace(/\/$/, ''),
    projectId: required('APPWRITE_FUNCTION_PROJECT_ID'), databaseId: id(required('APPWRITE_DATABASE_ID')),
    items: id(required('APPWRITE_ITEMS_TABLE_ID')), orders: id(required('SELLER_ORDERS_TABLE_ID')),
    events: id(required('SELLER_EVENTS_TABLE_ID')), preferences: id(required('SELLER_PREFERENCES_TABLE_ID')), subscriptions: id(required('APPWRITE_USER_SUBSCRIPTIONS_TABLE_ID')) };
  ensure(new Set([c.items,c.orders,c.events,c.subscriptions,c.preferences]).size === 5, 'CONFIGURATION', 'Seller table IDs must be distinct.', 503);
  ensure(new URL(c.endpoint).protocol === 'https:' || env.SELLER_ALLOW_LOCAL_HTTP === 'true', 'CONFIGURATION', 'Appwrite requires HTTPS.', 503);
  return c;
}
export function createApi(c, { key, jwt, fetchImpl = fetch }) {
  return async function api(method, path, data) {
    const url = new URL(c.endpoint + path);
    if (method === 'GET' && data) for (const [k,v] of Object.entries(data)) {
      if (Array.isArray(v)) v.forEach(x => url.searchParams.append(k + '[]', x));
      else if (v !== undefined) url.searchParams.set(k, String(v));
    }
    let response;
    try {
      response = await fetchImpl(url, { method, headers: { 'content-type': 'application/json',
        'X-Appwrite-Project': c.projectId, ...(key ? { 'X-Appwrite-Key': key } : {}),
        ...(jwt ? { 'X-Appwrite-JWT': jwt } : {}) },
        ...(method !== 'GET' ? { body: JSON.stringify(data ?? {}) } : {}), signal: AbortSignal.timeout(15000) });
    } catch { throw new SellerError('UNAVAILABLE', 'Connection interrupted. Retry the same operation.', 503); }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      // Never surface SDK diagnostics that may contain row contents or credentials.
      const error = new SellerError(response.status === 409 ? 'CONFLICT' : 'STORAGE_ERROR',
        response.status === 409 ? 'Data changed. Refresh and retry.' : 'Seller storage request failed.', response.status >= 500 ? 503 : response.status);
      error.storageStatus = response.status; throw error;
    }
    return body;
  };
}
export const query = (method, attribute, values) => JSON.stringify({ method, ...(attribute ? { attribute } : {}), values });
export function createStore(c, api) {
  const base = table => '/tablesdb/' + c.databaseId + '/tables/' + table;
  return {
    c, api, base,
    async get(table, rowId, tx) {
      try { return await api('GET', base(table) + '/rows/' + id(rowId), tx ? {transactionId: tx} : undefined); }
      catch (e) { if (e.storageStatus === 404) return null; throw e; }
    },
    async list(table, owner, cursor, extra = []) {
      const queries = [query('equal','ownerId',[owner]),query('orderAsc','$id',[]),query('limit',null,[50]), ...extra];
      if (cursor) queries.push(query('cursorAfter', null, [id(cursor)]));
      return api('GET', base(table) + '/rows', {queries});
    },
    begin: async () => (await api('POST','/tablesdb/transactions',{ttl:60})).$id,
    commit: tx => api('PATCH','/tablesdb/transactions/' + tx,{commit:true}),
    rollback: tx => api('PATCH','/tablesdb/transactions/' + tx,{rollback:true}),
    create: (table,rowId,data,tx) => api('POST',base(table) + '/rows',{rowId,data,permissions:[],transactionId:tx}),
    update: (table,rowId,data,tx) => api('PATCH',base(table) + '/rows/' + id(rowId),{data,transactionId:tx}),
    increment: (table,rowId,column,value,tx) => api('PATCH',base(table) + '/rows/' + id(rowId) + '/' + column + '/increment',{value,transactionId:tx}),
    decrement: (table,rowId,column,value,tx) => api('PATCH',base(table) + '/rows/' + id(rowId) + '/' + column + '/decrement',{value,min:0,transactionId:tx}),
  };
}
