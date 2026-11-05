# PLP incremental windowing

`plp-windowing.js` is an inert ES module. A single future integrator should
call `createPlpWindowingController({ container, cards })` after rendering the
cards. The controller keeps the complete card list in order, mounts a small
initial batch, and loads subsequent batches through a controller-owned
`IntersectionObserver`; browsers without that API get a controller-owned
fallback button.

```js
import { createPlpWindowingController } from './plp-windowing.js';

const plp = createPlpWindowingController({
  container: document.querySelector('[data-product-grid]'),
  cards: productCards,
  initialBatchSize: 12,
  batchSize: 24,
});

plp.reset(filteredCards); // new search/filter
plp.destroy();
```

No global observer, polling loop, timer, payload mutation, storage access, or
automatic DOM integration is performed.
