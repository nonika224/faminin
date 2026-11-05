# Reviews JSON v1

Infraestrutura frontend versionada para avaliações por `productId`. A versão 1 é deliberadamente agnóstica ao backend: os arquivos são assets JSON públicos e o carregador não usa Supabase, não cria conteúdo e não altera DOM.

## Arquivos

- `manifest.v1.json`: índice público. `catalogSize` é 895; `products` começa vazio em produção.
- `schema.v1.json`: contrato JSON Schema Draft 2020-12 para cada payload de produto.
- `manifest.schema.v1.json`: contrato estrutural para os resumos agregados do manifest.
- `loader.v1.js`: módulo lazy/cacheável. Exporta `createReviewsLoader`, sem efeitos colaterais.
- `products/<productId>.json`: formato de produção para um produto, quando houver dados reais.
- `demo/manifest.v1.json` e `demo/products/`: conjunto `synthetic-demo` para o mockup local, com proveniência explícita e uso em produção proibido.

Esta revisão do SPA é uma implantação exclusivamente demonstrativa, sem tráfego de clientes, e seleciona `demo/manifest.v1.json` tanto localmente quanto na hospedagem de demonstração da Vercel. A origem permanece marcada internamente como `synthetic-demo`; não existe aviso visual adicional. Antes de liberar tráfego real, substituir essa constante pela futura origem real/Supabase. Nenhum dado demonstrativo é mesclado ao diretório `products/` reservado para avaliações reais.

As contagens e distribuições agregadas do manifest demonstrativo são materializadas de forma determinística a partir de `productId`, com semente versionada e sem fonte aleatória em runtime. Produtos avaliados ficam entre 80 e 289 avaliações; variantes Corre 4/5 ficam entre 240 e 289; uma parcela estável dos demais produtos permanece vazia com `reviewCount: 0` e `rating: null`. Cada produto avaliado contém as cinco faixas positivas de estrelas; 4★ e 5★ são as duas maiores faixas, e os bins baixos permanecem minoritários e variáveis. Esses totais agregados são independentes da pequena amostra em `demo/products/` e não criam nem duplicam comentários.

## Contrato por produto

```json
{
  "schemaVersion": "reviews.v1",
  "productId": "produto-123",
  "reviews": [
    {
      "sourceReviewId": "origem-abc",
      "rating": 5,
      "title": "Título opcional",
      "body": "Texto da avaliação",
      "author": "Nome opcional",
      "createdAt": "2026-01-15T12:00:00Z",
      "verifiedPurchase": true,
      "photos": ["https://cdn.example.test/review/photo.jpg"]
    }
  ]
}
```

`sourceReviewId` é a chave preferencial de deduplicação. Quando ausente, o loader usa um hash determinístico dos campos normalizados da avaliação. `photos` contém somente URLs públicas; o carregador nunca faz download, proxy ou validação dessas imagens.

Um produto ausente do manifest, ou com `reviewCount: 0`, é um estado válido `empty`. O manifest pode apontar para qualquer URL pública relativa à raiz do manifest com `path`; o loader não presume que todos os 895 produtos tenham payload. Um payload com `reviews: []` continua podendo representar um produto com resumo agregado quando `reviewCount` for maior que zero.

Para que cards e PDP usem a mesma origem sem baixar centenas de arquivos de comentários na listagem, cada entrada materializada no manifest inclui o resumo agregado autoritativo:

```json
{
  "products": {
    "28": {
      "path": "./products/28.json",
      "rating": 4.5,
      "reviewCount": 266,
      "distribution": {
        "1": 4,
        "2": 4,
        "3": 7,
        "4": 91,
        "5": 160
      }
    }
  }
}
```

`rating` é a média ponderada exata de `distribution` (`Σ estrelas × contagem / reviewCount`) e `reviewCount` é a soma dos cinco bins. O frontend formata a mesma média com uma casa decimal em cards e PDP. O loader rejeita bins fora das chaves `"1"`…`"5"`, contagens não inteiras, bins não positivos em produtos avaliados, soma divergente ou média divergente. Esses campos do manifest são a fonte única para cards e PDP, mesmo quando o payload contém apenas uma amostra menor de comentários. O array `reviews` continua deduplicado e paginável, mas não sobrescreve o resumo do manifest; em entradas legadas sem `distribution`, o loader calcula uma distribuição determinística compatível. Produtos confirmados sem avaliações usam `rating: null`, `reviewCount: 0` e distribuição ausente (ou cinco zeros em integrações que a enviarem). Os campos antigos de nota/contagem do catálogo de produtos não são fonte de avaliações.

## API mínima

```js
const reviews = createReviewsLoader({
  manifestUrl: '/assets/reviews/manifest.v1.json',
  fetchImpl: fetch,
  pageSize: 8,
  onState: (snapshot) => console.log(snapshot.state),
});

await reviews.load('produto-123');
await reviews.loadSummaries(); // resumo leve para cards/listagens
reviews.getSummary('produto-123');
reviews.getPage('produto-123', 1); // pageSize 8 por padrão
reviews.clear('produto-123');
reviews.clearAll();
```

Estados observáveis: `idle`, `loading`, `ready`, `empty`, `error`. A troca de produto limpa o resultado visível anterior antes do novo carregamento. A cache é por produto e por manifest; `clear` remove apenas um produto e `clearAll` invalida tudo.

## Validação

O fixture e o validador de contrato ficam fora de `assets/reviews`, em `.codex-test-logs/reviews/`, e não fazem parte do payload publicado. Execute na raiz do workspace:

```text
node --check buildpixpago139/assets/reviews/loader.v1.js
node --check buildpixpago139/scripts/materialize-review-distributions.mjs
node buildpixpago139/scripts/materialize-review-distributions.mjs --check
node buildpixpago139/scripts/validate-review-distributions.mjs
node --check .codex-test-logs/reviews/validate-reviews.mjs
node .codex-test-logs/reviews/validate-reviews.mjs
node .codex-test-logs/reviews/validate-scrape-ranges.mjs
node .codex-test-logs/reviews/validate-demo-integration.mjs
```
