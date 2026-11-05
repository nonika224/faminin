/**
 * Incremental PLP renderer.
 *
 * This module is intentionally inert until createPlpWindowingController is
 * called by the single integration point. It keeps the complete card target
 * in memory, but only mounts a small ordered window in the supplied container.
 */

const controllers = new WeakMap();

const DEFAULTS = Object.freeze({
  initialBatchSize: 12,
  batchSize: 24,
  rootMargin: '600px 0px',
  buttonLabel: 'Carregar mais produtos',
  buttonClassName: 'plp-windowing-load-more',
});

function asCards(cards) {
  if (cards == null) return [];
  if (Array.isArray(cards)) return cards.filter(Boolean);
  if (typeof cards[Symbol.iterator] === 'function') return [...cards].filter(Boolean);
  throw new TypeError('cards must be an Array or iterable collection');
}

function assertContainer(container) {
  if (!container || typeof container.append !== 'function' || !container.ownerDocument) {
    throw new TypeError('container must be a DOM element');
  }
  return container;
}

function getScrollState(container, documentRef) {
  const view = documentRef.defaultView;
  return {
    containerTop: container.scrollTop,
    containerLeft: container.scrollLeft,
    windowX: view?.scrollX ?? 0,
    windowY: view?.scrollY ?? 0,
  };
}

function restoreScrollState(container, state, documentRef) {
  if (!state) return;
  container.scrollTop = state.containerTop;
  container.scrollLeft = state.containerLeft;
  const view = documentRef.defaultView;
  view?.scrollTo?.(state.windowX, state.windowY);
}

function prepareImages(card, firstBatch) {
  if (!card || typeof card.querySelectorAll !== 'function') return;
  card.querySelectorAll('img').forEach((image) => {
    // Existing loading/decoding decisions belong to the integrator.
    if (!image.hasAttribute('loading') && !firstBatch) image.setAttribute('loading', 'lazy');
    if (!image.hasAttribute('decoding')) image.setAttribute('decoding', 'async');
  });
}

function safeFocus(element) {
  if (!element || typeof element.focus !== 'function') return;
  try { element.focus({ preventScroll: true }); } catch { element.focus(); }
}

function createPlpWindowingController(options = {}) {
  const container = assertContainer(options.container);
  const existing = controllers.get(container);
  if (existing && !options.replace) return existing;
  if (existing) existing.destroy();

  const documentRef = container.ownerDocument;
  const view = documentRef.defaultView;
  const config = { ...DEFAULTS, ...options };
  const initialBatchSize = Math.max(1, Number(config.initialBatchSize) || DEFAULTS.initialBatchSize);
  const batchSize = Math.max(1, Number(config.batchSize) || DEFAULTS.batchSize);
  let target = asCards(options.cards);
  let mountedCount = 0;
  let destroyed = false;
  let observer = null;
  let sentinel = null;
  let loadMoreButton = options.loadMoreButton || null;
  let ownsButton = false;
  let generation = 0;
  let scrollCheckQueued = false;
  const onRender = typeof config.onRender === 'function' ? config.onRender : null;

  const shouldUseIntersectionObserver = typeof view?.IntersectionObserver === 'function';

  function removeOwnedNodes() {
    sentinel?.remove();
    sentinel = null;
    if (ownsButton) loadMoreButton?.remove();
    ownsButton = false;
    loadMoreButton = options.loadMoreButton || null;
  }

  function renderNext(count = batchSize) {
    if (destroyed || mountedCount >= target.length) return false;
    const end = Math.min(target.length, mountedCount + Math.max(1, count));
    const fragment = documentRef.createDocumentFragment();
    for (let index = mountedCount; index < end; index += 1) {
      const card = target[index];
      card.hidden = false;
      card.removeAttribute?.('aria-hidden');
      prepareImages(card, mountedCount < initialBatchSize);
      fragment.append(card);
    }
    if (sentinel?.parentNode === container) container.insertBefore(fragment, sentinel);
    else container.append(fragment);
    mountedCount = end;
    syncControls();
    onRender?.({ mounted: mountedCount, total: target.length, hasMore: mountedCount < target.length });
    return true;
  }

  function nearViewportCheck() {
    scrollCheckQueued = false;
    if (destroyed || mountedCount >= target.length || !sentinel?.isConnected) return;
    const viewportHeight = view?.innerHeight || documentRef.documentElement?.clientHeight || 0;
    const rect = sentinel.getBoundingClientRect?.();
    if (rect && rect.top <= viewportHeight + 900) {
      renderNext();
      scheduleNearViewportCheck();
    }
  }

  function scheduleNearViewportCheck() {
    if (destroyed || scrollCheckQueued || mountedCount >= target.length) return;
    scrollCheckQueued = true;
    (view?.requestAnimationFrame || ((callback) => setTimeout(callback, 16)))(nearViewportCheck);
  }

  function ensureControls() {
    if (mountedCount >= target.length) return;
    if (shouldUseIntersectionObserver) {
      if (!sentinel) {
        sentinel = documentRef.createElement('span');
        sentinel.setAttribute('aria-hidden', 'true');
        sentinel.setAttribute('data-plp-windowing-sentinel', '');
        sentinel.style.cssText = 'display:block;width:1px;height:1px;pointer-events:none;';
        container.append(sentinel);
      }
      if (!observer) {
        observer = new view.IntersectionObserver((entries) => {
          if (entries.some((entry) => entry.isIntersecting)) renderNext();
        }, { root: config.root || null, rootMargin: config.rootMargin, threshold: 0 });
        observer.observe(sentinel);
      }
      return;
    }
    if (!loadMoreButton) {
      loadMoreButton = documentRef.createElement('button');
      ownsButton = true;
      loadMoreButton.type = 'button';
      loadMoreButton.className = config.buttonClassName;
      loadMoreButton.textContent = config.buttonLabel;
      loadMoreButton.addEventListener('click', () => renderNext());
    }
    if (!loadMoreButton.isConnected) container.append(loadMoreButton);
  }

  function syncControls() {
    ensureControls();
    const hasMore = mountedCount < target.length;
    if (loadMoreButton) {
      loadMoreButton.hidden = !hasMore;
      loadMoreButton.disabled = !hasMore;
    }
    if (!hasMore && observer) {
      observer.disconnect();
      observer = null;
    }
    if (hasMore && !shouldUseIntersectionObserver) scheduleNearViewportCheck();
  }

  function reset(nextCards, resetOptions = {}) {
    if (destroyed) return api;
    const active = documentRef.activeElement;
    const hadFocusInside = active && container.contains(active);
    const scroll = getScrollState(container, documentRef);
    const nextTarget = asCards(nextCards);
    generation += 1;
    observer?.disconnect();
    observer = null;
    removeOwnedNodes();
    // Detach only cards owned by this controller. Other content in the
    // supplied container belongs to the integrator and stays untouched.
    target.forEach((card) => {
      if (container.contains(card)) card.remove();
    });
    target = nextTarget;
    mountedCount = 0;
    renderNext(resetOptions.initialBatchSize ? Number(resetOptions.initialBatchSize) : initialBatchSize);
    restoreScrollState(container, scroll, documentRef);
    if (hadFocusInside) {
      if (active?.isConnected) safeFocus(active);
      else safeFocus(container.querySelector('[tabindex],button,a,input,select,textarea'));
    }
    return api;
  }

  function ownsNode(node) {
    if (!node) return false;
    if (node === sentinel || node === loadMoreButton) return true;
    if (target.includes(node)) return true;
    if (node.nodeType === 1 && node.hasAttribute?.('data-plp-windowing-sentinel')) return true;
    return false;
  }

  function getState() {
    return Object.freeze({ generation, mounted: mountedCount, total: target.length, hasMore: mountedCount < target.length, observerActive: Boolean(observer), scrollFallbackActive: Boolean(view && !shouldUseIntersectionObserver) });
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    observer?.disconnect();
    observer = null;
    view?.removeEventListener?.('scroll', scheduleNearViewportCheck);
    view?.removeEventListener?.('resize', scheduleNearViewportCheck);
    removeOwnedNodes();
    if (controllers.get(container) === api) controllers.delete(container);
  }

  const api = Object.freeze({
    loadMore: () => renderNext(),
    reset,
    getState,
    ownsNode,
    destroy,
  });

  if (!shouldUseIntersectionObserver) {
    view?.addEventListener?.('scroll', scheduleNearViewportCheck, { passive: true });
    view?.addEventListener?.('resize', scheduleNearViewportCheck, { passive: true });
  }
  controllers.set(container, api);
  // React may have mounted the complete result before this controller is
  // created. Remove those owned cards before the first batch is appended.
  target.forEach((card) => {
    if (container.contains(card)) card.remove();
  });
  // The initial render is the only work performed at construction time.
  renderNext(initialBatchSize);
  return api;
}

export { createPlpWindowingController };
export default createPlpWindowingController;
