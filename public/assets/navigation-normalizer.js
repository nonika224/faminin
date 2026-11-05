(() => {
  "use strict";

  if (window.__centauroNavigationNormalizerInstalled) return;
  window.__centauroNavigationNormalizerInstalled = true;

  const OFFICIAL_HOST = /(?:^|\.)centauro\.com\.br$/i;
  const ASSET_PATH = /(?:^|\/)(?:assets?|images?|img|media|fonts?)\/|\.(?:avif|css|gif|ico|jpe?g|js|mjs|map|png|svg|webp|woff2?)(?:$|[?#])/i;
  const FOOTER_EXCLUSIONS = ".matrix-cart-summary, .matrix-product-sticky-buybar, .fixed.bottom-0, #pp-root .pp-foot";
  const INTERACTIVE = "a[href],area[href],button,input,select,textarea,summary,[role='button'],[role='link'],[tabindex]:not([tabindex='-1'])";

  const isOfficialPage = (url) =>
    /^(?:https?:)$/.test(url.protocol) && OFFICIAL_HOST.test(url.hostname) && !ASSET_PATH.test(url.pathname);

  const productIdFrom = (url) => {
    const pathMatch = url.pathname.match(/^\/produto\/([^/?#]+)/i);
    if (!pathMatch && !/^\/produto\/?$/i.test(url.pathname)) return "";
    const queryId = ["productId", "produtoId", "sku", "id"]
      .map((key) => url.searchParams.get(key))
      .find(Boolean);
    const candidate = String(pathMatch?.[1] || queryId || "").replace(/\.html$/i, "").trim();
    return /^[a-z0-9_-]+$/i.test(candidate) ? candidate : "";
  };

  const spaRouteFor = (value) => {
    let url;
    try {
      url = new URL(String(value || ""), window.location.href);
    } catch {
      return null;
    }
    if (!isOfficialPage(url)) return null;

    const path = url.pathname.replace(/\/+$/, "") || "/";
    const productId = productIdFrom(url);
    if (productId) return `/produto/${encodeURIComponent(productId)}`;
    if (path === "/" || path === "/home") return "/";
    if (/^\/(?:busca|search)(?:\/|$)/i.test(path)) return `/busca${url.search}${url.hash}`;
    if (/^\/(?:carrinho|cart)(?:\/|$)/i.test(path)) return "/carrinho";
    if (/^\/(?:entrega|checkout(?:\/entrega)?)(?:\/|$)/i.test(path)) return "/entrega";
    if (/^\/(?:pagamento|cartao|checkout\/(?:pagamento|cartao))(?:\/|$)/i.test(path)) return "/pagamento";
    return null;
  };

  const pageFooterFor = (element) => {
    const footer = element?.closest?.("footer");
    return footer && !footer.matches(FOOTER_EXCLUSIONS) ? footer : null;
  };

  const makeFooterInert = (footer) => {
    if (!footer || footer.matches(FOOTER_EXCLUSIONS)) return;
    if (!footer.hasAttribute("inert")) footer.setAttribute("inert", "");
    if (footer.getAttribute("aria-disabled") !== "true") footer.setAttribute("aria-disabled", "true");
    if (footer.dataset.centauroFooterInert !== "true") footer.dataset.centauroFooterInert = "true";
    try { if (footer.inert !== true) footer.inert = true; } catch {}
    footer.querySelectorAll(INTERACTIVE).forEach((control) => {
      if (control.getAttribute("aria-disabled") !== "true") control.setAttribute("aria-disabled", "true");
    });
  };

  const normalizeAnchor = (anchor) => {
    if (anchor.dataset.matrixNativeBanner === "true") return null;
    if (pageFooterFor(anchor)) return null;
    const markedRoute = anchor.dataset.centauroSpaRoute;
    if (markedRoute && anchor.getAttribute("href") === markedRoute) return markedRoute;
    const route = spaRouteFor(anchor.getAttribute("href"));
    if (!route) {
      delete anchor.dataset.centauroSpaRoute;
      return null;
    }
    if (anchor.getAttribute("href") !== route) anchor.setAttribute("href", route);
    anchor.removeAttribute("target");
    anchor.dataset.centauroSpaRoute = route;
    return route;
  };

  const normalizeForm = (form) => {
    if (pageFooterFor(form)) return null;
    const route = spaRouteFor(form.getAttribute("action"));
    if (!route) return null;
    if (form.getAttribute("action") !== route) form.setAttribute("action", route);
    return route;
  };

  const navigate = (route) => {
    const next = new URL(route, window.location.origin);
    const nextPath = `${next.pathname}${next.search}${next.hash}`;
    const currentPath = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (next.origin !== window.location.origin || nextPath === currentPath) return;
    window.history.pushState(window.history.state, "", nextPath);
    window.dispatchEvent(new PopStateEvent("popstate"));
  };

  const scan = (root) => {
    if (!root) return;
    const find = (selector) => {
      const matches = [];
      if (root.nodeType === 1 && root.matches?.(selector)) matches.push(root);
      root.querySelectorAll?.(selector).forEach((element) => matches.push(element));
      return matches;
    };
    const nearbyFooter = pageFooterFor(root.nodeType === 1 ? root : root.parentElement);
    if (nearbyFooter) makeFooterInert(nearbyFooter);
    find("footer").forEach((footer) => {
      if (footer !== nearbyFooter) makeFooterInert(footer);
    });
    find("a[href],area[href]").forEach(normalizeAnchor);
    find("form[action]").forEach(normalizeForm);
  };

  let scheduled = false;
  const pendingRoots = new Set();
  const schedule = (root = document) => {
    // React/Matrix can append a whole subtree in one commit. MutationObserver then
    // reports both parents and descendants; scanning every reported node repeats
    // the same querySelectorAll work. Keep only the shallowest pending roots.
    for (const pending of pendingRoots) {
      if (pending === root || pending?.contains?.(root)) return;
      if (root?.contains?.(pending)) pendingRoots.delete(pending);
    }
    pendingRoots.add(root);
    if (scheduled) return;
    scheduled = true;
    const flush = () => {
      scheduled = false;
      const roots = [...pendingRoots];
      pendingRoots.clear();
      roots.forEach(scan);
    };
    if (typeof window.requestAnimationFrame === "function") window.requestAnimationFrame(flush);
    else setTimeout(flush, 0);
  };

  const nearestElement = (target) => target?.nodeType === 1 ? target : target?.parentElement;
  const stopFooterAction = (event) => {
    const control = nearestElement(event.target)?.closest?.(INTERACTIVE);
    if (!control || !pageFooterFor(control)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  const interceptAnchorNavigation = (event) => {
    const anchor = nearestElement(event.target)?.closest?.("a[href],area[href]");
    if (!anchor || pageFooterFor(anchor)) return;
    const route = normalizeAnchor(anchor);
    if (!route || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(route);
  };

  document.addEventListener("click", stopFooterAction, true);
  document.addEventListener("auxclick", stopFooterAction, true);
  document.addEventListener("pointerdown", stopFooterAction, true);
  if (!("PointerEvent" in window)) {
    document.addEventListener("touchstart", (event) => {
      const control = nearestElement(event.target)?.closest?.(INTERACTIVE);
      if (!control || !pageFooterFor(control)) return;
      // Keep the legacy touch fallback passive so normal scrolling never waits
      // for JavaScript. The subsequent click capture still prevents activation.
      event.stopImmediatePropagation();
    }, { capture: true, passive: true });
  }
  document.addEventListener("contextmenu", stopFooterAction, true);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") stopFooterAction(event);
  }, true);
  document.addEventListener("click", interceptAnchorNavigation, true);
  document.addEventListener("submit", (event) => {
    const form = nearestElement(event.target);
    if (pageFooterFor(form)) {
      stopFooterAction(event);
      return;
    }
    const route = normalizeForm(form);
    if (!route) return;
  }, true);

  if (typeof MutationObserver === "function") {
    const observer = new MutationObserver((records) => {
      for (const record of records) for (const node of record.addedNodes || []) {
        // Text nodes cannot introduce links, forms, footers, or controls.
        if (node.nodeType === 1) schedule(node);
      }
    });
    // href/action are normalized again at click/submit time, so there is no
    // need to observe every attribute mutation across the whole application.
    observer.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true
    });
  }

  window.__centauroNormalizeNavigation = schedule;
  window.__centauroSpaRouteFor = spaRouteFor;
  schedule();
})();
