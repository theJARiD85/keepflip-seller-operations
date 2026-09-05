import { SellerError, ensure, only, id, integer, string, date, normalizeCreate, updateOrder, publicOrder, digest, eventId, seriousAccess } from './domain.js';

function owned(row, owner) {
  ensure(row && row.ownerId === owner, 'NOT_FOUND', 'Item or order not found.', 404); return row;
}
export async function access(store, owner) {
  const result = await store.list(store.c.subscriptions, owner);
  return seriousAccess(result.rows, owner);
}
export async function capabilities(store, owner) {
  const serious = await access(store, owner);
  return { manual:true, advancedAnalytics:serious, automation:serious, ebaySyncAvailable:false };
}
async function replay(store, owner, key, hash) {
  const event = await store.get(store.c.events, key);
  if (!event) return null;
  owned(event,owner);
  ensure(event.requestHash === hash, 'IDEMPOTENCY_REUSED', 'This operation key was already used with different details.', 409);
  return { order: JSON.parse(event.resultJson), replayed:true };
}
export async function mutate(store, owner, action, body, clock = () => new Date().toISOString()) {
  only(body, ['idempotencyKey','orderId','expectedVersion','input']);
  const key = string(body.idempotencyKey,'Operation key',120);
  ensure(/^[a-zA-Z0-9._:-]{8,120}$/.test(key), 'INVALID_INPUT','Invalid operation key.');
  const eid = eventId(owner,key), hash = digest({action,body});
  const previous = await replay(store,owner,eid,hash);
  if (previous) return previous;
  const now = clock();
  const tx = await store.begin();
  try {
    let row;
    if (action === 'create') {
      ensure(body.orderId === undefined && body.expectedVersion === undefined,'INVALID_INPUT','New orders cannot specify an existing order.');
      const input = normalizeCreate(body.input);
      ensure(Date.parse(input.soldAt) <= Date.parse(now) + 60000,'INVALID_INPUT','Sale time cannot be in the future.');
      // Ownership before staging; verify again on the staged counter snapshot.
      owned(await store.get(store.c.items,input.itemId,tx),owner);
      const item = owned(await store.decrement(store.c.items,input.itemId,'quantityOnHand',input.quantity,tx),owner);
      integer(item.quantityOnHand,'Stock remaining',100000);
      ensure(!item.currency || item.currency === input.currency,'CURRENCY_MISMATCH','Order currency must match inventory currency.');
      const before = item.quantityOnHand + input.quantity;
      let cost = null;
      // Missing legacy basis is unknown, never silently treated as zero or original lot cost.
      if (item.inventoryCostCentsOnHand != null) {
        integer(item.inventoryCostCentsOnHand,'Inventory cost');
        cost = Number(BigInt(item.inventoryCostCentsOnHand) * BigInt(input.quantity) / BigInt(before));
        if (cost > 0) await store.decrement(store.c.items,input.itemId,'inventoryCostCentsOnHand',cost,tx);
      }
      const order = { ...input, title:string(item.title,'Inventory title',300),
        sku:string(item.sku,'SKU',120,true), storageLocation:string(item.storageLocation,'Storage location',120,true),
        packingLocation:null, source:input.channel,status:'awaiting_packing',packedAt:null,carrier:null,trackingNumber:null,
        shippedAt:null,untracked:false,createdAt:now,updatedAt:now,
        money:{costBasisCents:cost,feesCents:input.feesCents,shippingCostCents:input.shippingExpenseCents,refundsCents:input.refundCents,otherCostsCents:0,payoutCents:input.payoutCents} };
      const oid = 'o' + digest([owner,key]).slice(0,35);
      row = await store.create(store.c.orders,oid,{ownerId:owner,version:1,status:order.status,
        soldAt:order.soldAt,snapshotJson:JSON.stringify(order)},tx);
    } else {
      const oid = id(body.orderId);
      const expected = integer(body.expectedVersion,'Order version',1_000_000,1);
      owned(await store.get(store.c.orders,oid,tx),owner);
      // Staging an increment gives a conflict-protected snapshot, preventing stale JSON overwrites.
      const current = owned(await store.increment(store.c.orders,oid,'version',1,tx),owner);
      ensure(current.version === expected + 1,'VERSION_CONFLICT','Order changed. Refresh before editing.',409);
      const order = updateOrder(JSON.parse(current.snapshotJson),action,body.input,now);
      row = await store.update(store.c.orders,oid,{status:order.status,snapshotJson:JSON.stringify(order)},tx);
    }
    const result = publicOrder(row);
    // Create-only deterministic event is the transaction's durable deduplication guard.
    await store.create(store.c.events,eid,{ownerId:owner,orderId:row.$id,kind:action,requestHash:hash,
      occurredAt:now,resultJson:JSON.stringify(result)},tx);
    await store.commit(tx);
    return {order:result,replayed:false};
  } catch (error) {
    await store.rollback(tx).catch(() => {});
    // Handles duplicate delivery and an accepted commit whose HTTP response was lost.
    const committed = await replay(store,owner,eid,hash);
    if (committed) return committed;
    throw error;
  }
}
export async function listOrders(store,owner,body) {
  only(body,['cursor']);
  if (body.cursor) owned(await store.get(store.c.orders,id(body.cursor)),owner);
  const result = await store.list(store.c.orders,owner,body.cursor);
  return {orders:result.rows.map(row => publicOrder(owned(row,owner))),nextCursor:result.rows.length === 50 ? result.rows.at(-1).$id : null};
}
export async function detail(store,owner,body) {
  only(body,['orderId','cursor']);
  const row = owned(await store.get(store.c.orders,id(body.orderId)),owner);
  if (body.cursor) {
    const cursor = owned(await store.get(store.c.events,id(body.cursor)),owner);
    ensure(cursor.orderId === row.$id,'NOT_FOUND','Event not found.',404);
  }
  const { query } = await import('./appwrite-store.js');
  const result = await store.list(store.c.events,owner,body.cursor,[query('equal','orderId',[row.$id])]);
  return {order:publicOrder(row),events:result.rows.map(e => ({id:e.$id,kind:e.kind,occurredAt:e.occurredAt,version:JSON.parse(e.resultJson).version})),
    nextCursor:result.rows.length === 50 ? result.rows.at(-1).$id : null};
}
export async function inventory(store,owner,body) {
  only(body,['cursor']);
  if (body.cursor) owned(await store.get(store.c.items,id(body.cursor)),owner);
  const result = await store.list(store.c.items,owner,body.cursor);
  return {items:result.rows.map(row => {
    owned(row,owner);
    return {id:row.$id,title:row.title,sku:row.sku ?? null,storageLocation:row.storageLocation ?? null,
      quantityOnHand:Number.isSafeInteger(row.quantityOnHand) ? row.quantityOnHand : null,currency:row.currency ?? null};
  }),nextCursor:result.rows.length === 50 ? result.rows.at(-1).$id : null};
}
export async function analytics(store,owner,body) {
  only(body,[]);
  ensure(await access(store,owner),'SERIOUS_REQUIRED','Advanced analytics requires an active Serious subscription.',403);
  const groups = {};
  let cursor, scanned = 0;
  do {
    const page = await store.list(store.c.orders,owner,cursor);
    for (const row of page.rows) {
      const o = publicOrder(owned(row,owner));
      const g = groups[o.currency] ||= {currency:o.currency,orders:0,shipped:0,reconciled:0,incomplete:0,profitCents:0,
        reconciledNetRevenueCents:0,knownPayoutCents:0,unknownPayouts:0};
      g.orders++; if (o.status === 'shipped') g.shipped++;
      if (o.margin.profitCents === null) g.incomplete++;
      else {g.reconciled++;g.profitCents+=o.margin.profitCents;g.reconciledNetRevenueCents+=o.margin.netRevenueCents;}
      if (o.money.payoutCents === null) g.unknownPayouts++; else g.knownPayoutCents += o.money.payoutCents;
    }
    scanned += page.rows.length;
    cursor = page.rows.length === 50 ? page.rows.at(-1).$id : null;
    ensure(!cursor || scanned < 10000,'REPORT_TOO_LARGE','This report exceeds the P0 limit. No partial totals were returned.',422);
  } while(cursor);
  return {asOf:new Date().toISOString(),scope:'All recorded orders; refunds reflect current reconciliation',groups:Object.values(groups)};
}
const emptyPreferences = () => ({version:1,savedResponses:[],shippingPresets:[],responseReminderHours:24,manualHistory:[]});
function preferencesValue(value) {
  only(value,['version','savedResponses','shippingPresets','responseReminderHours','manualHistory']);
  ensure(value.version === 1,'INVALID_INPUT','Unsupported preferences version.');
  integer(value.responseReminderHours,'Reminder hours',168,1);
  for (const [key,max] of [['savedResponses',30],['shippingPresets',30],['manualHistory',100]]) {
    ensure(Array.isArray(value[key]) && value[key].length <= max,'INVALID_INPUT','Too many preferences.');
    const ids = new Set();
    for (const entry of value[key]) {
      id(entry.id); ensure(!ids.has(entry.id),'INVALID_INPUT','Duplicate preference ID.'); ids.add(entry.id);
      if (key === 'savedResponses') {
        only(entry,['id','title','body']);string(entry.title,'Title',120);
        // Templates may contain newlines; no contact/address fields are accepted.
        ensure(typeof entry.body === 'string' && entry.body.trim().length > 0 && entry.body.length <= 2000,'INVALID_INPUT','Response body is invalid.');
      } else if (key === 'shippingPresets') {
        only(entry,['id','name','shippingExpenseCents','packagingCents','packageType','weightGrams','lengthCm','widthCm','heightCm','handlingDays','shippingServices','returnsAccepted','returnWindowDays','returnShippingPaidBy']);
        string(entry.name,'Preset name',120); string(entry.packageType ?? '', 'Package type',80,true); if (entry.shippingExpenseCents !== null) integer(entry.shippingExpenseCents,'Shipping expense'); if (entry.packagingCents !== null) integer(entry.packagingCents,'Packaging'); if (entry.weightGrams !== null) integer(entry.weightGrams,'Package weight',1000000,1); for (const field of ['lengthCm','widthCm','heightCm']) if (entry[field] !== null) ensure(typeof entry[field] === 'number' && Number.isFinite(entry[field]) && entry[field] > 0 && entry[field] <= 1000,'INVALID_INPUT','Package dimensions are invalid.'); if (entry.handlingDays !== null) integer(entry.handlingDays,'Handling days',30); ensure(Array.isArray(entry.shippingServices) && entry.shippingServices.length <= 10,'INVALID_INPUT','Shipping services are invalid.'); entry.shippingServices.forEach(service => string(service,'Shipping service',80)); ensure(typeof entry.returnsAccepted === 'boolean','INVALID_INPUT','Return preference is invalid.'); if (entry.returnsAccepted) { integer(entry.returnWindowDays,'Return window',365,1); ensure(entry.returnShippingPaidBy === 'seller' || entry.returnShippingPaidBy === 'buyer','INVALID_INPUT','Return shipping payer is invalid.'); } else ensure(entry.returnWindowDays === null && entry.returnShippingPaidBy === null,'INVALID_INPUT','No-return presets must leave return details empty.');
      } else {
        only(entry,['id','itemId','itemTitle','occurredAt','action','notes']);
        id(entry.itemId);string(entry.itemTitle,'Item title',300);date(entry.occurredAt,'History time');
        ensure(['review','reply_draft','offer_review'].includes(entry.action),'INVALID_INPUT','Invalid history action.');
        string(entry.notes,'History notes',1000,true);
      }
    }
  }
  return value;
}
export async function preferences(store,owner,action,body) {
  only(body,action === 'get' ? ['namespace'] : ['namespace','expectedRevision','value']);
  ensure(body.namespace === 'seller-assistance','INVALID_INPUT','Unsupported preferences namespace.');
  const pid = 'p' + digest(owner).slice(0,35);
  if (action === 'get') {
    const row = await store.get(store.c.preferences,pid);
    if (row) owned(row,owner);
    return {preferences:row ? JSON.parse(row.valueJson) : emptyPreferences(),revision:row?.version ?? 0,serious:await access(store,owner)};
  }
  const value = preferencesValue(body.value), expected = integer(body.expectedRevision,'Preferences revision',1000000);
  // Resolve capability before commit so a subscription lookup failure cannot hide a successful save.
  const serious = await access(store,owner);
  const tx = await store.begin();
  try {
    const row = await store.get(store.c.preferences,pid,tx);
    if (row) {
      owned(row,owner);
      const locked = await store.increment(store.c.preferences,pid,'version',1,tx);
      ensure(locked.version === expected + 1,'VERSION_CONFLICT','Preferences changed. Reload before saving.',409);
      await store.update(store.c.preferences,pid,{valueJson:JSON.stringify(value)},tx);
    } else {
      ensure(expected === 0,'VERSION_CONFLICT','Preferences changed. Reload before saving.',409);
      await store.create(store.c.preferences,pid,{ownerId:owner,version:1,valueJson:JSON.stringify(value)},tx);
    }
    await store.commit(tx);
    return {preferences:value,revision:expected+1,serious};
  } catch(e) {await store.rollback(tx).catch(()=>{});throw e;}
}
