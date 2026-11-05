const INSTANCE_KEY = Symbol("centauro-plp-filters");

const FACET_DEFS = [
  { key: "brand", label: "Marca", fields: ["brand", "marca"] },
  { key: "category", label: "Categoria", fields: ["category", "categoria", "categories", "categorias"] },
  { key: "size", label: "Tamanho", fields: ["size", "tamanho", "sizes", "tamanhos"] },
  { key: "promotion", label: "Promoção", fields: ["promotion", "promocao"] },
];

const asArray = (value) => Array.isArray(value) ? value : value == null || value === "" ? [] : [value];
const text = (value) => String(value ?? "").trim();
const keyOf = (value) => text(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

function numberOf(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value == null || value === "") return null;
  const normalized = String(value)
    .replace(/[^0-9,.-]/g, "")
    .replace(/\.(?=.*\.)/g, "")
    .replace(",", ".");
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

function pick(product, fields) {
  for (const field of fields) {
    const value = product?.[field];
    if (value != null && value !== "") return value;
  }
  return undefined;
}

function normalizeCatalog(catalog) {
  const source = Array.isArray(catalog) ? catalog : catalog?.products || catalog?.items || catalog?.catalog || [];
  return source.map((product, index) => {
    const facets = Object.create(null);
    const facetKeys = Object.create(null);
    FACET_DEFS.forEach((definition) => {
      const values = uniqueValues(
        definition.fields.flatMap((field) => asArray(product?.[field])).map(text).filter(Boolean)
      );
      facets[definition.key] = values;
      facetKeys[definition.key] = values.map(keyOf);
    });
    return {
      product,
      index,
      price: numberOf(pick(product, ["price", "preco", "salePrice", "currentPrice", "valor"])),
      facets,
      facetKeys,
    };
  });
}

function uniqueValues(values) {
  const seen = new Set();
  return values.filter((value) => {
    const key = keyOf(value);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function facetValues(entry, definition) {
  return entry.facets?.[definition.key] || [];
}

function facetValueKeys(entry, definition) {
  return entry.facetKeys?.[definition.key] || facetValues(entry, definition).map(keyOf);
}

function emptyFilters() {
  return { brand: [], size: [], category: [], promotion: [], price: { min: null, max: null } };
}

function copyFilters(filters) {
  return {
    brand: [...(filters.brand || [])],
    size: [...(filters.size || [])],
    category: [...(filters.category || [])],
    promotion: [...(filters.promotion || [])],
    price: { ...(filters.price || {}) },
  };
}

function normaliseFilters(next = {}, facetOptions = {}) {
  const filters = emptyFilters();
  FACET_DEFS.forEach(({ key }) => {
    filters[key] = uniqueValues(asArray(next[key]).map(text).filter(Boolean));
  });
  const min = numberOf(next.price?.min);
  const max = numberOf(next.price?.max);
  filters.price = {
    min: min == null ? null : Math.max(0, min),
    max: max == null ? null : Math.max(0, max),
  };
  filters.__facetOptions = facetOptions;
  filters.__keys = Object.fromEntries(FACET_DEFS.map(({ key }) => [key, filters[key].map(keyOf)]));
  return filters;
}

function sameValue(a, b) {
  return keyOf(a) === keyOf(b);
}

function matches(entry, filters, without) {
  for (const definition of FACET_DEFS) {
    if (definition.key === without) continue;
    const selected = filters[definition.key];
    const selectedKeys = filters.__keys?.[definition.key] || selected.map(keyOf);
    if (
      selectedKeys.length &&
      !facetValueKeys(entry, definition).some((valueKey) => selectedKeys.includes(valueKey))
    ) return false;
  }

  const { min, max } = filters.price;
  if (without !== "price" && min != null && (entry.price == null || entry.price < min)) return false;
  if (without !== "price" && max != null && (entry.price == null || entry.price > max)) return false;
  return true;
}

function facetModel(entries, filters) {
  return FACET_DEFS.map((definition) => {
    const counts = new Map();
    entries.filter((entry) => matches(entry, filters, definition.key)).forEach((entry) => {
      facetValues(entry, definition).forEach((value) => {
        const normalized = keyOf(value);
        const current = counts.get(normalized);
        if (current) current.count += 1;
        else counts.set(normalized, { value, count: 1 });
      });
    });

    const configured = Array.isArray(filters.__facetOptions?.[definition.key])
      ? filters.__facetOptions[definition.key]
      : [];
    configured.forEach((value) => {
      const normalized = keyOf(value);
      if (!counts.has(normalized)) counts.set(normalized, { value: text(value), count: 0 });
    });

    const selected = filters[definition.key] || [];
    selected.forEach((value) => {
      const normalized = keyOf(value);
      if (!counts.has(normalized)) counts.set(normalized, { value: text(value), count: 0 });
    });

    return {
      key: definition.key,
      label: definition.label,
      options: [...counts.values()].sort((a, b) => a.value.localeCompare(b.value, "pt-BR")),
    };
  });
}

function rootElement(root) {
  if (typeof root === "string") return document.querySelector(root);
  return root || document.createElement("div");
}

function emit(callbacks, name, payload) {
  const callback = callbacks[name];
  if (typeof callback === "function") callback(payload);
}

function emitAliases(callbacks, names, ...args) {
  const called = new Set();
  names.forEach((name) => {
    const callback = callbacks[name];
    if (typeof callback === "function" && !called.has(callback)) {
      called.add(callback);
      callback(...args);
    }
  });
}

function serializeQuery(filters) {
  const params = new URLSearchParams();
  for (const definition of FACET_DEFS) {
    filters[definition.key].forEach((value) => params.append(definition.key, value));
  }
  if (filters.price.min != null) params.set("minPrice", String(filters.price.min));
  if (filters.price.max != null) params.set("maxPrice", String(filters.price.max));
  return params.toString();
}

function selectedCount(filters) {
  const facetCount = FACET_DEFS.reduce((total, { key }) => total + (filters[key]?.length || 0), 0);
  return facetCount + (filters.price?.min != null || filters.price?.max != null ? 1 : 0);
}

function invalidPriceRange(filters) {
  const { min, max } = filters.price || {};
  return min != null && max != null && min > max;
}

export function install(input = {}, legacyOptions = {}) {
  const options = Array.isArray(input) ? { ...legacyOptions, catalog: input } : input;
  const root = rootElement(options.root || options.el);
  if (!root || typeof root.appendChild !== "function") {
    throw new TypeError("plp-filters: root é obrigatório");
  }
  if (root[INSTANCE_KEY]) return root[INSTANCE_KEY].api;

  let entries = normalizeCatalog(options.catalog);
  const facetOptions = options.facetOptions || {};
  let applied = normaliseFilters(options.initialFilters, facetOptions);
  let draft = normaliseFilters(applied, facetOptions);
  const expanded = new Set(
    FACET_DEFS.filter(({ key }) => applied[key]?.length).map(({ key }) => key)
  );
  const callbacks = options.callbacks || options;
  const doc = root.ownerDocument || document;
  const panel = doc.createElement("section");
  panel.className = "plp-filters";
  panel.setAttribute("aria-label", "Filtros dos produtos");
  root.appendChild(panel);

  function payload() {
    const filters = copyFilters(applied);
    filters.__facetOptions = facetOptions;
    const products = entries.filter((entry) => matches(entry, applied)).map((entry) => entry.product);
    return {
      filters,
      products,
      query: serializeQuery(filters),
      facets: facetModel(entries, applied),
      activeCount: selectedCount(filters),
    };
  }

  function notify() {
    const result = payload();
    emitAliases(callbacks, ["onApply", "onChange", "onFiltersChange"], result);
    emitAliases(callbacks, ["updateList", "onProductsChange"], result.products, result);
    emitAliases(callbacks, ["updateQuery", "onQueryChange"], result.query, result);
    return result;
  }

  function toggleSelection(key, value, checked) {
    const list = draft[key];
    const index = list.findIndex((item) => sameValue(item, value));
    if (checked && index === -1) list.push(value);
    if (!checked && index !== -1) list.splice(index, 1);
    draft.__keys[key] = list.map(keyOf);
    render();
    [...panel.querySelectorAll(`input[data-filter-key="${key}"]`)]
      .find((input) => input.dataset.filterValue === keyOf(value))
      ?.focus({ preventScroll: true });
  }

  function render() {
    const models = facetModel(entries, draft).filter((model) => model.options.length > 0);
    panel.replaceChildren();

    const heading = doc.createElement("div");
    heading.className = "plp-filters__top";
    const title = doc.createElement("h2");
    title.className = "plp-filters__title";
    title.textContent = "Filtrar por";
    const draftCount = selectedCount(draft);
    const count = doc.createElement("span");
    count.className = "plp-filters__active-count";
    count.hidden = draftCount === 0;
    count.textContent = String(draftCount);
    count.setAttribute("aria-label", `${draftCount} ${draftCount === 1 ? "filtro selecionado" : "filtros selecionados"}`);
    heading.append(title, count);
    panel.appendChild(heading);

    models.forEach((model) => {
      const facet = doc.createElement("section");
      facet.className = "plp-filters__facet";
      const bodyId = `plp-filter-${model.key}`;
      const isExpanded = expanded.has(model.key);

      const button = doc.createElement("button");
      button.type = "button";
      button.className = "plp-filters__heading";
      button.setAttribute("aria-expanded", String(isExpanded));
      button.setAttribute("aria-controls", bodyId);
      const activeInFacet = draft[model.key]?.length || 0;
      button.innerHTML = `
        <span>${model.label}${activeInFacet ? ` <small>(${activeInFacet})</small>` : ""}</span>
        <svg class="plp-filters__chevron" width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
          <path d="m6.25 8 3.75 3.75L13.75 8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      `;
      button.addEventListener("click", () => {
        if (isExpanded) expanded.delete(model.key);
        else expanded.add(model.key);
        render();
        panel.querySelector(`[aria-controls="${bodyId}"]`)?.focus({ preventScroll: true });
      });
      facet.appendChild(button);

      const body = doc.createElement("div");
      body.className = "plp-filters__options";
      body.hidden = !isExpanded;
      body.id = bodyId;
      model.options.forEach(({ value, count: optionCount }) => {
        const checked = draft[model.key].some((item) => sameValue(item, value));
        const label = doc.createElement("label");
        label.className = "plp-filters__option";
        const checkbox = doc.createElement("input");
        checkbox.type = "checkbox";
        checkbox.value = value;
        checkbox.dataset.filterKey = model.key;
        checkbox.dataset.filterValue = keyOf(value);
        checkbox.checked = checked;
        checkbox.disabled = optionCount === 0 && !checked;
        label.classList.toggle("is-disabled", checkbox.disabled);
        checkbox.addEventListener("change", () => toggleSelection(model.key, value, checkbox.checked));
        const copy = doc.createElement("span");
        copy.textContent = value;
        const optionCountNode = doc.createElement("span");
        optionCountNode.className = "plp-filters__count";
        optionCountNode.textContent = String(optionCount);
        optionCountNode.setAttribute("aria-label", `${optionCount} produtos`);
        label.append(checkbox, copy, optionCountNode);
        body.appendChild(label);
      });
      facet.appendChild(body);
      panel.appendChild(facet);
    });

    const price = doc.createElement("section");
    price.className = "plp-filters__price";
    const priceTitle = doc.createElement("h3");
    priceTitle.className = "plp-filters__heading-label";
    priceTitle.textContent = "Faixa de preço";
    const fields = doc.createElement("div");
    fields.className = "plp-filters__price-fields";

    const createPriceField = (kind, labelText, value) => {
      const label = doc.createElement("label");
      label.className = "plp-filters__price-field";
      const caption = doc.createElement("span");
      caption.textContent = labelText;
      const wrapper = doc.createElement("span");
      wrapper.className = "plp-filters__price-input";
      const currency = doc.createElement("span");
      currency.textContent = "R$";
      currency.setAttribute("aria-hidden", "true");
      const input = doc.createElement("input");
      input.type = "number";
      input.inputMode = "decimal";
      input.min = "0";
      input.step = "0.01";
      input.placeholder = "0,00";
      input.setAttribute("aria-label", `Preço ${labelText.toLowerCase()}`);
      input.value = value ?? "";
      input.dataset.priceKind = kind;
      wrapper.append(currency, input);
      label.append(caption, wrapper);
      return { label, input };
    };

    const minField = createPriceField("min", "Mínimo", draft.price.min);
    const maxField = createPriceField("max", "Máximo", draft.price.max);
    fields.append(minField.label, maxField.label);
    const priceError = doc.createElement("p");
    priceError.className = "plp-filters__price-error";
    priceError.setAttribute("role", "alert");
    priceError.hidden = true;
    price.append(priceTitle, fields, priceError);
    panel.appendChild(price);

    const actions = doc.createElement("div");
    actions.className = "plp-filters__actions";
    const clear = doc.createElement("button");
    clear.type = "button";
    clear.className = "plp-filters__clear";
    clear.textContent = "Limpar";
    clear.disabled = draftCount === 0 && selectedCount(applied) === 0;
    clear.addEventListener("click", () => {
      applied = normaliseFilters({}, facetOptions);
      draft = normaliseFilters({}, facetOptions);
      expanded.clear();
      render();
      const result = notify();
      emit(callbacks, "onCommit", { ...result, origin: "clear" });
    });
    const apply = doc.createElement("button");
    apply.type = "button";
    apply.className = "plp-filters__apply";
    apply.textContent = "Ver produtos";
    actions.append(clear, apply);
    panel.appendChild(actions);

    const syncPriceValidation = () => {
      const minValue = numberOf(minField.input.value);
      const maxValue = numberOf(maxField.input.value);
      draft.price.min = minValue == null ? null : Math.max(0, minValue);
      draft.price.max = maxValue == null ? null : Math.max(0, maxValue);
      const invalid = invalidPriceRange(draft);
      const currentCount = selectedCount(draft);
      price.classList.toggle("has-error", invalid);
      priceError.hidden = !invalid;
      priceError.textContent = invalid ? "O valor mínimo não pode ser maior que o máximo." : "";
      apply.disabled = invalid;
      clear.disabled = currentCount === 0 && selectedCount(applied) === 0;
      count.hidden = currentCount === 0;
      count.textContent = currentCount ? String(currentCount) : "";
      count.setAttribute(
        "aria-label",
        `${currentCount} ${currentCount === 1 ? "filtro selecionado" : "filtros selecionados"}`
      );
      minField.input.setAttribute("aria-invalid", String(invalid));
      maxField.input.setAttribute("aria-invalid", String(invalid));
    };
    minField.input.addEventListener("input", syncPriceValidation);
    maxField.input.addEventListener("input", syncPriceValidation);
    apply.addEventListener("click", () => {
      syncPriceValidation();
      if (invalidPriceRange(draft)) {
        priceError.hidden = false;
        minField.input.focus();
        return;
      }
      applied = normaliseFilters(draft, facetOptions);
      draft = normaliseFilters(applied, facetOptions);
      const result = notify();
      emit(callbacks, "onCommit", { ...result, origin: "apply" });
    });
  }

  render();

  const api = {
    getState: () => payload(),
    getDraft: () => copyFilters(draft),
    setFilters(next = {}, shouldApply = false) {
      draft = normaliseFilters(next, facetOptions);
      if (shouldApply) applied = normaliseFilters(draft, facetOptions);
      render();
      if (shouldApply) notify();
      return api;
    },
    updateCatalog(catalog, updateOptions = {}) {
      const { preserveFilters = true, shouldApply = false } = updateOptions;
      entries = normalizeCatalog(catalog);
      if (!preserveFilters) {
        applied = normaliseFilters({}, facetOptions);
        draft = normaliseFilters({}, facetOptions);
        expanded.clear();
      } else {
        applied = normaliseFilters(applied, facetOptions);
        draft = normaliseFilters(draft, facetOptions);
      }
      render();
      if (shouldApply) notify();
      return api;
    },
    cancel() {
      draft = normaliseFilters(applied, facetOptions);
      render();
      return api;
    },
    clear(shouldApply = true) {
      draft = normaliseFilters({}, facetOptions);
      if (shouldApply) applied = normaliseFilters({}, facetOptions);
      expanded.clear();
      render();
      if (shouldApply) notify();
      return api;
    },
    destroy() {
      panel.remove();
      delete root[INSTANCE_KEY];
    },
  };

  root[INSTANCE_KEY] = { api };
  return api;
}

export default install;

if (typeof window !== "undefined") window.__centauroPlpFiltersInstall = install;
