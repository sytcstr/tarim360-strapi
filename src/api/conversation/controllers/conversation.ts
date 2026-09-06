'use strict';

const crypto = require('crypto');
const {
  isValidOperationId,
  fingerprintPayload,
  resolveOperation,
} = require('../../../utils/operation-idempotency');
const {
  resolveListingContextByAnyId,
  resolveLogisticsLoadOwnerByAnyId,
  resolveProcessedProductOwnerByAnyId,
} = require('../../../utils/identity');

const THREAD_UID = 'api::thread.thread';
const MESSAGE_UID = 'api::message.message';

const pick = (source, keys) => {
  for (const key of keys) {
    const value = source && source[key];
    if (value == null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return '';
};

const asData = (ctx) => {
  const body = ctx.request.body || {};
  return body.data && typeof body.data === 'object' ? body.data : body;
};

const cleanEmail = (value) => String(value || '').trim().toLowerCase();
const cleanId = (value) => String(value || '').trim();

const actorForUser = (user) => ({
  email: cleanEmail(user && user.email),
  profileId: cleanId(
    user &&
      (user.profileId ||
        user.ownerProfileId ||
        ownerIdFromEmail(user.email) ||
        user.id),
  ),
  name: cleanId(user && (user.username || user.email || user.id)),
});

const ownerIdFromEmail = (email) => {
  const value = cleanEmail(email);
  if (!value) return '';
  const safe = value.replace(/[^a-z0-9]/g, '_');
  return safe ? `u_${safe}` : '';
};

const actorKey = (profileId, email, name) => {
  const pid = cleanId(profileId);
  if (pid) return `profile:${pid}`;
  const mail = cleanEmail(email);
  if (mail) return `email:${mail}`;
  return `name:${String(name || '').trim().toLowerCase()}`;
};

const inferContextType = (data) => {
  const explicit = pick(data, ['contextType']);
  if (explicit) return explicit;
  const listingId = pick(data, ['listingId']);
  if (listingId.startsWith('processed_') || listingId.startsWith('pp_')) {
    return 'processed_product';
  }
  if (listingId.startsWith('load_') || listingId.startsWith('log_load_')) {
    return 'logistics_load';
  }
  if (listingId || pick(data, ['productId'])) return 'listing';
  return 'general';
};

const inferContextId = (data) =>
  pick(data, [
    'contextId',
    'listingId',
    'productId',
    'logisticsLoadId',
    'loadId',
    'threadId',
  ]);

/**
 * MESSAGING M1 (MESSAGING_M1_M3_CORE_FIX_REPORT.md): sender identity is
 * NEVER taken from the client. Previously `senderEmail`/`senderProfileId`
 * were picked from the request body FIRST, falling back to the real
 * `ctx.state.user` identity only if the client omitted them -- meaning
 * any authenticated caller could submit `senderEmail`/`senderProfileId`
 * for a DIFFERENT real user and have a message recorded as if that
 * person sent it, as long as the fabricated participant set was
 * internally self-consistent (message-ownership.ts's stock-CRUD policy
 * already got this right: `data.senderEmail = identity.email` is forced
 * unconditionally; this file's own custom route never had that). Sender
 * is now always `current` (derived from the JWT-authenticated user),
 * full stop -- requester/receiver (the two parties of the conversation)
 * remain client-suppliable, same as before, since the backend has no
 * other way to learn who a NEW conversation's other party is.
 */
const normalizeParticipants = (data, user) => {
  const current = actorForUser(user);
  let requesterEmail = cleanEmail(pick(data, ['requesterEmail', 'requestedByEmail']));
  let requesterProfileId = cleanId(pick(data, ['requesterProfileId', 'requestedByProfileId']));
  let requesterName = pick(data, ['requesterName', 'requestedByName']);
  let receiverEmail = cleanEmail(
    pick(data, [
      'receiverEmail',
      'targetEmail',
      'messageReceiverEmail',
      'ownerEmail',
    ]),
  );
  let receiverProfileId = cleanId(
    pick(data, [
      'receiverProfileId',
      'targetProfileId',
      'messageReceiverProfileId',
      'ownerProfileId',
    ]),
  );
  let receiverName = pick(data, ['receiverName', 'targetName', 'ownerName', 'personName']);

  const senderEmail = current.email;
  const senderProfileId = current.profileId;
  const senderName = current.name;

  if (!requesterEmail && !requesterProfileId) {
    requesterEmail = senderEmail;
    requesterProfileId = senderProfileId;
    requesterName = requesterName || senderName;
  }

  const senderLooksReceiver =
    (receiverEmail && senderEmail && receiverEmail === senderEmail) ||
    (receiverProfileId && senderProfileId && receiverProfileId === senderProfileId);
  if (senderLooksReceiver && (!requesterEmail && !requesterProfileId)) {
    requesterEmail = senderEmail;
    requesterProfileId = senderProfileId;
    requesterName = requesterName || senderName;
  }

  return {
    requesterEmail,
    requesterProfileId,
    requesterName,
    receiverEmail,
    receiverProfileId,
    receiverName,
    senderEmail,
    senderProfileId,
    senderName,
  };
};

const isSamePerson = (aProfile, aEmail, bProfile, bEmail) => {
  const ap = cleanId(aProfile);
  const bp = cleanId(bProfile);
  if (ap && bp && ap === bp) return true;
  const ae = cleanEmail(aEmail);
  const be = cleanEmail(bEmail);
  return !!ae && !!be && ae === be;
};

const REJECTION_MESSAGES: Record<string, string> = {
  listing_not_active: 'Bu ilan artik aktif degil, yeni mesaj gonderilemez.',
  seller_unavailable: 'Saticinin hesabina su anda ulasilamiyor.',
};

const senderIsParticipant = (participants) =>
  isSamePerson(
    participants.senderProfileId,
    participants.senderEmail,
    participants.requesterProfileId,
    participants.requesterEmail,
  ) ||
  isSamePerson(
    participants.senderProfileId,
    participants.senderEmail,
    participants.receiverProfileId,
    participants.receiverEmail,
  );

const conversationKeyFor = (data, user) => {
  const p = normalizeParticipants(data, user);
  const a = actorKey(p.requesterProfileId, p.requesterEmail, p.requesterName);
  const b = actorKey(p.receiverProfileId, p.receiverEmail, p.receiverName);
  const sorted = [a, b].sort().join('|');
  const contextType = inferContextType(data);
  const contextId = inferContextId(data);
  return `${sorted}|${contextType}:${contextId}`;
};

const threadIdFor = (data, conversationKey) => {
  const supplied = pick(data, ['threadId', 'conversationId']);
  if (supplied && !supplied.toLowerCase().startsWith('support_')) return supplied;
  return `conv_${crypto.createHash('sha1').update(conversationKey).digest('hex').slice(0, 24)}`;
};

const messageMetadataFor = (data) => {
  const base = data.metadata && typeof data.metadata === 'object' ? { ...data.metadata } : {};
  for (const key of ['messageType', 'offerEvent', 'offerId', 'offerStatus']) {
    const value = pick(data, [key]);
    if (value) base[key] = value;
  }
  return base;
};

const findThread = async (strapi, data, conversationKey, threadId) => {
  const attempts = [
    { conversationKey },
    { threadId },
  ].filter((filters) => Object.values(filters).some(Boolean));
  for (const filters of attempts) {
    const rows = await strapi.entityService.findMany(THREAD_UID, {
      filters,
      limit: 1,
    });
    const row = Array.isArray(rows) ? rows[0] : rows;
    if (row) return row;
  }
  return null;
};

// MESSAGING M1 (participant-hijack prevention: a caller could supply a
// real existing threadId belonging to two OTHER users plus a
// self-consistent, fabricated requester/receiver pair matching their own
// identity, and have upsertThread overwrite the real thread's
// participants) is now folded into verifyAndCorrectReceiver below, which
// performs the same "is current a real stored participant of this
// thread" check and additionally corrects the receiver itself
// (NOTIFICATION_N1_SECURITY_FIX_REPORT.md BUG-NOTIF-002).

/**
 * NOTIFICATION_N1_SECURITY_FIX_REPORT.md BUG-NOTIF-002: this is the REAL
 * live message-send path -- StrapiService.sendMessage() posts here, and
 * the generic api::message.message REST route (message-ownership.ts) is
 * only a same-repo fallback reached if this endpoint 404s, which it
 * never does against this backend. normalizeParticipants() above
 * deliberately still trusts a client-supplied receiver for a brand-new
 * conversation ("the backend has no other way to learn who a NEW
 * conversation's other party is") -- true only when there really is no
 * other way. When a thread already exists, the real receiver is now
 * unconditionally the thread's OWN stored other-participant, never the
 * client's claim -- closing the gap where a genuine participant of
 * thread A-B could redirect a reply (and its resulting notification/
 * push) to an arbitrary third party C simply by claiming
 * receiverEmail=C while still passing the real threadId (isRealParticipantOfThread
 * only checked "is current a participant," it never re-derived the
 * receiver from the thread's own data). When no thread exists yet but
 * the message references a real listing/logistics-load/processed-
 * product, that entity's own real owner is used instead of the client's
 * claim, reusing the same resolvers the domain-event notification action
 * uses. A genuinely context-free brand-new conversation (no thread, no
 * resolvable listing/load/product) still trusts the client-supplied
 * receiver -- a disclosed, narrower version of the same limitation
 * farmer_question notifications have.
 */
const resolveContextOwner = async (strapi, data) => {
  const contextType = inferContextType(data);
  // Deliberately only an EXPLICIT listingId/productId -- never
  // inferContextId()'s generic fallback (which can resolve to a bare
  // threadId/contextId string). Those aren't real listing/load/product
  // references, and resolveListingOwnerByAnyId's numeric-substring
  // fallback (built for real Strapi ids) could otherwise coincidentally
  // match an unrelated real entity whose numeric id happens to appear as
  // a digit substring inside a thread hash -- a false-positive resolution
  // risk discovered while testing this exact fix.
  const listingLikeId = pick(data, ['listingId', 'productId']);
  if (!listingLikeId) return null;
  if (contextType === 'processed_product') {
    return resolveProcessedProductOwnerByAnyId(strapi, listingLikeId);
  }
  if (contextType === 'logistics_load') {
    return resolveLogisticsLoadOwnerByAnyId(strapi, listingLikeId);
  }
  // LISTING_L7_SELLER_CONTACT_PRIVACY_REPORT.md L7.7/L7.10: the richer
  // resolver also carries the listing's own real title/status, used
  // right below (in verifyAndCorrectReceiver) to canonicalize the
  // message-thread's display title and to reject starting a BRAND-NEW
  // conversation about a listing that isn't active. Existing threads
  // are untouched either way -- this only runs on the "no thread found
  // yet" path.
  return resolveListingContextByAnyId(strapi, listingLikeId);
};

const RECEIVER_ALIAS_FIELDS = [
  'receiverEmail',
  'targetEmail',
  'messageReceiverEmail',
  'ownerEmail',
  'receiverProfileId',
  'targetProfileId',
  'messageReceiverProfileId',
  'ownerProfileId',
];

/** Mutates `data` in place so every downstream normalizeParticipants()
 * call (conversationKeyFor/normalizeThreadData/upsertThread each
 * recompute it fresh from `data`) consistently picks up the verified
 * receiver, rather than re-discovering the client's original claim
 * through an alias field name this didn't explicitly clear. */
const applyVerifiedReceiver = (data, owner) => {
  for (const field of RECEIVER_ALIAS_FIELDS) delete data[field];
  data.receiverEmail = owner.email || '';
  data.receiverProfileId = owner.ownerId || '';
};

const REQUESTER_ALIAS_FIELDS = [
  'requesterEmail',
  'requestedByEmail',
  'requesterProfileId',
  'requestedByProfileId',
];

/**
 * LISTING_AZ_REVALIDATION_PART2_21_40.md Madde 21 (P1): normalizeParticipants
 * only ever defaulted requesterEmail/requesterProfileId to the
 * authenticated caller when the client sent NEITHER field -- any
 * non-empty client-supplied value (including a real third party's own
 * email) was trusted outright, since the original reasoning ("requester/
 * receiver remain client-suppliable, the backend has no other way to
 * learn who a NEW conversation's other party is") was only ever true for
 * the RECEIVER, never the requester: the requester of a message is
 * always whoever is actually sending it. Mutates `data` in place (same
 * mechanism as applyVerifiedReceiver) so every downstream
 * normalizeParticipants() call picks up the corrected value.
 */
const applyVerifiedRequester = (data, requester) => {
  for (const field of REQUESTER_ALIAS_FIELDS) delete data[field];
  data.requesterEmail = requester.email || '';
  data.requesterProfileId = requester.profileId || '';
  if (requester.name) data.requesterName = requester.name;
};

/** Returns { existingThread, forbidden, rejected }. On forbidden:true the
 * caller must reject immediately -- current is not a real participant of
 * the real, pre-existing thread being referenced. On rejected (a string
 * reason), the caller must reject a brand-new, listing-context
 * conversation attempt -- see the two LISTING_L7 checks below, which
 * only ever run on the "no existing thread yet" path so a conversation
 * that already exists is never retroactively broken by its listing
 * later going inactive or its owner account later disappearing.
 * Otherwise `data` has already been corrected in place where a verified
 * owner (and, for a real listing context, its canonical title) was
 * found. */
const verifyAndCorrectReceiver = async (strapi, data, user) => {
  const current = actorForUser(user);
  const conversationKey = conversationKeyFor(data, user);
  const threadId = threadIdFor(data, conversationKey);
  const existingThread = await findThread(strapi, data, conversationKey, threadId);

  if (existingThread) {
    const currentIsRequester = isSamePerson(
      current.profileId,
      current.email,
      existingThread.requesterProfileId,
      existingThread.requesterEmail,
    );
    const currentIsReceiver = isSamePerson(
      current.profileId,
      current.email,
      existingThread.receiverProfileId,
      existingThread.receiverEmail,
    );
    if (!currentIsRequester && !currentIsReceiver) {
      return { existingThread, forbidden: true, rejected: null };
    }
    // Pre-existing, unchanged: "receiver" for THIS message is always the
    // OTHER real participant relative to current (never the client's
    // claim), so a real participant can't redirect a reply to an
    // arbitrary third party (NOTIFICATION_N1_SECURITY_FIX_REPORT.md
    // BUG-NOTIF-002).
    const owner = currentIsRequester
      ? { email: existingThread.receiverEmail, ownerId: existingThread.receiverProfileId }
      : { email: existingThread.requesterEmail, ownerId: existingThread.requesterProfileId };
    applyVerifiedReceiver(data, owner);
    // Madde 21: "requester" for THIS message is always the real,
    // authenticated sender -- normalizeParticipants' OWN original intent
    // ("if the client sends neither field, default to sender") already
    // established this; the fix is enforcing it UNCONDITIONALLY instead
    // of only when the client happens to send nothing. This is symmetric
    // with senderEmail (already always forced to `current`) -- a
    // requester spoofing attempt can no longer smuggle a real third
    // party's identity into the thread by claiming it on a reply either.
    applyVerifiedRequester(data, current);
    return { existingThread, forbidden: false, rejected: null };
  }

  // Madde 21: a brand-new conversation's requester is always whoever is
  // actually creating it -- there is no legitimate "requesting on behalf
  // of someone else" scenario, unlike the receiver (the other party),
  // which genuinely has no server-known value yet for a first message.
  applyVerifiedRequester(data, current);

  const owner = await resolveContextOwner(strapi, data);
  if (
    owner &&
    (owner.email || owner.ownerId) &&
    owner.email !== current.email &&
    owner.ownerId !== current.profileId
  ) {
    applyVerifiedReceiver(data, owner);
  }

  // LISTING_L7_SELLER_CONTACT_PRIVACY_REPORT.md L7.7/L7.9/L7.10: a real,
  // RESOLVED listing context gets two extra checks a brand-new
  // conversation about a listing/logistics-load/processed-product-
  // that-isn't-a-listing doesn't need. Deliberately does NOT reject when
  // a listingId-shaped value fails to resolve to any real listing row at
  // all (`owner` stays null) -- confirmed live while writing this fix
  // that this codebase's own conversation tests (and, by the same
  // reasoning, potentially real production callers) legitimately use a
  // `listing-<uuid>`-shaped string purely as a generic context-grouping
  // key, not always a literal reference to a real `listing` row;
  // rejecting that case outright broke every one of those pre-existing
  // tests. A non-resolving listing context therefore falls through to
  // the exact SAME pre-existing behavior as before this phase (trusts
  // whatever receiver the client supplied) -- a deliberate, disclosed
  // "defined fallback matching existing product behavior" rather than a
  // hard block, per the mandate's own explicit alternative for this
  // case. Also deliberately does NOT separately verify the seller's
  // profile-setting row exists for a listing that DOES resolve: account
  // deletion (auth-flow.ts's deleteAccount) already cascades to delete
  // the owner's OWN listings along with their profile-setting/threads/
  // messages, so "the listing still resolves, with an active status" is
  // both necessary and sufficient proof the owning account hasn't been
  // deleted -- a separate profile-setting-existence check would instead
  // incorrectly reject any real, un-deleted seller who simply hasn't
  // created a profile-setting row yet (also confirmed live: registration
  // alone never creates one, and nothing requires it before creating a
  // listing).
  const listingLikeId = pick(data, ['listingId', 'productId']);
  const isListingContext = inferContextType(data) === 'listing' && !!listingLikeId;
  if (isListingContext && owner) {
    if (owner.status && owner.status !== 'active') {
      return { existingThread: null, forbidden: false, rejected: 'listing_not_active' };
    }
    if (owner.title) {
      data.listingTitle = owner.title;
    }
    // LISTING_L8_MESSAGING_LISTING_CONTEXT_REPORT.md L8.2/L8.7: same
    // canonicalization as listingTitle above -- the public listing
    // number and sell/buy mode are resolved from the real listing,
    // never trusted from client input (see identity.ts's
    // resolveListingContextByAnyId doc comment for why price is
    // deliberately NOT canonicalized the same way).
    if (owner.listingNo != null) data.listingNo = owner.listingNo;
    if (owner.mode === 'sell' || owner.mode === 'buy') data.listingMode = owner.mode;
    // Self-referencing listing (current user IS the resolved owner): the
    // outer applyVerifiedReceiver call above deliberately skips this case
    // (there's no real "other side" to correct the receiver to), which
    // otherwise left receiverEmail/receiverProfileId exactly as the
    // client sent them -- empty if the client never supplied one, which
    // is exactly what a self-message attempt against your own listing
    // looks like when no receiver is (legitimately) known client-side.
    // Populate it to the owner's own identity so the existing
    // isSamePerson self-message check downstream (upsert/sendMessage)
    // can actually see and reject it, instead of silently creating a
    // thread with no real receiver at all.
    if (owner.email === current.email || owner.ownerId === current.profileId) {
      applyVerifiedReceiver(data, owner);
    }
  }

  return { existingThread: null, forbidden: false, rejected: null };
};

const normalizeThreadData = (data, user) => {
  const p = normalizeParticipants(data, user);
  const contextType = inferContextType(data);
  const contextId = inferContextId(data);
  const conversationKey = conversationKeyFor(data, user);
  const threadId = threadIdFor(data, conversationKey);
  const nowIso = new Date().toISOString();
  return {
    threadId,
    conversationKey,
    contextType,
    contextId,
    listingId: pick(data, ['listingId', 'productId', 'loadId', 'logisticsLoadId']),
    listingTitle: pick(data, ['listingTitle', 'title']),
    listingQtyText: pick(data, ['listingQtyText', 'qtyText']),
    imageUrl: pick(data, ['imageUrl', 'photoUrl', 'mediaUrl']),
    listingNo: (() => {
      const n = Number(data.listingNo);
      return Number.isFinite(n) && n > 0 ? n : null;
    })(),
    listingMode: data.listingMode === 'sell' || data.listingMode === 'buy' ? data.listingMode : null,
    // Client-trusted, display-only -- same precedent as imageUrl (L7):
    // Flutter has no raw price fields to canonicalize this against (only
    // the already-formatted L5 priceText), so there is nothing more
    // trustworthy to resolve it from server-side.
    listingPriceText: pick(data, ['listingPriceText']),
    personName: pick(data, ['personName', 'counterpartyName']) || p.receiverName || p.requesterName,
    personCity: pick(data, ['personCity', 'city']),
    personAvatarUrl: pick(data, ['personAvatarUrl', 'avatarUrl']),
    requesterEmail: p.requesterEmail,
    requesterProfileId: p.requesterProfileId,
    requesterName: p.requesterName,
    receiverEmail: p.receiverEmail,
    receiverProfileId: p.receiverProfileId,
    receiverName: p.receiverName,
    lastMessage: pick(data, ['lastMessage', 'message', 'text']),
    lastMessagePreview: pick(data, ['lastMessagePreview', 'lastMessage', 'message', 'text']),
    lastMessageAt: pick(data, ['lastMessageAt', 'sentAt', 'updatedAtClient']) || nowIso,
    // MESSAGING M1: same reasoning as normalizeParticipants above -- a
    // client-supplied lastSenderEmail/lastSenderProfileId used to be
    // trusted here directly (bypassing the normalizeParticipants fix
    // entirely, since this read `data` again instead of using `p`).
    // Always the real, authenticated sender now.
    lastSenderEmail: p.senderEmail,
    lastSenderProfileId: p.senderProfileId,
    lastTimeText: pick(data, ['lastTimeText']),
    unreadCount: Number(data.unreadCount || 0),
    metadata: data.metadata || {},
  };
};

// LISTING_L8_MESSAGING_LISTING_CONTEXT_REPORT.md L8.3/L8.4: a thread's
// canonical listing reference is write-once, pinned here exactly like
// threadId/conversationKey already were. Confirmed live while building
// this fix that WITHOUT this list, a client resending a thread's real
// threadId alongside a DIFFERENT listing's listingId (e.g. the exact
// shape a listing-context-unaware local thread-id scheme would
// produce -- see the paired Flutter fix) silently overwrote the
// thread's listingId/listingTitle/contextId with the new listing's
// data while conversationKey stayed pinned to the OLD listing, leaving
// the row internally inconsistent (its own conversationKey hash still
// encoding the original listing, its listingId/listingTitle columns
// now describing a different one) -- and every later message in the
// same thread would snapshot whichever listing happened to be sent
// last, corrupting the conversation's history. A conversation that
// starts about one listing stays about that listing for its entire
// life; a genuinely different listing gets its own thread (a
// different conversationKey/threadId), never a mutation of this one.
// Fields that were ALREADY only ever client-supplied, never verified
// against a real listing, for every context type other than a resolved
// 'listing' (processed_product/logistics_load/general never canonicalize
// these at all) -- allowed to backfill from the client payload on an
// existing thread ONLY when the stored value is genuinely missing
// (pre-L8 row, or a context type that never had it), never once a real
// value is already stored.
const THREAD_CLIENT_TRUSTED_CONTEXT_FIELDS = [
  'contextType',
  'contextId',
  'listingId',
  'listingTitle',
  'listingQtyText',
  'imageUrl',
  'listingPriceText',
];

// Fields canonicalized server-side ONLY from a verified real listing
// (identity.ts's resolveListingContextByAnyId, see verifyAndCorrectReceiver
// above) -- an existing thread's stored value is authoritative, full
// stop. Never falls back to client-supplied input even when missing
// (a pre-L8 row with no listingNo yet simply has no listingNo until a
// dedicated backfill re-resolves it server-side; a client must never be
// able to fill in a "missing" canonical field with its own claimed
// value).
const THREAD_SERVER_CANONICAL_CONTEXT_FIELDS = ['listingNo', 'listingMode'];

const updateExistingThread = (strapi, existing, normalized) => {
  const pinned = { ...normalized };
  for (const field of THREAD_CLIENT_TRUSTED_CONTEXT_FIELDS) {
    pinned[field] = existing[field] ?? normalized[field];
  }
  for (const field of THREAD_SERVER_CANONICAL_CONTEXT_FIELDS) {
    pinned[field] = existing[field] ?? null;
  }
  return strapi.entityService.update(THREAD_UID, existing.id, {
    data: {
      ...pinned,
      threadId: existing.threadId || normalized.threadId,
      conversationKey: existing.conversationKey || normalized.conversationKey,
    },
  });
};

/**
 * MESSAGING M5 (MESSAGING_M1_M3_CORE_FIX_REPORT.md): `thread.conversationKey`
 * has a real unique DB constraint, but the find-then-create sequence below
 * has no transaction/lock -- two near-simultaneous first-messages between
 * the same two users could both pass `findThread`'s "not found" check and
 * both attempt `create`. The second would previously hit an unhandled
 * unique-constraint error and surface as a raw 500 for a request that, in
 * substance, succeeded (the conversation DOES exist, just created by the
 * other concurrent request). On a create failure, re-run `findThread` and
 * use the now-existing row instead of propagating the error -- no blind
 * duplicate create, and a losing race is not a user-visible failure.
 */
const upsertThread = async (strapi, data, user) => {
  const normalized = normalizeThreadData(data, user);
  const existing = await findThread(
    strapi,
    data,
    normalized.conversationKey,
    normalized.threadId,
  );
  if (existing) {
    return updateExistingThread(strapi, existing, normalized);
  }
  try {
    return await strapi.entityService.create(THREAD_UID, { data: normalized });
  } catch (e) {
    const raced = await findThread(
      strapi,
      data,
      normalized.conversationKey,
      normalized.threadId,
    );
    if (raced) {
      return updateExistingThread(strapi, raced, normalized);
    }
    throw e;
  }
};

const userFilter = (user) => {
  const actor = actorForUser(user);
  const ors = [];
  if (actor.email) {
    ors.push({ requesterEmail: actor.email }, { receiverEmail: actor.email });
  }
  if (actor.profileId) {
    ors.push(
      { requesterProfileId: actor.profileId },
      { receiverProfileId: actor.profileId },
    );
  }
  return ors.length ? { $or: ors } : { id: -1 };
};

/**
 * MESSAGING M2 (MESSAGING_M2_READ_UNREAD_FIX_REPORT.md): a message is
 * "unread by `current`" iff `current` did not send it AND nobody has
 * stamped it read yet (`readAt` empty). `readAt` is the canonical,
 * single read signal for a message (message.readBy carries the same
 * fact keyed by actor, for potential multi-party display, but readAt is
 * what unread-count and the double-tick UI both key off of -- one
 * semantic, not two).
 */
const messageIsUnreadFor = (message: any, current: { profileId: string; email: string }) => {
  if (isSamePerson(current.profileId, current.email, message.senderProfileId, message.senderEmail)) {
    return false;
  }
  return !message.readAt;
};

/**
 * MESSAGING M2: `thread.unreadCount` (the stored scalar) can never hold
 * two independent participants' counts at once, and nothing was ever
 * incrementing it on message send -- it was always 0 by the time a
 * client read it (BUG audited in MESSAGING_RELEASE_FORENSIC_AUDIT.md).
 * Unread count is computed fresh per request instead, from the same
 * per-message `readAt` ledger markRead already writes: for the calling
 * user, count messages in the given threads that are still unread
 * (readAt empty) and were not sent by that user. This is naturally
 * always >= 0, self-heals on refetch/app-restart, and needs no
 * incremental counter to keep in sync.
 */
const computeUnreadCountsByThread = async (
  strapi: any,
  threadIds: string[],
  current: { profileId: string; email: string },
) => {
  const counts = new Map<string, number>();
  const ids = Array.from(new Set(threadIds.filter(Boolean)));
  if (!ids.length) return counts;
  const rows = await strapi.entityService.findMany(MESSAGE_UID, {
    filters: { threadId: { $in: ids }, readAt: { $null: true } } as any,
    fields: ['threadId', 'senderEmail', 'senderProfileId', 'readAt'],
    limit: 5000,
  });
  const list = Array.isArray(rows) ? rows : [];
  for (const message of list) {
    if (!messageIsUnreadFor(message, current)) continue;
    const key = (message as any).threadId;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
};

export default {
  async mine(ctx) {
    const limit = Math.min(Number(ctx.query?.pagination?.limit || ctx.query?.limit || 220), 300);
    const rows = await strapi.entityService.findMany(THREAD_UID, {
      filters: userFilter(ctx.state.user),
      sort: { lastMessageAt: 'desc' } as any,
      limit,
    });
    const list = Array.isArray(rows) ? rows : [];
    const current = actorForUser(ctx.state.user);
    const unreadByThread = await computeUnreadCountsByThread(
      strapi,
      list.map((row: any) => row.threadId),
      current,
    );
    const withUnread = list.map((row: any) => ({
      ...row,
      unreadCount: unreadByThread.get(row.threadId) || 0,
    }));
    ctx.body = { data: withUnread };
  },

  async myMessages(ctx) {
    const limit = Math.min(Number(ctx.query?.pagination?.limit || ctx.query?.limit || 300), 300);
    const rows = await strapi.entityService.findMany(MESSAGE_UID, {
      filters: userFilter(ctx.state.user),
      sort: { sentAt: 'desc' },
      limit,
    });
    const list = Array.isArray(rows) ? rows : [];
    const current = actorForUser(ctx.state.user);
    const unreadByThread = await computeUnreadCountsByThread(
      strapi,
      list.map((row: any) => row.threadId),
      current,
    );
    const withUnread = list.map((row: any) => ({
      ...row,
      unreadCount: unreadByThread.get(row.threadId) || 0,
    }));
    ctx.body = { data: withUnread };
  },

  async messagesByThread(ctx) {
    const user = ctx.state.user;
    if (!user) return ctx.unauthorized('Giris gerekli.');
    const threadId = String(ctx.params.threadId || '').trim();
    if (!threadId) return ctx.badRequest('threadId gerekli.');
    const threadRows = await strapi.entityService.findMany(THREAD_UID, {
      filters: { $and: [{ threadId }, userFilter(user)] },
      limit: 1,
    });
    const thread = Array.isArray(threadRows) ? threadRows[0] : threadRows;
    if (!thread) return ctx.forbidden('Bu sohbete erisim yok.');
    const rows = await strapi.entityService.findMany(MESSAGE_UID, {
      filters: { threadId },
      sort: { sentAt: 'asc' },
      limit: 300,
    });
    ctx.body = { data: rows };
  },

  async markRead(ctx) {
    const user = ctx.state.user;
    if (!user) return ctx.unauthorized('Giris gerekli.');
    const threadId = String(ctx.params.threadId || '').trim();
    if (!threadId) return ctx.badRequest('threadId gerekli.');

    const threadRows = await strapi.entityService.findMany(THREAD_UID, {
      filters: {
        $and: [
          { threadId },
          userFilter(user),
        ],
      } as any,
      limit: 1,
    });
    const thread = Array.isArray(threadRows) ? threadRows[0] : threadRows;
    if (!thread) return ctx.forbidden('Bu sohbete erisim yok.');

    const actor = actorForUser(user);
    const readAt =
      String((ctx.request?.body || {}).readAt || '').trim() || new Date().toISOString();
    const threadMap = thread as any;
    const currentReceipts =
      threadMap.readReceipts && typeof threadMap.readReceipts === 'object'
        ? { ...threadMap.readReceipts }
        : {};
    currentReceipts[actor.profileId || actor.email || actor.name] = readAt;

    const updatedThread = await strapi.entityService.update(THREAD_UID, thread.id, {
      data: {
        lastReadAt: readAt,
        readReceipts: currentReceipts,
      } as any,
    });

    try {
      const messages = await strapi.entityService.findMany(MESSAGE_UID, {
        filters: { threadId },
        limit: 300,
      });
      const list = Array.isArray(messages) ? messages : [];
      // MESSAGING M2 / BUG-M6 (MESSAGING_RELEASE_FORENSIC_AUDIT.md,
      // MESSAGING_M2_READ_UNREAD_FIX_REPORT.md): this used to stamp
      // readAt/readBy on EVERY message in the thread, including the
      // caller's own outgoing ones -- corrupting the double-tick UI (a
      // message would look "read" the moment anyone in the thread
      // called markRead, regardless of who actually read it) and
      // colliding with unread-count, which also keys off readAt. Only
      // messages the caller did NOT send, and that are still unread, are
      // touched -- an already-read message's readAt is left as-is
      // (repeat markRead calls are then a true no-op at the message
      // level; only the thread's readReceipts/lastReadAt watermark
      // above advances on every call, which is expected).
      const toMark = list.filter(
        (message: any) =>
          !isSamePerson(actor.profileId, actor.email, message.senderProfileId, message.senderEmail) &&
          !message.readAt,
      );
      await Promise.all(
        toMark.map((message: any) => {
          const readBy =
            message.readBy && typeof message.readBy === 'object'
              ? { ...message.readBy }
              : {};
          readBy[actor.profileId || actor.email || actor.name] = readAt;
          return strapi.entityService.update(MESSAGE_UID, message.id, {
            data: { readAt, readBy } as any,
          });
        }),
      );
    } catch (e) {
      strapi.log.warn(`Conversation markRead message update failed: ${String(e)}`);
    }

    ctx.body = { data: { ok: true, threadId, readAt, thread: updatedThread } };
  },

  async upsert(ctx) {
    const user = ctx.state.user;
    if (!user) return ctx.unauthorized('Giris gerekli.');
    const data = asData(ctx);

    const verified = await verifyAndCorrectReceiver(strapi, data, user);
    if (verified.forbidden) {
      return ctx.forbidden('Bu sohbete erisim yetkin yok.');
    }
    if (verified.rejected) {
      return ctx.badRequest(REJECTION_MESSAGES[verified.rejected] || 'Istek reddedildi.');
    }
    const p = normalizeParticipants(data, user);
    if (
      isSamePerson(
        p.requesterProfileId,
        p.requesterEmail,
        p.receiverProfileId,
        p.receiverEmail,
      )
    ) {
      return ctx.badRequest('Ayni profil icin sohbet acilamaz.');
    }
    if (!senderIsParticipant(p)) {
      return ctx.forbidden('Sadece sohbet katilimcisi sohbet acabilir.');
    }
    const thread = await upsertThread(strapi, data, user);
    ctx.body = { data: thread };
  },

  async sendMessage(ctx) {
    const user = ctx.state.user;
    if (!user) return ctx.unauthorized('Giris gerekli.');
    const data = asData(ctx);
    const text = pick(data, ['message', 'text', 'body']);
    if (!text) return ctx.badRequest('Mesaj bos olamaz.');

    const verified = await verifyAndCorrectReceiver(strapi, data, user);
    if (verified.forbidden) {
      return ctx.forbidden('Bu sohbete erisim yetkin yok.');
    }
    if (verified.rejected) {
      return ctx.badRequest(REJECTION_MESSAGES[verified.rejected] || 'Istek reddedildi.');
    }
    const conversationKey = conversationKeyFor(data, user);
    const threadId = threadIdFor(data, conversationKey);
    const existingThread = verified.existingThread;
    const p = normalizeParticipants(data, user);
    if (
      isSamePerson(
        p.requesterProfileId,
        p.requesterEmail,
        p.receiverProfileId,
        p.receiverEmail,
      )
    ) {
      return ctx.badRequest('Kullanici kendisine mesaj gonderemez.');
    }
    if (!senderIsParticipant(p)) {
      return ctx.forbidden('Sadece sohbet katilimcisi mesaj gonderebilir.');
    }

    // MESSAGING M4 (MESSAGING_M4_RELIABILITY_FIX_REPORT.md): a client
    // retrying a send it never got a response for (timeout, dropped
    // connection) must not be able to create a second message. The
    // client generates a stable UUID operationId once per logical send
    // attempt and resends the SAME one on retry -- mirrors the proven
    // listing-comment/listing-share pattern (operation-idempotency.ts).
    // Clients that don't send one (older builds, or callers that don't
    // need retry, e.g. the stock-CRUD fallback path) are unaffected:
    // operationId is optional, and a message without one is simply never
    // matched by resolveOperation.
    const operationIdRaw = pick(data, ['operationId', 'clientMessageId']);
    const operationId = isValidOperationId(operationIdRaw) ? operationIdRaw : '';
    let fingerprint = '';
    if (operationId) {
      fingerprint = fingerprintPayload({
        threadId,
        text,
        senderProfileId: p.senderProfileId,
        senderEmail: p.senderEmail,
        receiverProfileId: p.receiverProfileId,
        receiverEmail: p.receiverEmail,
      });
      const resolution = await resolveOperation(strapi, MESSAGE_UID, operationId, fingerprint);
      if (resolution.status === 'conflict') {
        return ctx.badRequest('Bu operationId farkli bir istekle daha once kullanilmis.');
      }
      if (resolution.status === 'duplicate') {
        ctx.body = { data: resolution.existing, thread: existingThread };
        return;
      }
    }

    const thread = await upsertThread(
      strapi,
      {
        ...data,
        lastMessage: text,
        lastMessagePreview: text,
        lastSenderEmail: p.senderEmail,
        lastSenderProfileId: p.senderProfileId,
        sentAt: pick(data, ['sentAt']) || new Date().toISOString(),
      },
      user,
    );
    const sentAt = pick(data, ['sentAt']) || new Date().toISOString();
    const messageData: Record<string, unknown> = {
      threadId: thread.threadId,
      conversationKey: thread.conversationKey,
      contextType: thread.contextType,
      contextId: thread.contextId,
      listingId: thread.listingId,
      listingTitle: thread.listingTitle,
      listingNo: thread.listingNo ?? null,
      message: text,
      text,
      direction: pick(data, ['direction']),
      senderEmail: p.senderEmail,
      senderProfileId: p.senderProfileId,
      senderName: p.senderName,
      requesterEmail: p.requesterEmail,
      requesterProfileId: p.requesterProfileId,
      requesterName: p.requesterName,
      receiverEmail: p.receiverEmail,
      receiverProfileId: p.receiverProfileId,
      receiverName: p.receiverName,
      // NOTIFICATION_N1_SECURITY_FIX_REPORT.md BUG-NOTIF-002: these alias
      // fields used to be re-picked from raw client `data` independently
      // of `p` (which verifyAndCorrectReceiver now corrects) -- always
      // mirror the same verified receiver p carries, not a second,
      // still-client-controlled copy of it.
      targetEmail: p.receiverEmail,
      targetProfileId: p.receiverProfileId,
      messageReceiverEmail: p.receiverEmail,
      messageReceiverProfileId: p.receiverProfileId,
      sentAt,
      metadata: messageMetadataFor(data),
    };
    if (operationId) {
      messageData.operationId = operationId;
      messageData.payloadFingerprint = fingerprint;
    }

    let message;
    try {
      message = await strapi.entityService.create(MESSAGE_UID, { data: messageData as any });
    } catch (e) {
      if (operationId) {
        // Concurrent retry already inserted the same operationId first --
        // re-resolve and return the winner's row idempotently instead of
        // propagating a raw unique-constraint error.
        const retry = await resolveOperation(strapi, MESSAGE_UID, operationId, fingerprint);
        if (retry.status === 'duplicate') {
          ctx.body = { data: retry.existing, thread };
          return;
        }
      }
      throw e;
    }
    ctx.body = { data: message, thread };
  },

  async deleteByThreadId(ctx) {
    const user = ctx.state.user;
    if (!user) return ctx.unauthorized('Giris gerekli.');
    const threadId = String(ctx.params.threadId || '').trim();
    if (!threadId) return ctx.badRequest('threadId gerekli.');

    const threadRows = await strapi.entityService.findMany(THREAD_UID, {
      filters: {
        $and: [
          { threadId },
          userFilter(user),
        ],
      } as any,
      limit: 1,
    });
    const thread = Array.isArray(threadRows) ? threadRows[0] : threadRows;
    if (!thread) return ctx.notFound('Konusma bulunamadi veya erisim yok.');

    const messages = await strapi.entityService.findMany(MESSAGE_UID, {
      filters: { threadId },
      limit: 500,
    });
    const msgList = Array.isArray(messages) ? messages : [];
    await Promise.all(msgList.map((m: any) => strapi.entityService.delete(MESSAGE_UID, m.id)));
    await strapi.entityService.delete(THREAD_UID, thread.id);

    ctx.body = { data: { deleted: true, threadId } };
  },
};
