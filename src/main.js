import { config, createApi, createStore } from './appwrite-store.js';
import { SellerError, ensure, object } from './domain.js';
import { capabilities, mutate, listOrders, detail, inventory, analytics, preferences, matchEmailSale, recordEmailSale } from './operations.js';

export function createHandler({env=process.env,fetchImpl=fetch}={}) {
  return async ({req,res,error}) => {
    try {
      ensure(req.method === 'POST','METHOD_NOT_ALLOWED','Use POST.',405);
      const c = config(env);
      const headers = Object.fromEntries(Object.entries(req.headers ?? {}).map(([k,v])=>[k.toLowerCase(),v]));
      const jwt = headers['x-appwrite-user-jwt'];
      ensure(typeof jwt === 'string' && jwt.length > 0,'UNAUTHENTICATED','Sign in to manage orders.',401);
      // Resolve account using the JWT; never trust an owner ID or plan in the request.
      let account;
      try { account = await createApi(c,{jwt,fetchImpl})('GET','/account'); }
      catch(e) { if (e.status === 401 || e.status === 403) throw new SellerError('UNAUTHENTICATED','Sign in again.',401); throw e; }
      ensure(account.$id && (!headers['x-appwrite-user-id'] || account.$id === headers['x-appwrite-user-id']),
        'UNAUTHENTICATED','Session identity mismatch.',401);
      const key = env.APPWRITE_API_KEY || headers['x-appwrite-key'];
      ensure(key,'CONFIGURATION','Seller operations server key is missing.',503);
      const store = createStore(c,createApi(c,{key,fetchImpl}));
      let body;
      try {
        const raw = req.bodyJson ?? req.bodyText ?? {};
        ensure(typeof raw !== 'string' || raw.length <= 400000,'INVALID_INPUT','Request too large.',413);
        body = object(typeof raw === 'string' ? JSON.parse(raw) : raw);
        ensure(JSON.stringify(body).length <= 400000,'INVALID_INPUT','Request too large.',413);
      } catch(e) { if(e instanceof SellerError) throw e; throw new SellerError('INVALID_INPUT','Invalid JSON.'); }
      const path = (req.path || '/').split('?')[0];
      let result;
      switch(path) {
        case '/capabilities': result = await capabilities(store,account.$id); break;
        case '/inventory/list': result = await inventory(store,account.$id,body); break;
        case '/orders/list': result = await listOrders(store,account.$id,body); break;
        case '/orders/detail': result = await detail(store,account.$id,body); break;
        case '/orders/create': result = await mutate(store,account.$id,'create',body); break;
        case '/orders/fulfillment': result = await mutate(store,account.$id,'fulfillment',body); break;
        case '/orders/ship': result = await mutate(store,account.$id,'ship',body); break;
        case '/orders/reconcile': result = await mutate(store,account.$id,'reconcile',body); break;
        case '/email-sale/match': result = await matchEmailSale(store,account.$id,body); break;
        case '/email-sale/record':
          ensure((await capabilities(store,account.$id)).automation,'SERIOUS_REQUIRED','Email sale automation requires an active Serious subscription.',403);
          result = await recordEmailSale(store,account.$id,body);
          break;
        case '/analytics': result = await analytics(store,account.$id,body); break;
        case '/preferences/get': result = await preferences(store,account.$id,'get',body); break;
        case '/preferences/save': result = await preferences(store,account.$id,'save',body); break;
        case '/sync/ebay':
          ensure((await capabilities(store,account.$id)).automation,'SERIOUS_REQUIRED','Automation requires an active Serious subscription.',403);
          throw new SellerError('ADAPTER_NOT_CONFIGURED','eBay order sync is not connected yet.',501);
        default: throw new SellerError('NOT_FOUND','Unknown seller operation.',404);
      }
      return res.json(result,200);
    } catch(e) {
      error?.('seller-operations: ' + (e instanceof SellerError ? e.code : 'INTERNAL'));
      return res.json({error:{code:e instanceof SellerError ? e.code : 'INTERNAL',
        message:e instanceof SellerError ? e.message : 'Seller operation failed. Retry with the same operation key.'}},e instanceof SellerError ? e.status : 500);
    }
  };
}
export default createHandler();
