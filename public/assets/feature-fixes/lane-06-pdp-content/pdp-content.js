"use strict";

/*
 * MD-06: PDP recommendations and sharing.
 * This file is intentionally inert. The single future integrator should call
 * createPdpContentController() and own the lifecycle of the returned API.
 */

const cents = (value) => {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? Math.round(value) : null;
  const text = String(value).trim().replace(/R\$\s*/gi, "").replace(/\s/g, "");
  if (!text) return null;
  const normalized = text.includes(",")
    ? text.replace(/\./g, "").replace(",", ".")
    : text;
  const number = Number(normalized);
  if (!Number.isFinite(number)) return null;
  return /[.,]/.test(text) ? Math.round(number * 100) : Math.round(number);
};

const firstValue = (product, keys) => keys.map((key) => product?.[key]).find((value) => value !== undefined && value !== null && value !== "");

function getProductId(product) {
  const value = firstValue(product, ["id", "productId", "internalId", "sku", "code"]);
  return value === undefined ? "" : String(value);
}

function getProductPricing(product) {
  const price = cents(firstValue(product, ["priceInCents", "salePriceInCents", "currentPriceInCents", "price", "salePrice", "currentPrice"]));
  const oldPrice = cents(firstValue(product, ["oldPriceInCents", "listPriceInCents", "originalPriceInCents", "oldPrice", "listPrice", "originalPrice"]));
  const validOldPrice = oldPrice !== null && price !== null && oldPrice > price ? oldPrice : null;
  const discount = validOldPrice === null ? 0 : Math.round((1 - price / validOldPrice) * 100);
  const explicitInstallments = firstValue(product, ["installmentCount", "installments", "maxInstallments", "parcelas"]);
  const count = Number(explicitInstallments);
  const parcelamento = price !== null && Number.isInteger(count) && count > 0
    ? { count, amountInCents: Math.round(price / count) }
    : null;
  return { oldPriceInCents: validOldPrice, priceInCents: price, discount, parcelamento };
}

function normalizeProduct(product) {
  if (!product || typeof product !== "object") return null;
  const pricing = getProductPricing(product);
  return {
    ...product,
    id: getProductId(product),
    name: String(firstValue(product, ["name", "title"]) || "Produto"),
    image: String(firstValue(product, ["image", "imageUrl", "thumbnail", "urlImage"]) || ""),
    url: String(firstValue(product, ["url", "href", "path"]) || ""),
    ...pricing,
    isBestSeller: product.isBestSeller === true || product.bestSeller === true,
  };
}

function selectRecommendations(products, currentProduct) {
  const currentId = getProductId(currentProduct);
  const seen = new Set();
  return (Array.isArray(products) ? products : [])
    .map(normalizeProduct)
    .filter(Boolean)
    .filter((product) => {
      if (!product.id || product.id === currentId || seen.has(product.id)) return false;
      seen.add(product.id);
      return true;
    });
}

function currentShareData(product, win, doc) {
  const fallback = win?.location?.href || doc?.URL || "";
  const domName = doc?.querySelector?.(".matrix-original-product-title, [data-product-title], h1")?.textContent?.trim();
  return {
    name: String(firstValue(product, ["name", "title"]) || domName || "Produto"),
    url: String(firstValue(product, ["url", "href"]) || fallback),
  };
}

function createPdpContentController(options = {}) {
  const win = options.window || (typeof window !== "undefined" ? window : null);
  const doc = options.document || win?.document || (typeof document !== "undefined" ? document : null);
  const navigate = options.navigate || ((url) => win?.history?.pushState?.({}, "", url));
  const fallbackWebView = options.webViewFallback || ((message) => win?.ReactNativeWebView?.postMessage?.(JSON.stringify(message)));
  let mounted = null;
  let activeKey = "";

  const clear = () => {
    mounted?.remove?.();
    mounted = null;
    activeKey = "";
  };

  const render = (container, product, products = []) => {
    if (!container || !doc) return null;
    const normalized = normalizeProduct(product) || { id: "", name: "Produto", url: "", image: "", priceInCents: null, oldPriceInCents: null, discount: 0, parcelamento: null, isBestSeller: false };
    const key = `${normalized.id}|${currentShareData(normalized, win, doc).url}`;
    if (activeKey === key && mounted?.isConnected) return mounted;
    if (activeKey !== key) clear();
    activeKey = key;
    const recommendations = selectRecommendations(products, normalized);
    const section = doc.createElement("section");
    section.className = "lane-06-pdp-content matrix-product-recommendations";
    section.setAttribute("data-lane-06-key", key);
    section.innerHTML = `<h2>Recomendados para você</h2><div class="lane-06-recommendation-rail" role="list"></div>`;
    const rail = section.querySelector(".lane-06-recommendation-rail");
    recommendations.forEach((item) => {
      const card = doc.createElement("button");
      card.type = "button";
      card.className = "lane-06-recommendation-card";
      card.dataset.productId = item.id;
      card.setAttribute("role", "listitem");
      card.innerHTML = `${item.discount > 0 ? `<span class="lane-06-discount">-${item.discount}%</span>` : ""}${item.isBestSeller ? '<span class="lane-06-best-seller">Mais vendido</span>' : ""}<img src="${item.image}" alt=""><strong></strong>${item.oldPriceInCents !== null ? `<s></s>` : ""}<b></b><small></small>`;
      card.querySelector("img").alt = item.name;
      card.querySelector("strong").textContent = item.name;
      if (item.oldPriceInCents !== null) card.querySelector("s").textContent = formatMoney(item.oldPriceInCents, win);
      card.querySelector("b").textContent = item.priceInCents === null ? "" : `${formatMoney(item.priceInCents, win)} no Pix`;
      card.querySelector("small").textContent = item.parcelamento ? `ou ${item.parcelamento.count}x de ${formatMoney(item.parcelamento.amountInCents, win)}` : "";
      card.addEventListener("click", () => navigate(item.url || `/produto/${encodeURIComponent(item.id)}`));
      rail.appendChild(card);
    });
    container.appendChild(section);
    mounted = section;
    return section;
  };

  const share = (product) => {
    const data = currentShareData(product, win, doc);
    return {
      ...data,
      whatsappUrl: `https://wa.me/?text=${encodeURIComponent(`E aí! Olha o produto ${data.name}: ${data.url}`)}`,
      whatsapp: () => {
        try {
          const opened = win?.open?.(`https://wa.me/?text=${encodeURIComponent(`E aí! Olha o produto ${data.name}: ${data.url}`)}`, "_blank", "noopener,noreferrer");
          if (opened) return true;
        } catch {}
        fallbackWebView({ type: "share-whatsapp", name: data.name, url: data.url });
        return false;
      },
      copy: async () => {
        try {
          if (win?.navigator?.clipboard?.writeText) await win.navigator.clipboard.writeText(data.url);
          else throw new Error("clipboard unavailable");
          return true;
        } catch {
          const textarea = doc?.createElement?.("textarea");
          if (textarea && doc.body) {
            textarea.value = data.url; doc.body.appendChild(textarea); textarea.select();
            const copied = Boolean(doc.execCommand?.("copy")); textarea.remove(); if (copied) return true;
          }
          fallbackWebView({ type: "copy-link", name: data.name, url: data.url });
          return false;
        }
      },
    };
  };

  return Object.freeze({ clear, render, mount: render, share, getShareData: (product) => currentShareData(product, win, doc), selectRecommendations, getProductPricing });
}

function formatMoney(value, win) {
  const IntlCtor = win?.Intl || Intl;
  return new IntlCtor.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(Number(value || 0) / 100);
}

const api = { cents, getProductId, getProductPricing, normalizeProduct, selectRecommendations, currentShareData, createPdpContentController };
if (typeof module !== "undefined" && module.exports) module.exports = api;
if (typeof globalThis !== "undefined") globalThis.PdpContentLane06 = api;
