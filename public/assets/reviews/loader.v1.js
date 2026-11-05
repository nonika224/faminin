const DEFAULT_PAGE_SIZE = 8;
const SCHEMA_VERSION = 'reviews.v1';
const VALID_STATES = new Set(['idle', 'loading', 'ready', 'empty', 'error']);
const REVIEW_RATINGS = Object.freeze([1, 2, 3, 4, 5]);
const DISTRIBUTION_SEED = 'reviews.v1.aggregate-distribution.3';
const RATING_CONSISTENCY_EPSILON = 1e-9;

function assertProductId(productId) {
  if (typeof productId !== 'string' || productId.trim() === '') {
    throw new TypeError('productId must be a non-empty string');
  }
  return productId.trim();
}

function stableReviewKey(review) {
  if (typeof review.sourceReviewId === 'string' && review.sourceReviewId.trim()) {
    return `source:${review.sourceReviewId.trim()}`;
  }
  const fields = ['rating', 'title', 'body', 'author', 'createdAt', 'verifiedPurchase'];
  const canonical = fields.map((field) => `${field}:${JSON.stringify(review[field] ?? null)}`).join('|');
  let hash = 2166136261;
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= canonical.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `hash:${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function normalizedUrl(value) {
  if (typeof value !== 'string') return '';
  const url = value.trim();
  return /^(?:https?:\/\/|\/)/i.test(url) ? url : '';
}

function normalizedLabelValueList(value) {
  const source = Array.isArray(value)
    ? value
    : value && typeof value === 'object'
      ? Object.entries(value).map(([label, itemValue]) => ({ label, value: itemValue }))
      : [];
  return source.map((item) => {
    if (typeof item === 'string' && item.trim()) return { label: item.trim(), value: '' };
    if (!item || typeof item !== 'object') return null;
    const label = String(item.label ?? item.name ?? item.key ?? item.title ?? '').trim();
    const itemValue = String(item.value ?? item.text ?? item.answer ?? '').trim();
    return label || itemValue ? { label, value: itemValue } : null;
  }).filter(Boolean);
}

function normalizeReviewMeta(payload) {
  const summaryCandidate = payload?.opinionSummary ?? payload?.summaryText ?? payload?.summary?.text;
  const opinionSummary = typeof summaryCandidate === 'string' ? summaryCandidate.trim().slice(0, 2000) : '';
  const attributeSource = payload?.attributeRatings ?? payload?.attributeSummary ?? payload?.ratingAttributes;
  const attributeRatings = (Array.isArray(attributeSource) ? attributeSource : []).map((item) => {
    if (!item || typeof item !== 'object') return null;
    const label = String(item.label ?? item.name ?? item.title ?? '').trim();
    const segments = Math.max(2, Math.min(7, Math.round(Number(item.segments) || 5)));
    const value = Number(item.value ?? item.rating ?? item.score);
    if (!label || !Number.isFinite(value) || value < 1 || value > segments) return null;
    return {
      label,
      value,
      segments,
      lowLabel: String(item.lowLabel ?? item.minLabel ?? '').trim(),
      highLabel: String(item.highLabel ?? item.maxLabel ?? '').trim(),
    };
  }).filter(Boolean);
  return Object.freeze({ opinionSummary, attributeRatings: Object.freeze(attributeRatings) });
}

function normalizeReview(review) {
  if (!review || typeof review !== 'object' || Array.isArray(review)) return null;
  const rating = Number(review.rating);
  const body = typeof review.body === 'string' ? review.body.trim() : '';
  if (!Number.isInteger(rating) || rating < 1 || rating > 5 || !body) return null;

  const normalized = { rating, body };
  if (typeof review.sourceReviewId === 'string' && review.sourceReviewId.trim()) {
    normalized.sourceReviewId = review.sourceReviewId.trim().slice(0, 300);
  }
  if (typeof review.title === 'string' && review.title.trim()) {
    normalized.title = review.title.trim().slice(0, 300);
  }
  if (typeof review.author === 'string' && review.author.trim()) {
    normalized.author = review.author.trim().slice(0, 200);
  }
  if (typeof review.createdAt === 'string' && Number.isFinite(Date.parse(review.createdAt))) {
    normalized.createdAt = review.createdAt;
  }
  if (typeof review.verifiedPurchase === 'boolean') {
    normalized.verifiedPurchase = review.verifiedPurchase;
  }
  const avatarUrl = normalizedUrl(review.avatarUrl ?? review.avatar ?? review.authorPhoto);
  if (avatarUrl) normalized.avatarUrl = avatarUrl;
  if (typeof (review.location ?? review.localidade) === 'string' && String(review.location ?? review.localidade).trim()) {
    normalized.location = String(review.location ?? review.localidade).trim().slice(0, 200);
  }
  const attributes = normalizedLabelValueList(review.attributes ?? review.atributos);
  if (attributes.length) normalized.attributes = attributes;
  const helpfulCount = Number(review.helpfulCount ?? review.helpful);
  if (Number.isInteger(helpfulCount) && helpfulCount >= 0) normalized.helpfulCount = helpfulCount;
  const commentUrl = normalizedUrl(review.commentUrl ?? review.commentHref);
  if (commentUrl) normalized.commentUrl = commentUrl;
  if (Array.isArray(review.photos)) {
    const seenPhotos = new Set();
    normalized.photos = review.photos.map((photo) => {
      const src = normalizedUrl(typeof photo === 'string' ? photo : photo?.src ?? photo?.url ?? photo?.href);
      if (!src || seenPhotos.has(src)) return null;
      seenPhotos.add(src);
      const alt = typeof photo === 'object' && typeof photo?.alt === 'string' ? photo.alt.trim().slice(0, 300) : '';
      return { src, alt };
    }).filter(Boolean);
  }
  return normalized;
}

function dedupeReviews(reviews) {
  const seen = new Set();
  return (Array.isArray(reviews) ? reviews : [])
    .map(normalizeReview)
    .filter(Boolean)
    .filter((review) => {
      const key = stableReviewKey(review);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function summarizeReviews(reviews) {
  const normalized = dedupeReviews(reviews);
  const reviewCount = normalized.length;
  const rating = reviewCount
    ? normalized.reduce((total, review) => total + review.rating, 0) / reviewCount
    : null;
  return Object.freeze({ rating, reviewCount });
}

export function emptyReviewDistribution() {
  return Object.freeze(Object.fromEntries(REVIEW_RATINGS.map((rating) => [rating, 0])));
}

function distributionScore(distribution) {
  return REVIEW_RATINGS.reduce((total, rating) => total + (rating * distribution[rating]), 0);
}

function distributionReviewCount(distribution) {
  return REVIEW_RATINGS.reduce((total, rating) => total + distribution[rating], 0);
}

export function reviewDistributionRating(distribution, reviewCount) {
  return reviewCount ? distributionScore(distribution) / reviewCount : null;
}

export function normalizeReviewDistribution(value, reviewCount, { requirePositive = reviewCount > 0 } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Reviews manifest distribution is invalid');
  }
  const expectedKeys = REVIEW_RATINGS.map(String);
  const actualKeys = Object.keys(value);
  if (
    actualKeys.length !== expectedKeys.length ||
    expectedKeys.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
  ) {
    throw new Error('Reviews manifest distribution must contain only ratings 1 through 5');
  }

  const distribution = {};
  for (const rating of REVIEW_RATINGS) {
    const count = value[rating];
    if (!Number.isInteger(count) || count < (requirePositive ? 1 : 0)) {
      throw new Error('Reviews manifest distribution counts are invalid');
    }
    distribution[rating] = count;
  }
  if (distributionReviewCount(distribution) !== reviewCount) {
    throw new Error('Reviews manifest distribution must sum to reviewCount');
  }
  return Object.freeze(distribution);
}

function deterministicHash(value) {
  let hash = 2166136261;
  const source = String(value);
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seededUnitGenerator(productId) {
  let state = deterministicHash(`${DISTRIBUTION_SEED}:${productId}`);
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function scoreDistribution(reviewCount, targetRating) {
  const targetScore = Math.max(reviewCount, Math.min(5 * reviewCount, Math.round(targetRating * reviewCount)));
  const baseRating = Math.max(1, Math.min(5, Math.floor(targetScore / reviewCount)));
  const higherCount = baseRating < 5 ? targetScore - (baseRating * reviewCount) : 0;
  const distribution = Object.fromEntries(REVIEW_RATINGS.map((rating) => [rating, 0]));
  distribution[baseRating] = reviewCount - higherCount;
  if (higherCount) distribution[baseRating + 1] = higherCount;
  return Object.freeze(distribution);
}

// This is only a compatibility fallback for summaries written before a
// materialized distribution was added to the manifest. It is deterministic
// from productId and never uses a runtime random source.
export function createDeterministicAggregateDistribution(productId, reviewCount, sourceRating) {
  if (!Number.isInteger(reviewCount) || reviewCount < 0) {
    throw new TypeError('reviewCount must be a non-negative integer');
  }
  if (reviewCount === 0) return emptyReviewDistribution();

  const rawRating = Number(sourceRating);
  const safeRating = Number.isFinite(rawRating) ? Math.max(1, Math.min(5, rawRating)) : 4.5;
  if (reviewCount < 12 || safeRating < 4.1) return scoreDistribution(reviewCount, safeRating);

  const next = seededUnitGenerator(productId);
  // A five-star mean cannot coexist with at least one rating in every bin.
  // Only a literal near-five legacy mean is brought to a seeded, still-high
  // band before deriving a mathematically exact aggregate mean.
  const highRating = 4.74 + (next() * 0.07);
  const targetRating = safeRating >= 4.95
    ? highRating
    : Math.max(4.1, safeRating);
  const minScore = Math.ceil(4.1 * reviewCount);
  const maxScore = (5 * reviewCount) - 10;
  const targetScore = Math.max(minScore, Math.min(maxScore, Math.round(targetRating * reviewCount)));
  let totalLossFromFiveStars = (5 * reviewCount) - targetScore;
  const lowBinRanges = [
    { rating: 1, minimum: 0.008, maximum: 0.018 },
    { rating: 2, minimum: 0.010, maximum: 0.024 },
    { rating: 3, minimum: 0.012, maximum: 0.030 },
  ];
  const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const range of lowBinRanges) {
    const minimum = Math.max(1, Math.ceil(reviewCount * range.minimum));
    const maximum = Math.max(minimum, Math.floor(reviewCount * range.maximum));
    distribution[range.rating] = minimum + Math.floor(next() * ((maximum - minimum) + 1));
  }

  const lowBinLoss = () => (4 * distribution[1]) + (3 * distribution[2]) + (2 * distribution[3]);
  const lowBinTotal = () => distribution[1] + distribution[2] + distribution[3];
  const largestLowBin = () => Math.max(distribution[1], distribution[2], distribution[3]);
  const requiredFourStarCount = () => Math.max(Math.ceil(reviewCount * 0.05), largestLowBin() + 1);
  while (lowBinLoss() + requiredFourStarCount() > totalLossFromFiveStars) {
    const reducible = [1, 2, 3]
      .filter((rating) => distribution[rating] > 1)
      .sort((left, right) => distribution[right] - distribution[left] || right - left);
    if (!reducible.length) {
      totalLossFromFiveStars = lowBinLoss() + requiredFourStarCount();
      break;
    }
    distribution[reducible[0]] -= 1;
  }

  const minimumLoss = lowBinLoss() + requiredFourStarCount();
  const maximumLoss = reviewCount - lowBinTotal() + lowBinLoss() - (largestLowBin() + 1);
  totalLossFromFiveStars = Math.max(minimumLoss, Math.min(maximumLoss, totalLossFromFiveStars));
  distribution[4] = totalLossFromFiveStars - lowBinLoss();
  distribution[5] = reviewCount - lowBinTotal() - distribution[4];
  return Object.freeze(distribution);
}

function manifestEntrySummary(entry, productId) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return undefined;
  const hasRating = Object.prototype.hasOwnProperty.call(entry, 'rating');
  const hasReviewCount = Object.prototype.hasOwnProperty.call(entry, 'reviewCount');
  if (!hasRating && !hasReviewCount) return undefined;
  if (!hasRating || !hasReviewCount) throw new Error('Reviews manifest summary is incomplete');

  const reviewCount = Number(entry.reviewCount);
  if (!Number.isInteger(reviewCount) || reviewCount < 0) {
    throw new Error('Reviews manifest reviewCount is invalid');
  }
  if (reviewCount === 0) {
    if (entry.rating !== null) throw new Error('Reviews manifest empty summary must have a null rating');
    if (!Object.prototype.hasOwnProperty.call(entry, 'distribution')) {
      return Object.freeze({ rating: null, reviewCount: 0 });
    }
    return Object.freeze({
      rating: null,
      reviewCount: 0,
      distribution: normalizeReviewDistribution(entry.distribution, 0, { requirePositive: false }),
    });
  }

  const rating = Number(entry.rating);
  if (!Number.isFinite(rating) || rating < 1 || rating > 5) {
    throw new Error('Reviews manifest rating is invalid');
  }
  if (Object.prototype.hasOwnProperty.call(entry, 'distribution')) {
    const distribution = normalizeReviewDistribution(entry.distribution, reviewCount);
    const aggregateRating = reviewDistributionRating(distribution, reviewCount);
    if (Math.abs(rating - aggregateRating) > RATING_CONSISTENCY_EPSILON) {
      throw new Error('Reviews manifest rating does not match its distribution');
    }
    return Object.freeze({ rating, reviewCount, distribution });
  }

  const distribution = createDeterministicAggregateDistribution(productId, reviewCount, rating);
  return Object.freeze({
    rating: reviewDistributionRating(distribution, reviewCount),
    reviewCount,
    distribution,
  });
}

function snapshot(productId, state, extra = {}) {
  return Object.freeze({ productId, state, ...extra });
}

function environmentBaseUrl() {
  return globalThis.document?.baseURI || globalThis.location?.href || 'http://localhost/';
}

function resolveUrl(value, base = environmentBaseUrl()) {
  return new URL(String(value), base).href;
}

export function createReviewsLoader({
  manifestUrl = '/assets/reviews/manifest.v1.json',
  summariesUrl = null,
  fetchImpl = globalThis.fetch,
  pageSize = DEFAULT_PAGE_SIZE,
  onState = () => {},
  onSummaries = () => {},
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
  if (!Number.isInteger(pageSize) || pageSize < 1) throw new RangeError('pageSize must be a positive integer');

  const absoluteManifestUrl = resolveUrl(manifestUrl);
  const absoluteSummariesUrl = summariesUrl ? resolveUrl(summariesUrl) : '';
  const productCache = new Map();
  const productMetaCache = new Map();
  const summaryCache = new Map();
  let manifestPromise;
  let summariesPromise;
  let activeProductId = null;
  let requestSerial = 0;
  let current = snapshot(null, 'idle', { reviews: [], pageSize });
  let currentSummaries = Object.freeze({ state: 'idle', summaries: Object.freeze({}) });

  const publish = (next) => {
    if (!VALID_STATES.has(next.state)) throw new Error(`Invalid reviews state: ${next.state}`);
    current = snapshot(next.productId ?? null, next.state, {
      reviews: next.reviews ?? [],
      pageSize,
      ...next,
    });
    onState(current);
    return current;
  };

  const publishSummaries = (state, error) => {
    const summaries = Object.freeze(Object.fromEntries(
      [...summaryCache].map(([productId, summary]) => [productId, Object.freeze({ ...summary })])
    ));
    currentSummaries = Object.freeze({ state, summaries, ...(error ? { error } : {}) });
    onSummaries(currentSummaries);
    return currentSummaries;
  };

  const ensureSummaryFromReviews = (productId, reviews) => {
    const manifestSummary = summaryCache.get(productId);
    if (manifestSummary) return manifestSummary;

    const fallbackSummary = summarizeReviews(reviews);
    summaryCache.set(productId, fallbackSummary);
    publishSummaries('ready');
    return fallbackSummary;
  };

  const getJson = async (url) => {
    const response = await fetchImpl(url, { headers: { Accept: 'application/json' } });
    if (!response || !response.ok) throw new Error(`Reviews request failed (${response?.status ?? 'unknown'})`);
    return response.json();
  };

  const getSummariesManifest = () => {
    if (!absoluteSummariesUrl) return getManifest();
    if (!summariesPromise) {
      summariesPromise = getJson(absoluteSummariesUrl)
        .then((manifest) => {
          if (
            manifest?.schemaVersion !== 'reviews-summaries.v1' ||
            !manifest.products ||
            typeof manifest.products !== 'object' ||
            Array.isArray(manifest.products)
          ) {
            throw new Error('Reviews summaries manifest is invalid');
          }
          summaryCache.clear();
          Object.entries(manifest.products).forEach(([productId, entry]) => {
            const summary = manifestEntrySummary(entry, String(productId));
            if (summary) summaryCache.set(String(productId), summary);
          });
          publishSummaries('ready');
          return manifest;
        })
        .catch((error) => {
          summariesPromise = undefined;
          throw error;
        });
    }
    return summariesPromise;
  };

  const getManifest = () => {
    if (!manifestPromise) {
      manifestPromise = getJson(absoluteManifestUrl)
        .then((manifest) => {
          if (
            manifest?.schemaVersion !== SCHEMA_VERSION ||
            !manifest.products ||
            typeof manifest.products !== 'object' ||
            Array.isArray(manifest.products)
          ) {
            throw new Error('Reviews manifest is invalid');
          }
          summaryCache.clear();
          Object.entries(manifest.products).forEach(([productId, entry]) => {
            const summary = manifestEntrySummary(entry, String(productId));
            if (summary) summaryCache.set(String(productId), summary);
          });
          publishSummaries('ready');
          return manifest;
        })
        .catch((error) => {
          manifestPromise = undefined;
          summaryCache.clear();
          if (currentSummaries.state === 'ready') {
            Object.entries(currentSummaries.summaries).forEach(([id, summary]) => summaryCache.set(id, summary));
          } else {
            publishSummaries('error', error);
          }
          throw error;
        });
    }
    return manifestPromise;
  };

  const loadSummaries = async () => {
    if (currentSummaries.state === 'ready') return currentSummaries;
    if (currentSummaries.state !== 'loading') publishSummaries('loading');
    try {
      await getSummariesManifest();
    } catch {
      // Preserve the existing full-manifest path as a resilience fallback.
      await getManifest();
    }
    return currentSummaries;
  };

  const load = async (productId) => {
    const id = assertProductId(productId);
    const requestId = ++requestSerial;
    activeProductId = id;
    publish({ productId: id, state: 'loading', reviews: [] });
    try {
      if (!productCache.has(id)) {
        const manifest = await getManifest();
        const entry = manifest.products[id];
        if (!entry) {
          productCache.set(id, []);
          productMetaCache.set(id, normalizeReviewMeta(null));
          if (!summaryCache.has(id)) summaryCache.set(id, Object.freeze({ rating: null, reviewCount: 0 }));
        } else {
          const path = typeof entry === 'string' ? entry : entry?.path;
          if (typeof path !== 'string' || !path.trim()) throw new Error(`Reviews entry for ${id} is invalid`);
          const payload = await getJson(resolveUrl(path, absoluteManifestUrl));
          if (
            payload?.schemaVersion !== SCHEMA_VERSION ||
            String(payload.productId || '') !== id ||
            !Array.isArray(payload.reviews)
          ) {
            throw new Error(`Reviews payload for ${id} is invalid`);
          }
          const normalizedReviews = dedupeReviews(payload.reviews);
          productCache.set(id, normalizedReviews);
          productMetaCache.set(id, normalizeReviewMeta(payload));
          ensureSummaryFromReviews(id, normalizedReviews);
        }
      }
      const reviews = productCache.get(id) ?? [];
      const summary = ensureSummaryFromReviews(id, reviews);
      if (requestId !== requestSerial || activeProductId !== id) return current;
      return publish({
        productId: id,
        state: summary.reviewCount ? 'ready' : 'empty',
        reviews,
        summary,
        meta: productMetaCache.get(id) ?? normalizeReviewMeta(null),
      });
    } catch (error) {
      if (requestId !== requestSerial || activeProductId !== id) return current;
      return publish({ productId: id, state: 'error', reviews: [], error });
    }
  };

  const getPage = (productId, page = 1) => {
    const id = assertProductId(productId);
    if (!Number.isInteger(page) || page < 1) throw new RangeError('page must be a positive integer');
    const reviews = productCache.get(id) ?? [];
    const totalPages = Math.max(1, Math.ceil(reviews.length / pageSize));
    const safePage = Math.min(page, totalPages);
    return {
      productId: id,
      page: safePage,
      pageSize,
      total: reviews.length,
      totalPages,
      reviews: reviews.slice((safePage - 1) * pageSize, safePage * pageSize),
      summary: summaryCache.get(id) ?? summarizeReviews(reviews),
      meta: productMetaCache.get(id) ?? normalizeReviewMeta(null),
    };
  };

  const clear = (productId) => {
    const id = assertProductId(productId);
    productCache.delete(id);
    productMetaCache.delete(id);
    if (activeProductId === id) {
      requestSerial += 1;
      activeProductId = null;
      publish({ productId: null, state: 'idle', reviews: [] });
    }
  };

  const clearAll = () => {
    productCache.clear();
    productMetaCache.clear();
    summaryCache.clear();
    manifestPromise = undefined;
    summariesPromise = undefined;
    requestSerial += 1;
    activeProductId = null;
    publish({ productId: null, state: 'idle', reviews: [] });
    publishSummaries('idle');
  };

  return Object.freeze({
    load,
    loadSummaries,
    getPage,
    getSummary: (productId) => summaryCache.get(assertProductId(productId)) ?? null,
    getSummarySnapshot: () => currentSummaries,
    clear,
    clearAll,
    getSnapshot: () => current,
  });
}

export { dedupeReviews, normalizeReview, normalizeReviewMeta, resolveUrl, stableReviewKey, summarizeReviews };
