(() => {
  "use strict";

  if (window.CentauroWebview?.version) return;

  const root = document.documentElement;
  const FIELD_SELECTOR = "input,textarea,select,[contenteditable='true']";
  const nowId = () => {
    try { return crypto.randomUUID(); } catch {}
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  };

  const userAgent = String(navigator.userAgent || "");
  const capabilities = Object.freeze({
    visualViewport: !!window.visualViewport,
    webShare: typeof navigator.share === "function",
    clipboard: typeof navigator.clipboard?.writeText === "function",
    reactNative: typeof window.ReactNativeWebView?.postMessage === "function",
    iosMessageHandler: typeof window.webkit?.messageHandlers?.centauro?.postMessage === "function",
    injectedNativeBridge: typeof window.CentauroNative?.postMessage === "function",
    instagramBrowser: /Instagram/i.test(userAgent),
    facebookBrowser: /(?:FBAN|FBAV|FB_IAB)/i.test(userAgent)
  });

  try {
    if (capabilities.instagramBrowser) root.dataset.centauroInAppBrowser = "instagram";
    else if (capabilities.facebookBrowser) root.dataset.centauroInAppBrowser = "facebook";
  } catch {}

  const pendingNativeRequests = new Map();
  const nativeBridge = {
    available() {
      return typeof window.ReactNativeWebView?.postMessage === "function" ||
        typeof window.webkit?.messageHandlers?.centauro?.postMessage === "function" ||
        typeof window.CentauroNative?.postMessage === "function";
    },
    post(type, payload = {}, options = {}) {
      const message = { id: nowId(), type: String(type || ""), payload };
      if (!message.type) return Promise.resolve({ handled: false, reason: "missing-type" });

      let posted = false;
      try {
        if (typeof window.ReactNativeWebView?.postMessage === "function") {
          window.ReactNativeWebView.postMessage(JSON.stringify(message));
          posted = true;
        } else if (typeof window.webkit?.messageHandlers?.centauro?.postMessage === "function") {
          window.webkit.messageHandlers.centauro.postMessage(message);
          posted = true;
        } else if (typeof window.CentauroNative?.postMessage === "function") {
          window.CentauroNative.postMessage(JSON.stringify(message));
          posted = true;
        }
      } catch (error) {
        return Promise.resolve({ handled: false, reason: "native-post-failed", error: String(error?.message || error) });
      }

      if (!posted) return Promise.resolve({ handled: false, reason: "native-unavailable" });
      if (options.expectResponse === false) return Promise.resolve({ handled: true, id: message.id });

      const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(250, options.timeoutMs) : 1800;
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          pendingNativeRequests.delete(message.id);
          resolve({ handled: true, acknowledged: false, id: message.id });
        }, timeoutMs);
        pendingNativeRequests.set(message.id, { resolve, timer });
      });
    },
    resolve(id, result = null, error = null) {
      const pending = pendingNativeRequests.get(String(id || ""));
      if (!pending) return false;
      clearTimeout(pending.timer);
      pendingNativeRequests.delete(String(id));
      pending.resolve({ handled: true, acknowledged: true, id: String(id), result, error });
      return true;
    }
  };

  const legacyCopy = (text) => {
    try {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.setAttribute("readonly", "");
      textarea.setAttribute("aria-hidden", "true");
      textarea.style.cssText = "position:fixed;opacity:0;pointer-events:none;left:-9999px;top:0";
      document.body.appendChild(textarea);
      try {
        textarea.select();
        textarea.setSelectionRange?.(0, textarea.value.length);
        const copied = !!document.execCommand?.("copy");
        return copied;
      } finally {
        textarea.remove();
      }
    } catch {
      return false;
    }
  };

  const copyText = async (value, options = {}) => {
    const text = String(value ?? "");
    if (!text) return { copied: false, method: "empty" };
    try {
      if (navigator.clipboard?.writeText && (window.isSecureContext !== false || location.protocol === "https:")) {
        await navigator.clipboard.writeText(text);
        return { copied: true, method: "clipboard" };
      }
    } catch {}
    if (legacyCopy(text)) return { copied: true, method: "execCommand" };
    if (options.native !== false && nativeBridge.available()) {
      const native = await nativeBridge.post("copy-text", { text }, { timeoutMs: 1200 });
      if (native.acknowledged && native.error == null && native.result !== false) return { copied: true, method: "native" };
      if (native.handled && !native.acknowledged) return { copied: null, method: "native-unconfirmed" };
    }
    return { copied: false, method: "unavailable" };
  };

  const share = async ({ title = "", text = "", url = "" } = {}) => {
    const payload = { title: String(title || ""), text: String(text || ""), url: String(url || "") };
    if (navigator.share) {
      try {
        await navigator.share(payload);
        return { shared: true, method: "web-share" };
      } catch (error) {
        if (error?.name === "AbortError") return { shared: false, cancelled: true, method: "web-share" };
      }
    }
    if (nativeBridge.available()) {
      const native = await nativeBridge.post("share", payload, { timeoutMs: 1500 });
      if (native.acknowledged && native.error == null && native.result !== false) return { shared: true, method: "native" };
      if (native.handled && !native.acknowledged) return { shared: null, method: "native-unconfirmed" };
    }
    return { shared: false, method: "unavailable" };
  };

  const viewport = (() => {
    const vv = window.visualViewport;
    let scheduled = false;
    let baselineHeight = Math.max(window.innerHeight || 0, vv?.height || 0);
    let lastKeyboardOpen = false;
    let lastField = null;
    let lastRevealHeight = 0;
    let revealFrame = 0;
    let revealRetryTimer = 0;
    const lastCss = new Map();

    const activeField = () => document.activeElement?.matches?.(FIELD_SELECTOR) ? document.activeElement : null;
    const setRootCss = (name, value) => {
      if (lastCss.get(name) === value) return;
      lastCss.set(name, value);
      root?.style?.setProperty?.(name, value);
    };
    const fixedBottomBarTop = (field, visualHeight, offsetTop) => {
      const viewportTop = Math.max(0, offsetTop);
      const viewportBottom = viewportTop + visualHeight;
      let boundary = viewportBottom;
      try {
        const fieldRect = field?.getBoundingClientRect?.();
        document.querySelectorAll?.(".fixed.bottom-0, .matrix-cart-summary, .matrix-product-sticky-buybar").forEach((bar) => {
          if (!bar?.isConnected || bar === field) return;
          const style = window.getComputedStyle?.(bar);
          if (!style || style.position !== "fixed" || style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return;
          const rect = bar.getBoundingClientRect?.();
          if (!rect || rect.width <= 0 || rect.height <= 0 || rect.bottom <= viewportTop || rect.top >= viewportBottom) return;
          if (fieldRect && (rect.right <= fieldRect.left || rect.left >= fieldRect.right)) return;
          boundary = Math.min(boundary, rect.top);
        });
      } catch {}
      return boundary;
    };
    const scrollFieldIfObscured = (field, visualHeight, offsetTop) => {
      if (!field?.isConnected || !field?.getBoundingClientRect) return;
      try {
        const rect = field.getBoundingClientRect();
        const visibleTop = Math.max(0, offsetTop) + 8;
        const visibleBottom = Math.max(visibleTop, fixedBottomBarTop(field, visualHeight, offsetTop) - 16);
        if (rect.top >= visibleTop && rect.bottom <= visibleBottom) return;
        const delta = rect.bottom > visibleBottom ? rect.bottom - visibleBottom : rect.top - visibleTop;
        if (Math.abs(delta) >= 1 && window.scrollBy) {
          window.scrollBy({ top: Math.round(delta), left: 0, behavior: "auto" });
          return;
        }
        field.scrollIntoView?.({ block: "nearest", inline: "nearest", behavior: "auto" });
      } catch {}
    };
    const queueFieldReveal = (field, visualHeight, offsetTop) => {
      if (!field) return;
      if (revealFrame) window.cancelAnimationFrame?.(revealFrame);
      if (revealRetryTimer) window.clearTimeout?.(revealRetryTimer);
      const reveal = () => {
        if (!lastKeyboardOpen || activeField() !== field) return;
        scrollFieldIfObscured(field, visualHeight, offsetTop);
      };
      // A viewport resize can arrive before the fixed checkout bar reaches its
      // final geometry. Reveal now, then once after two frames and once more
      // after the short animation tail; all retries are bounded and cancelable.
      scrollFieldIfObscured(field, visualHeight, offsetTop);
      revealFrame = requestAnimationFrame(() => {
        revealFrame = requestAnimationFrame(() => {
          revealFrame = 0;
          reveal();
        });
      });
      revealRetryTimer = window.setTimeout?.(() => {
        revealRetryTimer = 0;
        reveal();
      }, 180) || 0;
    };

    const run = () => {
      scheduled = false;
      const visualHeight = Math.round(vv?.height || window.innerHeight || root?.clientHeight || 0);
      const visualWidth = Math.round(vv?.width || window.innerWidth || root?.clientWidth || 0);
      // pageTop is a useful fallback in WKWebView versions where offsetTop can lag
      // during the keyboard animation. On normal browsers both expressions agree.
      const pageOffsetTop = Math.max(0, Math.round((vv?.pageTop || 0) - (window.scrollY || 0)));
      const offsetTop = Math.max(Math.round(vv?.offsetTop || 0), pageOffsetTop);
      const offsetLeft = Math.round(vv?.offsetLeft || 0);
      const layoutHeight = Math.round(window.innerHeight || root?.clientHeight || visualHeight);
      const field = activeField();

      if (!field && visualHeight > baselineHeight * 0.92) baselineHeight = Math.max(baselineHeight, visualHeight, layoutHeight);
      const referenceHeight = Math.max(layoutHeight, baselineHeight, visualHeight);
      const keyboardHeight = field ? Math.max(0, referenceHeight - visualHeight - Math.max(0, offsetTop)) : 0;
      const keyboardOpen = !!field && keyboardHeight >= 100 && visualHeight < referenceHeight * 0.88;

      if (!keyboardOpen) {
        if (revealFrame) window.cancelAnimationFrame?.(revealFrame);
        if (revealRetryTimer) window.clearTimeout?.(revealRetryTimer);
        revealFrame = 0;
        revealRetryTimer = 0;
      }

      try {
        setRootCss("--centauro-visual-viewport-height", `${visualHeight}px`);
        setRootCss("--centauro-visual-viewport-width", `${visualWidth}px`);
        setRootCss("--centauro-viewport-offset-top", `${offsetTop}px`);
        setRootCss("--centauro-viewport-offset-left", `${offsetLeft}px`);
        setRootCss("--centauro-keyboard-height", `${keyboardOpen ? keyboardHeight : 0}px`);
        if (keyboardOpen !== root?.hasAttribute?.("data-centauro-keyboard-open")) {
          root?.toggleAttribute?.("data-centauro-keyboard-open", keyboardOpen);
        }
      } catch {}

      // VisualViewport can emit many resize/scroll events while an IME animates.
      // A geometry read + scrollIntoView on every event creates avoidable layout
      // work. Reveal only when keyboard state/field changes or height moves enough.
      const revealNeeded = keyboardOpen && (
        !lastKeyboardOpen || field !== lastField || Math.abs(visualHeight - lastRevealHeight) >= 48
      );
      if (revealNeeded) {
        lastRevealHeight = visualHeight;
        queueFieldReveal(field, visualHeight, offsetTop);
      }
      if (keyboardOpen !== lastKeyboardOpen) {
        lastKeyboardOpen = keyboardOpen;
        try {
          window.dispatchEvent(new CustomEvent("centauro:keyboard", { detail: { open: keyboardOpen, height: keyboardOpen ? keyboardHeight : 0 } }));
        } catch {}
      }
      lastField = field;
    };

    const sync = () => {
      if (scheduled) return;
      scheduled = true;
      (window.requestAnimationFrame || ((callback) => setTimeout(callback, 0)))(run);
    };

    vv?.addEventListener?.("resize", sync, { passive: true });
    vv?.addEventListener?.("scroll", sync, { passive: true });
    window.addEventListener("resize", sync, { passive: true });
    window.addEventListener("orientationchange", sync, { passive: true });
    window.addEventListener("pageshow", sync, { passive: true });
    document.addEventListener("visibilitychange", () => { if (!document.hidden) sync(); }, { passive: true });
    document.addEventListener("focusin", sync, { passive: true });
    document.addEventListener("focusout", () => setTimeout(sync, 0), { passive: true });
    sync();

    return { sync };
  })();


  try {
    const style = document.createElement("style");
    style.id = "centauro-webview-compat-style";
    style.textContent = ":root[data-centauro-keyboard-open]{scroll-padding-bottom:var(--centauro-keyboard-height,0px)}" +
      ":root[data-centauro-keyboard-open] input,:root[data-centauro-keyboard-open] textarea,:root[data-centauro-keyboard-open] select{scroll-margin-bottom:24px}";
    (document.head || root)?.appendChild?.(style);
  } catch {}

  const api = Object.freeze({
    version: "1.1.0",
    capabilities,
    nativeBridge,
    clipboard: Object.freeze({ copyText }),
    share,
    viewport
  });

  window.CentauroWebview = api;
  window.__centauroNativeResolve = (id, result, error) => nativeBridge.resolve(id, result, error);
})();
