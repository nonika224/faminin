// ============================================================================
// capa.js — Edge Function da Netlify: a "capa" que fica POR CIMA da route-LP.
//   crawler (UA/ASN)   -> 302 CANÔNICA
//   sem ad param/geo/  -> 302 GENÉRICA
//   automação/perfil falso
//   clique fresco      -> serve a LP + emite TOKEN (cookie + localStorage [+ URL])
//   com token válido   -> serve a LP (cookie OU ?t= OU localStorage via JS)
// A Vercel recebe SÓ o log (endpoint assinado) — nenhuma chave do Supabase aqui.
// Env (Netlify → Site settings → Environment variables):
//   CAPA_CANONICAL_URL, CAPA_GENERIC_URL, CAPA_VERCEL_LOG_URL, CAPA_LOG_SECRET,
//   CAPA_AD_PARAMS, CAPA_TRUST_ASNS, CAPA_PAISES_OK, CAPA_TOKEN_SECRET,
//   CAPA_MODO_LOG, CAPA_TOKEN_TTL_MIN, CAPA_TOKEN_NA_URL
// ============================================================================
import {
  decidir, emitirToken, assinarLog, DESTINO, temAdParam, temParamDono, hashCurtoSeguro,
  TOKEN_INJECTOR_JS, escolherModoInjecao, injetarNonceNaCSP, gerarNonce, montarInjecaoHtml, validarToken, prefixoIP,
  emitirTokenLongo, validarTokenLongo,
  ipEmAlgumCidr, CRAWLER_CIDRS_DEFAULT, inconsistenciaClientHints,
  ehRotaSonda, ehAssetPath, ROTAS_SONDA_DEFAULT, ehRotaScanner,
  CRAWLER_UA_TOKENS, AUTOMATION_UA_PATTERNS, ehLinuxDesktop,
  ehUAContraditorio, ehUAImplausivel,
} from './lib/capa-core.js';

const env = (k, d = '') => {
  try {
    const v = globalThis.Netlify?.env?.get?.(k);
    if (v !== undefined && v !== null && String(v) !== '') return String(v).trim();
  } catch { /* cai no process.env */ }
  return String((globalThis.process?.env?.[k]) ?? d).trim();
};
const csv = (v, d = '') => String(v || d).split(',').map((s) => s.trim()).filter(Boolean);
// (9ª rodada) CLAMP do TTL: env inválida não pode quebrar a sessão.
//   '-5' (ou 0/NaN) gerava token já expirado -> 2ª visita caía na genérica;
//   '1e9' gerava token praticamente eterno. Faixa segura: 1 min .. 24 h.
const clampTtlMin = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 25;         // default do §4
  return Math.min(1440, Math.max(1, Math.floor(n)));
};

// (28ª rodada — SEGURANÇA) Destino de redirect só vale se for URL ABSOLUTA http(s).
// Motivo medido: com `CAPA_GENERIC_URL=//evil.example.com/phish` a capa emitia
// `Location: //evil.example.com/phish` — open redirect dependendo de erro de digitação
// na env. Devolver '' faz o fluxo cair nas checagens de "config_ausente" que já existem.
const alvoSeguro = (v) => {
  const s = String(v || '').trim();
  if (!s) return '';
  try {
    const u = new URL(s);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return '';
    // (Tier A — robustez) devolve SEMPRE a forma NORMALIZADA (`u.href`) e recusa
    // caractere de controle: antes o valor cru ia para o header `Location`
    // (`https:/evil.example` saía literal) e um CR/LF fazia o `new Response`
    // lançar, derrubando o fail-safe (500 de plataforma em vez de 302/503).
    if (/[\u0000-\u001f\u007f]/.test(s)) return '';
    return u.href;
  } catch { return ''; }
};

// ============================================================================
// (TIER A — PEDIDO DO DONO, 20/09/2026) IDENTIDADE DE ROBÔ + REGRA DE ASSET
// ----------------------------------------------------------------------------
// `crawler_ua` (token declarado), `automacao` (headless/puppeteer/curl...) ou
// `linux` (X11/CrOS/aarch64). UA VAZIO fica de fora de propósito: o runtime
// interno pode buscar asset sem UA e isso não é um crawler. Com essa identidade,
// QUALQUER arquivo de `public/` e o injetor respondem 404 vazio (default).
// Rollback sem deploy: CAPA_BOT_ASSET_404=off.
// Medição: 811/2.000 caminhos, 406/1.200 headers, 210 combos de bot e 224 de
// Linux entregavam asset antes; com a regra, 0 — e 2.516/2.516 pessoas seguem
// recebendo os assets normalmente (base real).
// ============================================================================
const identidadeRobo = (ua) => {
  const s = String(ua || '').toLowerCase().trim();
  if (!s) return '';
  if (CRAWLER_UA_TOKENS.some((t) => s.includes(t))) return 'crawler_ua';
  if (AUTOMATION_UA_PATTERNS.some((t) => s.includes(t))) return 'automacao';
  if (ehLinuxDesktop(ua)) return 'linux';
  if (ehUAContraditorio(ua)) return 'ua_contraditoria';
  if (ehUAImplausivel(ua)) return 'ua_implausivel';
  return '';
};
const botAsset404Ligado = () => env('CAPA_BOT_ASSET_404', 'on').toLowerCase() !== 'off';
const killSwitchLigado = () => env('CAPA_KILL_SWITCH', 'off').toLowerCase() === 'on';

// ---------- cache de ASN (in-memory + Blobs opcional) ------------------------
const cacheAsn = new Map();     // ip -> { asn, exp }
const cacheClique = new Map();  // id  -> exp  (fallback sem Blobs)
const ASN_CACHE_MAX = 2000;     // teto duro do cache de ASN por isolate
let blobs = null;
// (Fase 4/E) NENHUMA escrita de Blobs pode segurar o visitante:
//   * teto curto por chamada;
//   * CIRCUIT BREAKER: estourou uma vez, o Blobs fica "de castigo" por 60 s e a
//     capa usa só a memória do isolate (fail-open, §13 do ARQUITETURAOF).
let blobsRuimAte = 0;
const blobsOk = () => Date.now() >= blobsRuimAte;
const degradarBlobs = () => { blobsRuimAte = Date.now() + (Number(env('CAPA_BLOBS_DEGRADE_SEC', '60')) || 60) * 1000; };
const comTeto = async (promessa, ms, fallback) => {
  let expirou = false;
  const p = Promise.resolve(promessa).catch(() => null);
  const t = new Promise((r) => setTimeout(() => { expirou = true; r(fallback); }, ms));
  const valor = await Promise.race([p, t]);
  if (expirou) degradarBlobs();
  return valor;
};
const BLOBS_GET_MS = () => Number(env('CAPA_BLOBS_GET_MS', '250')) || 250;
const BLOBS_SET_MS = () => Number(env('CAPA_BLOBS_SET_MS', '300')) || 300;
async function store() {
  if (blobs !== null) return blobs;
  try {
    const mod = await import('@netlify/blobs');
    blobs = mod.getStore('capa');
  } catch { blobs = false; }
  return blobs;
}

async function asnDoIP(ip) {
  if (!ip) return '';
  const agora = Date.now();
  const hit = cacheAsn.get(ip);
  if (hit && hit.exp > agora) return hit.asn;
  const s = blobsOk() ? await store() : false;
  if (s) {
    try {
      const v = await comTeto(s.get(`asn:${ip}`, { type: 'json' }), BLOBS_GET_MS(), null);
      if (v && v.exp > agora) { cacheAsn.set(ip, v); return v.asn || ''; }
    } catch { /* segue para o DoH */ }
  }
  let asn = '';
  try {
    const nome = ip.includes(':') ? null : `${ip.split('.').reverse().join('.')}.origin.asn.cymru.com`;
    if (nome) {
      const r = await fetch(`https://dns.google/resolve?name=${encodeURIComponent(nome)}&type=TXT`, {
        headers: { accept: 'application/dns-json' },
        // (4ª/5ª rodada) timeout do DoH por env: é o maior peso no pior caso
        signal: AbortSignal.timeout(Number(env('CAPA_ASN_DOH_MS', '1200')) || 1200),
      });
      const j = await r.json();
      const txt = (j.Answer || []).map((a) => String(a.data).replace(/"/g, '')).join(' ');
      const m = txt.match(/(\d{1,10})\s*\|/);
      asn = m ? m[1] : '';
    }
  } catch { /* DNS fora: segue sem ASN (outras regras continuam) */ }
  const reg = { asn, exp: agora + 6 * 3600 * 1000 };
  cacheAsn.set(ip, reg);
  // teto de memória: remove vencidas e, se ainda estiver cheio, as mais antigas
  // (Map preserva a ordem de inserção). O isolate é reciclado, mas 6 h de IPs
  // únicos num flood poderiam inchar.
  if (cacheAsn.size > ASN_CACHE_MAX) {
    for (const [k, v] of cacheAsn) if (v.exp <= agora) cacheAsn.delete(k);
    for (const k of cacheAsn.keys()) {
      if (cacheAsn.size <= ASN_CACHE_MAX) break;
      cacheAsn.delete(k);
    }
  }
  // escrita de CACHE: não espera (só aquece outros isolates)
  if (s) { try { void s.setJSON(`asn:${ip}`, reg)?.catch?.(() => {}); } catch { /* best-effort */ } }
  return asn;
}

// ---------- país por IP (FALLBACK quando a plataforma não manda geo) ----------
// (38ª rodada — pedido do dono) Evitar que um BRASILEIRO sem `context.geo` caia na
// genérica pela regra nova "sem país = genérica". Usa o IP REAL da plataforma
// (`context.ip`), nunca header do cliente. Ordem: memória -> Blobs -> provedores
// (timeout curto por provedor). Se tudo falhar, o país continua desconhecido e vale
// o D2 (genérica) — o fallback é bônus, não abre exceção.
const cachePais = new Map(); // ip -> { pais, fonte, exp }
const PAIS_ISO = /^[A-Z]{2}$/;
const GEO_MS = () => Number(env('CAPA_GEO_MS', '800')) || 800;
const GEO_FALLBACK_ON = () => env('CAPA_GEO_FALLBACK', 'on').toLowerCase() !== 'off';
// IP privado/reservado/CGNAT não tem país resolvível: nem tenta (evita latência à toa)
const ipSemPais = (s) => /^(10\.|127\.|169\.254\.|192\.168\.|100\.(6[4-9]|[7-9]\d|1[0-2]\d)\.|172\.(1[6-9]|2\d|3[01])\.)/.test(s)
  || s === '::1' || /^f[cd]/i.test(s);

async function paisDoIP(ip) {
  const chave = String(ip || '').trim();
  if (!chave || ipSemPais(chave)) return null;
  const agora = Date.now();
  const hit = cachePais.get(chave);
  if (hit && hit.exp > agora) return hit.pais ? { pais: hit.pais, fonte: hit.fonte } : null;
  const s = blobsOk() ? await store() : false;
  if (s) {
    try {
      const v = await comTeto(s.get(`geo:${chave}`, { type: 'json' }), BLOBS_GET_MS(), null);
      if (v && v.exp > agora && v.pais) { cachePais.set(chave, v); return { pais: v.pais, fonte: v.fonte }; }
    } catch { /* segue para os provedores */ }
  }
  const provedores = [
    { nome: 'country.is', url: `https://api.country.is/${encodeURIComponent(chave)}`, campo: 'country' },
    { nome: 'ipwho.is', url: `https://ipwho.is/${encodeURIComponent(chave)}?fields=success,country_code`, campo: 'country_code' },
  ];
  for (const p of provedores) {
    try {
      const r = await fetch(p.url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(GEO_MS()) });
      if (!r || !r.ok) continue;
      const j = await r.json();
      const pais = String(j?.[p.campo] || '').toUpperCase();
      if (!PAIS_ISO.test(pais)) continue;
      const reg = { pais, fonte: p.nome, exp: agora + 6 * 3600 * 1000 };
      cachePais.set(chave, reg);
      if (cachePais.size > 5000) for (const [k, v] of cachePais) if (v.exp <= agora) cachePais.delete(k);
      if (s) { try { void s.setJSON(`geo:${chave}`, reg)?.catch?.(() => {}); } catch { /* best-effort */ } }
      return { pais, fonte: p.nome };
    } catch { /* tenta o próximo provedor */ }
  }
  // cache negativo curto: não martela os provedores quando o IP não resolve
  cachePais.set(chave, { pais: '', fonte: 'falhou', exp: agora + 5 * 60 * 1000 });
  return null;
}

// ---------- nonce do clique (uso único) -------------------------------------
// (ARQUITETURAOF §5, regra 5) RATE-LIMIT por IP — best-effort no isolate
// (mesmo desenho do guard do projeto Vercel: memória do edge, sem estado
// distribuído). Assets NÃO contam. Excedeu -> genérica.
const janelas = new Map();
// (11ª rodada) TETO DE MEMÓRIA DOS MAPAS — e, principalmente, PODA sem zerar tudo:
// medido que `janelas.clear()` ao passar de 5.000 chaves permitia a um BOTNET zerar
// o contador de um IP já bloqueado (bypass). Agora: (1) removem-se só as janelas
// VENCIDAS; (2) se o mapa seguir cheio (todas vivas), paramos de rastrear chaves
// NOVAS — quem já tem contador continua contado (zero falso positivo: um IP novo
// nunca é barrado por causa da multidão, no máximo fica sem contador).
// Limite alto de propósito: ~20 mil chaves é ~2 MB no isolate e o tráfego normal
// (mesmo alto) não chega perto disso dentro de uma janela.
const LIMITE_MAPA = 12000;
const LIMITE_CLIQUE = 4000; // claim local é atalho; o Blobs segue como verdade entre isolates
function podarVencidas(mapa, vencida, agoraMs, limite = LIMITE_MAPA) {
  if (mapa.size <= limite) return;
  for (const [k, v] of mapa) if (vencida(v, agoraMs)) mapa.delete(k);
}
function rateExcedido(ip) {
  const max = Number(env('CAPA_RATE_MAX', '120')) || 0;
  const win = Number(env('CAPA_RATE_WINDOW_SEC', '60')) || 60;
  if (max <= 0) return false;
  const agora = Date.now();
  podarVencidas(janelas, (v, t) => t - v.inicio >= win * 1000, agora);
  let r = janelas.get(ip);
  if (!r) {
    if (janelas.size >= LIMITE_MAPA) return false; // teto de memória: IP novo não é rastreado
    r = { inicio: agora, n: 0 };
  }
  if (agora - r.inicio >= win * 1000) { r.inicio = agora; r.n = 0; }
  r.n++;
  janelas.set(ip, r);
  return r.n > max;
}

async function cliqueJaUsado(fbclid) {
  if (!fbclid) return false;
  const id = `cl:${await hashCurtoSeguro(fbclid, 20)}`;
  const agora = Date.now();
  // (Fase 4/F) USO ÚNICO ATÔMICO: a reivindicação em memória é SÍNCRONA (o isolate
  // é single-thread), então dois requests simultâneos com o mesmo clique não podem
  // passar os dois. Depois tenta persistir no Blobs com onlyIfNew (atômico entre
  // isolates); se o Blobs disser que já existia, o clique é considerado usado.
  const expAtual = cacheClique.get(id);
  if (expAtual && expAtual > agora) return true;
  // (11ª rodada) mesma poda: nunca zerar o mapa (senão um botnet "devolve" cliques
  // já usados). Se o mapa estiver cheio de reivindicações vivas, a local não é
  // gravada — a reivindicação no BLOBS (onlyIfNew, abaixo) segue valendo entre isolates.
  podarVencidas(cacheClique, (v, t) => v <= t, agora, LIMITE_CLIQUE);
  if (cacheClique.size < LIMITE_CLIQUE) cacheClique.set(id, agora + 30 * 60 * 1000); // local (síncrona)
  const s = blobsOk() ? await store() : false;
  if (s) {
    try {
      const r = await comTeto(s.set(id, String(agora), { onlyIfNew: true }), BLOBS_SET_MS(), null);
      if (r && r.modified === false) return true;     // já existia em outro isolate
    } catch { /* Blobs fora: a reivindicação local acima já protege o isolate */ }
  }
  return false;
}

// ---------- log para a Vercel (fire-and-forget) ------------------------------
function enviarLog(context, registro) {
  const url = env('CAPA_VERCEL_LOG_URL');
  const segredo = env('CAPA_LOG_SECRET');
  if (!url || !segredo) return;
  const tarefa = (async () => {
    try {
      const corpo = JSON.stringify(registro);
      const ts = String(Math.floor(Date.now() / 1000));
      const sig = await assinarLog(segredo, ts, corpo);
      await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-capa-ts': ts, 'x-capa-sig': sig },
        body: corpo,
        signal: AbortSignal.timeout(2500),
      });
    } catch { /* log nunca quebra a resposta */ }
  })();
  try {
    if (typeof context?.waitUntil === 'function') context.waitUntil(tarefa);
    else if (typeof globalThis.waitUntil === 'function') globalThis.waitUntil(tarefa);
    else void tarefa; // sem waitUntil o log pode ser cortado — best-effort
  } catch { void tarefa; }
}

// ---------- handler ----------------------------------------------------------
// (5ª/7ª rodada) GUARDA GLOBAL: nenhum erro inesperado pode derrubar o request.
// Em erro, a resposta é a GENÉRICA (nunca a LP) ou 503 se não houver genérica.
export default async function capa(request, context) {
  try {
    return await capaInterno(request, context);
  } catch (erro) {
    try { console.error?.('[capa] erro inesperado', erro?.message || erro); } catch { /* noop */ }
    // (Tier A — robustez) o fail-safe também passa pelo sanitizador: uma env com
    // CR/LF lançava de novo aqui e o erro escapava do handler.
    const generico = alvoSeguro(env('CAPA_GENERIC_URL'));
    if (generico) {
      return new Response(null, { status: 302, headers: { location: generico, 'cache-control': 'no-store', 'x-robots-tag': 'noindex' } });
    }
    return new Response('Serviço temporariamente indisponível.', { status: 503, headers: { 'cache-control': 'no-store', 'x-robots-tag': 'noindex' } });
  }
}

async function capaInterno(request, context) {
  const url = new URL(request.url);
  const headers = Object.fromEntries(request.headers.entries());
  const ua = headers['user-agent'] || '';
  const ip = String(context?.ip || headers['x-nf-client-connection-ip'] || headers['cf-connecting-ip'] || '').trim();
  // (29ª rodada) `.trim()`: um código de país com espaço (" BR ") não casava a lista
  // `CAPA_PAISES_OK` e mandava uma pessoa BR para a genérica (falso positivo medido).
  // (32ª rodada — PENTEST) `cf-ipcountry` era um FALLBACK controlado pelo CLIENTE: com o
  // geo ausente, um `CF-IPCountry: US` mandava pessoa BR para a genérica (e um `BR`
  // liberava quem estava fora). O fallback por header foi REMOVIDO.
  // (38ª rodada — DECISÃO DO DONO) SEM PAÍS = GENÉRICA: o default 'BR' saiu; país
  // desconhecido agora cai em `geo_ausente` no núcleo (vale para token/param também).
  let pais = String(context?.geo?.country?.code || context?.geo?.country || '').trim();
  // (30ª rodada — LAB DE ADVERSÁRIO / Burp) O GEO É CONTROLÁVEL PELO CLIENTE: medido EM
  // PRODUÇÃO, um `X-Forwarded-For: 8.8.8.8` (EUA) fez um visitante BR cair em `geo_fora`
  // (o IP REAL gravado no log continuou o brasileiro). Então: se o XFF NÃO bate com o IP
  // real da plataforma, o país vira DESCONHECIDO (''). (38ª rodada) Com a decisão nova
  // isso significa GENÉRICA — o log marca `geoIgnoradoPorXff` para medirmos o volume.
  const xffPrimeiro = String(headers['x-forwarded-for'] || '').split(',')[0].trim();
  const xffSuspeito = Boolean(xffPrimeiro && ip && xffPrimeiro !== ip);
  if (xffSuspeito) pais = '';
  // (8ª rodada) COOKIE DUPLICADO: o navegador pode mandar mais de um `lp_t`
  // (paths diferentes); a resolução (primeiro VÁLIDO) acontece depois do cfg.
  const cookiesLp = [...String(request.headers.get('cookie') || '').matchAll(/(?:^|;\s*)lp_t=([^;]+)/g)].map((m) => m[1].trim());
  // (35ª rodada) credencial LONGA (mesmo parsing, nome diferente)
  const cookiesLongo = [...String(request.headers.get('cookie') || '').matchAll(/(?:^|;\s*)lp_r=([^;]+)/g)].map((m) => m[1].trim());
  const tokenUrl = url.searchParams.get('t');
  // (33ª rodada — PENTEST) `.webmanifest`, `.xml`, `.txt` e `.json` também são ASSETS:
  // sem isso o manifest do SPA, o robots.txt e o sitemap.xml levavam 302 para a genérica
  // (medido: `/manifest.webmanifest` sem param -> 302, quebrando o PWA e a leitura do
  // robots). O filtro de caminhos sensíveis roda ANTES e continua vencendo
  // (package.json, .netlify/state.json etc. seguem 404).
  const asset = ehAssetPath(url.pathname);

  // (FASE 1) o injetor é servido pela PRÓPRIA CAPA, na mesma origem.
  // É público por design (só lógica; nenhum segredo) — X03 do ARQUITETURAOF.MD.
  const jsPath = env('CAPA_JS_PATH', '/capa-token.js');
  if (url.pathname === jsPath) {
    // (TIER A — pedido do dono) O INJETOR NUNCA SAI PARA ROBÔ/HEADLESS/LINUX.
    // Ele é público por design para o NAVEGADOR da pessoa; bot não precisa dele.
    const idInjetor = identidadeRobo(ua);
    if (idInjetor && botAsset404Ligado() && !killSwitchLigado()) {
      enviarLog(context, {
        evento: 'capa', ip, ua, asn: null, pais, caminho: url.pathname,
        destino: DESTINO.BLOQUEADO, motivo: `asset_404:${idInjetor}:injetor`, status: 404,
        host: url.host, quando: new Date().toISOString(), cookie: 'nao', tokenUrl: 'nao',
      });
      return new Response(null, {
        status: 404,
        headers: { 'cache-control': 'no-store', 'x-robots-tag': 'noindex' },
      });
    }
    // (19ª rodada) O INJETOR É DINÂMICO: conta no MESMO teto do rate-limit. Antes ele
    // respondia sem limite nenhum (medido: 40/40 com teto 5) — um bot podia usá-lo como
    // bomba de invocações/banda. O navegador busca este arquivo 1x por visita (modo arquivo).
    const chaveInjetor = ip.includes(':') ? prefixoIP(ip) : ip;
    if (rateExcedido(chaveInjetor)) {
      return new Response(null, {
        status: 429,
        headers: {
          'retry-after': String(Number(env('CAPA_RATE_WINDOW_SEC', '60')) || 60),
          'cache-control': 'no-store',
          'x-robots-tag': 'noindex',
        },
      });
    }
    return new Response(TOKEN_INJECTOR_JS, {
      status: 200,
      headers: {
        'content-type': 'text/javascript; charset=utf-8',
        'cache-control': 'public, max-age=600',
        'x-robots-tag': 'noindex',
      },
    });
  }

  // (FASE 4 / X01) caminhos de configuração/segredo NUNCA são servidos —
  // bloqueia antes de chegar ao static/SPA fallback (senão o fallback do SPA
  // devolveria index.html com 200 para /.env).
  // (11ª rodada) O teste pegou dois furos: `/x/.env` (o regex só olhava o COMEÇO do
  // caminho) e variantes codificadas (`/..%2f.env`, `/%2e%2e%2f.env`). Agora o
  // caminho é decodificado UMA vez e a checagem vale para QUALQUER segmento,
  // incluindo tentativa de traversal (`..`).
  const caminhoDecodificado = (() => {
    try { return decodeURIComponent(url.pathname); } catch { return url.pathname; }
  })();
  // (13ª rodada) `.env.local`/`.env.production`/`.gitignore` escapavam da checagem
  // (o regex exigia o segmento EXATO) — agora qualquer segmento que COMECE com
  // `.env`/`.git` é sensível, e os configs JSON de build entram na lista.
  const PROIBIDOS = /(^|\/)(\.env[^/]*|\.git[^/]*|\.netlify|node_modules|package\.json|package-lock\.json|netlify\.toml|vercel\.json|tsconfig\.json|jsconfig\.json)(\/|$)/i;
  const sensivel = PROIBIDOS.test(caminhoDecodificado)
    || /\.(map|pem|key|sql)$/i.test(caminhoDecodificado)
    || /(^|\/)\.\.(\/|$)/.test(caminhoDecodificado);
  if (sensivel) {
    return new Response(null, { status: 404, headers: { 'cache-control': 'no-store', 'x-robots-tag': 'noindex' } });
  }

  // ==========================================================================
  // TIER A (19/09/2026) — ROTAS DE SONDA -> 404 REAL, PARA TODOS OS UAs
  // --------------------------------------------------------------------------
  // `/robots.txt`, `/meta.json` e `/sitemap.xml` NUNCA existem na LP. Responder
  // 404 vazio é o comportamento menos suspeito: parece arquivo inexistente, não
  // "site com proteção". Vale para Meta/Google/headless/Linux/Android/iOS/etc.
  // Roda ANTES do kill switch e ANTES de decidir() (a regra Linux não converte
  // isto em 302 canônica). Substituível por CAPA_SONDA_PATHS; `off` desliga.
  // ==========================================================================
  const rotasSondaEnv = env('CAPA_SONDA_PATHS', ROTAS_SONDA_DEFAULT.join(','));
  const rotasSonda = rotasSondaEnv.toLowerCase() === 'off' ? [] : csv(rotasSondaEnv);
  const paramsDonoSonda = csv(env('CAPA_AD_PARAMS'));
  if (ehRotaSonda(url.pathname, rotasSonda)) {
    enviarLog(context, {
      evento: 'capa', ip, ua, asn: null, pais, caminho: url.pathname,
      destino: DESTINO.BLOQUEADO, motivo: 'asset_404:sonda', status: 404,
      host: url.host, quando: new Date().toISOString(),
      temParam: temParamDono(url.searchParams, paramsDonoSonda),
      temParamAmplo: temAdParam(url.searchParams, paramsDonoSonda),
      cookie: 'nao', tokenUrl: 'nao',
    });
    return new Response(null, {
      status: 404,
      headers: { 'cache-control': 'no-store', 'x-robots-tag': 'noindex' },
    });
  }

  // TIER A (2ª camada) — scanners de servidor (.php/.asp/cgi-bin/wp-admin...)
  // -> 404 vazio para todos os UAs, mesmo com parâmetro. A LP é estática e
  // nunca usa esses caminhos; 404 é a resposta natural e não revela proteção.
  if (env('CAPA_SCANNER_404', 'on').toLowerCase() !== 'off' && ehRotaScanner(url.pathname)) {
    enviarLog(context, {
      evento: 'capa', ip, ua, asn: null, pais, caminho: url.pathname,
      destino: DESTINO.BLOQUEADO, motivo: 'asset_404:scanner', status: 404,
      host: url.host, quando: new Date().toISOString(),
      temParam: temParamDono(url.searchParams, paramsDonoSonda),
      temParamAmplo: temAdParam(url.searchParams, paramsDonoSonda),
      cookie: 'nao', tokenUrl: 'nao',
    });
    return new Response(null, {
      status: 404,
      headers: { 'cache-control': 'no-store', 'x-robots-tag': 'noindex' },
    });
  }

  // (25ª rodada) KILL SWITCH OPERACIONAL — `CAPA_KILL_SWITCH=on` desliga TODAS as decisões
  // (crawler / sem-param / geo / automação / perfil / rate-limit / token) e serve o conteúdo
  // da origem como veio. É a válvula de escape do dono: se algo der errado no ar, ele troca a
  // env no painel (sem novo deploy) e a LP volta a atender todo mundo. O 404 de caminhos
  // sensíveis continua (proteção de segredo) e o log registra `kill_switch`.
  if (env('CAPA_KILL_SWITCH', 'off').toLowerCase() === 'on') {
    try {
      const res = await context.next();
      if (asset) {
        const tipoKs = String(res.headers.get('content-type') || '').toLowerCase();
        if (res.status < 400 && tipoKs.includes('text/html')) {
          enviarLog(context, {
            evento: 'capa', ip, ua, asn: null, pais, caminho: url.pathname,
            destino: DESTINO.BLOQUEADO, motivo: 'asset_404:fantasma:kill_switch', status: 404,
            host: url.host, quando: new Date().toISOString(),
          });
          return new Response(null, {
            status: 404,
            headers: { 'cache-control': 'no-store', 'x-robots-tag': 'noindex' },
          });
        }
      }
      // Mesmo no kill switch, 5xx da origem NÃO vai para o visitante: aplica o
      // fail-safe padrão (genérica/503), igual ao fluxo normal.
      if (res.status >= 500) {
        const genericoKs = env('CAPA_GENERIC_URL');
        enviarLog(context, {
          evento: 'capa', ip, ua, asn: null, pais, caminho: url.pathname, destino: DESTINO.GENERICA,
          motivo: 'kill_switch_origem_5xx', status: genericoKs ? 302 : 503,
          host: url.host, quando: new Date().toISOString(),
        });
        if (genericoKs) return new Response(null, { status: 302, headers: { location: genericoKs, 'cache-control': 'no-store', 'x-robots-tag': 'noindex' } });
        return new Response('Serviço temporariamente indisponível.', { status: 503, headers: { 'cache-control': 'no-store' } });
      }
      enviarLog(context, {
        evento: 'capa', ip, ua, asn: null, pais, caminho: url.pathname, destino: DESTINO.LP,
        motivo: 'kill_switch', status: res.status, host: url.host, quando: new Date().toISOString(),
      });
      return res;
    } catch (erro) {
      enviarLog(context, {
        evento: 'capa', ip, ua, asn: null, pais, caminho: url.pathname, destino: DESTINO.GENERICA,
        motivo: 'kill_switch_erro_origem', status: env('CAPA_GENERIC_URL') ? 302 : 503,
        host: url.host, quando: new Date().toISOString(),
      });
      const generico = env('CAPA_GENERIC_URL');
      if (generico) return new Response(null, { status: 302, headers: { location: generico, 'cache-control': 'no-store', 'x-robots-tag': 'noindex' } });
      return new Response('Serviço temporariamente indisponível.', { status: 503, headers: { 'cache-control': 'no-store' } });
    }
  }

  // ==========================================================================
  // (TIER A — PEDIDO DO DONO, 20/09/2026) ROBÔ/HEADLESS/LINUX NUNCA RECEBE
  // ARQUIVO DE `public/`. Default; rollback em CAPA_BOT_ASSET_404=off; o kill
  // switch (bloco acima) continua servindo tudo como válvula de escape.
  // Roda ANTES de decidir()/da origem: nem gasta DoH nem chega ao CDN.
  // ==========================================================================
  if (botAsset404Ligado()) {
    const idAsset = identidadeRobo(ua);
    if (idAsset && asset) {
      enviarLog(context, {
        evento: 'capa', ip, ua, asn: null, pais, caminho: url.pathname,
        destino: DESTINO.BLOQUEADO, motivo: `asset_404:${idAsset}`, status: 404,
        host: url.host, quando: new Date().toISOString(),
        temParam: temParamDono(url.searchParams, paramsDonoSonda),
        temParamAmplo: temAdParam(url.searchParams, paramsDonoSonda),
        cookie: 'nao', tokenUrl: 'nao',
      });
      return new Response(null, {
        status: 404,
        headers: { 'cache-control': 'no-store', 'x-robots-tag': 'noindex' },
      });
    }
  }

  const cfg = {
    // (28ª rodada) SEGURANÇA — só aceita destino ABSOLUTO http(s). Uma env malformada
    // ("//evil.com/phish", "javascript:...", "exemplo.com/x") transformava a capa em
    // OPEN REDIRECT (medido no teste E: Location saía literalmente "//evil.example.com").
    // Agora valor inválido = ausente, e o fluxo cai no fail-safe que já existia (503 se
    // nem a genérica for válida, nunca "passa direto" para a LP).
    canonical: alvoSeguro(env('CAPA_CANONICAL_URL')),
    generic: alvoSeguro(env('CAPA_GENERIC_URL')),
    trustAsns: csv(env('CAPA_TRUST_ASNS', '32934,63293,15169,8075,714,13238,38365')).map((s) => s.replace(/^as/i, '')),
    // (36ª rodada) faixas ESTÁTICAS de crawler (funcionam mesmo com o DoH fora):
    // `off`/vazio desliga. Default = faixas conhecidas da Meta (AS32934).
    // (37ª rodada — REGRA DO DONO) Linux/X11 (desktop, headless, ChromeOS) -> CANÔNICA.
    // `CAPA_LINUX_CANONICA=off` volta ao comportamento anterior (linux/headless -> genérica).
    linuxCanonica: env('CAPA_LINUX_CANONICA', 'on').toLowerCase() !== 'off',
    // (Tier A) rollback das duas travas de UA (implausível/contraditório): default ON.
    uaEstrita: env('CAPA_UA_ESTRITA', 'on').toLowerCase() !== 'off',
    // (37ª rodada) headless "stealth" (UA x Client Hints):
    //   CAPA_CHECAR_CLIENT_HINTS=on|off  -> liga/desliga a verificação
    //   CAPA_HEADERS_SHADOW=on (default) -> só REGISTRA a sombra, não muda destino nenhum.
    //   Para ENFORÇAR (mandar para a genérica), basta CAPA_HEADERS_SHADOW=off.
    checarClientHints: env('CAPA_CHECAR_CLIENT_HINTS', 'on').toLowerCase() !== 'off',
    // (Tier A — pedido do dono, 20/09/2026) ENFORCE por DEFAULT: UA x Client Hints
    // contraditório -> GENÉRICA (antes era só log). Medido: 40/40 versões de Chrome
    // com hints mentindo são barradas, e 0 falso positivo nos 2.546 UAs reais.
    // Rollback sem deploy: CAPA_HEADERS_SHADOW=on volta ao modo "só registra".
    headersShadow: env('CAPA_HEADERS_SHADOW', 'off').toLowerCase() !== 'off',
    crawlerCidrs: (() => {
      const bruto = env('CAPA_CRAWLER_CIDRS', CRAWLER_CIDRS_DEFAULT).trim().toLowerCase();
      if (!bruto || bruto === 'off' || bruto === 'false') return [];
      return bruto.split(',').map((s) => s.trim()).filter((s) => /^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(s));
    })(),
    adParams: csv(env('CAPA_AD_PARAMS')),
    // (38ª rodada — CORREÇÃO PRIORITÁRIA DO DONO) `on` (default): SOMENTE o parâmetro do dono
    // abre a LP; `fbclid`/`gclid`/`utm_*`/`ttclid` sozinhos -> genérica (`param_nao_autorizado`).
    // `off` restaura o comportamento anterior (qualquer parâmetro de anúncio abre).
    adParamsOnly: env('CAPA_AD_PARAMS_ONLY', 'on').toLowerCase() !== 'off',
    paisesOk: csv(env('CAPA_PAISES_OK', 'BR')).map((s) => s.toUpperCase()),
    segredo: env('CAPA_TOKEN_SECRET', 'troque-este-segredo'),
    modoLog: env('CAPA_MODO_LOG', 'off').toLowerCase() === 'on',
    ttlMin: clampTtlMin(env('CAPA_TOKEN_TTL_MIN', '25')),
    tokenNaUrl: env('CAPA_TOKEN_NA_URL', 'off').toLowerCase() === 'on',
    // (34ª rodada) renovação deslizante: `off` volta ao comportamento "25 min de vida"
    renovar: env('CAPA_RENOVAR_TOKEN', 'on').toLowerCase() !== 'off',
    // (35ª rodada) credencial longa `lp_r`: sobrevive à perda do cookie curto
    cookieLongo: env('CAPA_COOKIE_LONGO', 'on').toLowerCase() !== 'off',
    ttlLongoH: (() => { const n = Number(env('CAPA_TOKEN_LONGO_H', '12')); return Number.isFinite(n) && n >= 1 ? Math.min(72, Math.floor(n)) : 12; })(),
    localstorage: env('CAPA_LOCALSTORAGE', 'auto'),
    jsPath,
  };

  // (26ª rodada) SEGREDO FORTE OBRIGATÓRIO para emitir/validar token. Sem ele (env vazia ou
  // o default público "troque-este-segredo"), qualquer pessoa que conheça o código FORJA um
  // token válido para qualquer UA//24 (medido: aceito → LP sem clique novo). Nesse caso a capa
  // NÃO valida nem emite token: serve a LP pelo clique fresco (o claim do Blobs continua) e
  // registra o motivo no log. Assim uma env esquecida não abre o gate.
  // (>=12: o que importa é não ser o default público nem vazio; o README recomenda 64 chars)
  const segredoForte = String(cfg.segredo || '').length >= 12 && cfg.segredo !== 'troque-este-segredo';

  // resolve o token de sessão em QUALQUER um dos carriers (§6.3: cookie OU ?t=).
  // (11ª rodada) Antes, um cookie presente-porém-VENCIDO bloqueava o `?t=` válido
  // (o `cookie || tokenUrl` do núcleo nunca olhava a URL) — quem tinha cookie velho
  // e clicava num link novo caía na genérica. Agora vale o 1º candidato que VALIDA
  // (cookie duplicado, depois a URL); se nenhum validar, mantém o 1º cookie para o
  // log e o fluxo segue (token inválido nunca bloqueia clique novo).
  let cookie = cookiesLp[0] || null;
  let tokenUrlResolvido = null;
  if (!segredoForte) {
    // sem segredo forte NADA é validado (token forjado com o default não entra)
    cookie = null;
  } else if (tokenUrl || cookiesLp.length > 1) {
    let valido = null;
    for (const candidato of cookiesLp) {
      if ((await validarToken(cfg.segredo, candidato, { ip, ua })).ok) { valido = candidato; break; }
    }
    if (valido) cookie = valido;
    else if (tokenUrl && (await validarToken(cfg.segredo, tokenUrl, { ip, ua })).ok) {
      tokenUrlResolvido = tokenUrl;
      cookie = null;
    }
  }

  // ASN: (ARQUITETURAOF §9 B26) header SÓ vale quando existe um proxy confiável
  // na frente (Cloudflare com Transform Rule/Worker), habilitado por env. Sem
  // isso, o cliente forjaria `cf-asn: 32934` e viraria "crawler" na hora.
  // Default false = sempre resolve por DoH (context.ip).
  let asn = '';
  if (env('CAPA_TRUST_ASN_HEADER', 'false').toLowerCase() === 'true') {
    asn = String(headers['cf-asn'] || headers['x-cf-asn'] || '').replace(/^as/i, '');
    if (asn && !/^\d{1,10}$/.test(asn)) asn = '';
  }
  // só consulta quando é requisição de documento (assets não pagam DNS)
  // (36ª rodada) faixa estática de crawler NÃO gasta DoH: a decisão já é canônica
  if (!asn && !asset && ip && !ipEmAlgumCidr(ip, cfg.crawlerCidrs)) asn = await asnDoIP(ip);

  // (38ª rodada — FALLBACK DE GEO) plataforma sem país (ou país ignorado por XFF divergente)
  // -> resolve pelo IP REAL da plataforma (timeout + cache). Se não resolver, vale o D2 (genérica).
  // O XFF não muda o país resultante (usamos `context.ip`), então quem manda header forjado
  // continua sendo tratado pelo país REAL — e o log marca `geoIgnoradoPorXff` para medição.
  let geoFonte = pais ? 'plataforma' : '';
  if (!pais && !asset && ip && GEO_FALLBACK_ON()) {
    const g = await paisDoIP(ip);
    if (g) { pais = g.pais; geoFonte = `ip:${g.fonte}`; }
  }

  const r = await decidir({ ip, ua, asn, pathname: url.pathname, busca: url.search, cookie, tokenUrl: tokenUrlResolvido, headers, pais }, cfg);

  // ==========================================================================
  // (35ª rodada — CRÍTICO) CREDENCIAL LONGA `lp_r`
  // --------------------------------------------------------------------------
  // Quem já passou pelo portão (clique com o param) recebeu um cookie longo
  // ASSINADO e preso ao UA + prefixo de IP. Se o cookie curto se perdeu (Ctrl+F5
  // com F12, "Clear storage", 25 min vencidos), a capa usa o longo e REEMITE os
  // dois — a pessoa aprovada não é expulsa para a genérica no meio da navegação.
  //
  // SEGURANÇA (revisado ponto a ponto):
  //   * só entra aqui quando NÃO havia `lp_t`/`?t=` válido E o cookie longo valida
  //     (HMAC com o segredo do servidor + binding UA/IP) — não é forjável;
  //   * a substituição acontece SÓ quando a única razão da genérica foi
  //     `sem_ad_param` — NUNCA sobrepõe crawler/automação/perfil/geo/rate-limit;
  //   * crawler/headless continuam barrados antes (o UA deles nem chega aqui);
  //   * `lp_r` não vale como `lp_t` e vice-versa (domínio de MAC separado).
  // ==========================================================================
  let usouLongo = false;
  if (segredoForte && cfg.cookieLongo && !cookie && !tokenUrlResolvido && cookiesLongo.length) {
    for (const c of cookiesLongo) {
      if ((await validarTokenLongo(cfg.segredo, c, { ip, ua })).ok) { usouLongo = true; break; }
    }
    // (38ª rodada) GEO continua mandando e agora é ESTRITO: país fora da lista OU
    // DESCONHECIDO nunca é liberado pela credencial longa (decisão do dono: sem país = genérica).
    const paisTxt = String(pais || '').trim().toUpperCase();
    const paisPermitido = !cfg.paisesOk.length || (Boolean(paisTxt) && cfg.paisesOk.includes(paisTxt));
    if (usouLongo && paisPermitido && r.destino === DESTINO.GENERICA && r.motivo === 'sem_ad_param') {
      r.destino = DESTINO.LP;
      r.motivo = 'credencial_longa_ok';
      r.mintar = true;
    }
  }

  // ==========================================================================
  // (34ª rodada — investigação do Ctrl+F5) RENOVAÇÃO DESLIZANTE DO TOKEN
  // --------------------------------------------------------------------------
  // Medido em produção: quem estava DENTRO do SPA e recarregava a página depois da
  // validade (ou com o cookie limpo pelo "Clear storage" do DevTools) caía na
  // genérica — a pessoa aprovada era expulsa no meio da navegação (falso positivo).
  // Agora, quando o token chega VÁLIDO mas já passou de METADE da validade, a capa
  // re-emite e reenvia o cookie (e o carrier no HTML) — sessão vira "25 min de
  // INATIVIDADE" em vez de "25 min de vida". Desligável com `CAPA_RENOVAR_TOKEN=off`.
  // NÃO afeta: token ausente/vencido (segue o fluxo normal: param ou genérica).
  // ==========================================================================
  if (cfg.renovar && r.motivo === 'token_ok') {
    const usado = cookie || tokenUrlResolvido || '';
    const exp = Number(String(usado).split('.')[1]);
    const restante = exp - Date.now();
    if (Number.isFinite(exp) && restante > 0 && restante < cfg.ttlMin * 60 * 1000 * 0.5) {
      r.mintar = true;
      r.motivo = 'token_renovado';
    }
  }

  const logBase = {
    evento: 'capa', ip, ua, asn: asn || null, pais, caminho: url.pathname,
    destino: r.destino, motivo: r.motivo, status: 200,
    isCrawler: r.crawler === true, crawlerVerified: r.verified === true, crawlerBot: r.bot || null,
    host: url.host, quando: new Date().toISOString(),
    // (38ª rodada) `temParam` passa a refletir a REGRA ATIVA (só o parâmetro do dono);
    // `temParamAmplo` mantém a leitura antiga (qualquer fbclid/gclid/utm) para medirmos nos logs
    // quantos visitantes chegam só com parâmetro de plataforma.
    temParam: temParamDono(url.searchParams, cfg.adParams), cookie: cookie ? 'sim' : 'nao',
    temParamAmplo: temAdParam(url.searchParams, cfg.adParams),
    tokenUrl: tokenUrl ? 'sim' : 'nao',
    // (30ª rodada) fica registrado quando o país foi IGNORADO por XFF divergente do IP real
    ...(xffSuspeito ? { geoIgnoradoPorXff: 'sim' } : {}),
    // (38ª rodada) de onde veio o país: `plataforma` (context.geo) ou `ip:<provedor>`
    ...(geoFonte ? { geoFonte } : {}),
    // (37ª rodada) SOMBRA do headless "stealth": registra a inconsistência UA x Client Hints
    // sem mudar o destino (ver `CAPA_HEADERS_SHADOW`). É assim que medimos o falso positivo
    // no tráfego real antes de ligar o bloqueio.
    ...(() => { try { const x = inconsistenciaClientHints(ua, headers); return x ? { sombraHeaders: x } : {}; } catch { return {}; } })(),
  };

  // (Fase 4/F) FAIL-SAFE: decisão de genérica com a env ausente NUNCA pode
  // "cair" para a LP. Sem alvo configurado -> 503 (nunca serve a LP).
  const irParaGenerica = (motivo, extra = {}) => {
    enviarLog(context, { ...logBase, destino: DESTINO.GENERICA, motivo, status: cfg.generic ? 302 : 503, ...extra });
    if (cfg.generic) {
      return new Response(null, { status: 302, headers: { location: cfg.generic, 'cache-control': 'no-store', 'x-robots-tag': 'noindex' } });
    }
    return new Response('Serviço temporariamente indisponível.', { status: 503, headers: { 'cache-control': 'no-store', 'x-robots-tag': 'noindex' } });
  };

  // (regra 5) rate-limit — DEPOIS do crawler (crawler verificado nunca é barrado)
  // e ANTES do token/param: estourou -> genérica. Assets ficam de fora.
  // (15ª rodada) IPv6: a chave é o PREFIXO /64 (mesmo critério do token) — um /64 tem
  // 2^64 endereços e a rotação de endereços furava o teto por IP completo. IPv4 segue
  // por IP completo de propósito (CGNAT: muitos usuários atrás do mesmo /24).
  // (29ª rodada) SEM IP NÃO HÁ TETO. Se a plataforma não entregar o IP (context.ip vazio),
  // a chave virava '' e TODO o tráfego do site compartilhava o mesmo contador — medido:
  // 30 de 130 acessos legítimos caindo na genérica por causa de um único balde vazio.
  // Sem chave utilizável, o rate-limit é PULADO (fail-open, como o resto do projeto:
  // nunca punir por dado faltante).
  const ipRate = String(ip || '').trim();
  const chaveRate = ipRate.includes(':') ? prefixoIP(ipRate) : ipRate;
  if (chaveRate && !asset && r.destino !== DESTINO.CANONICA && rateExcedido(chaveRate)) {
    return irParaGenerica('rate_limit');
  }

  // ---- CANÔNICA / GENÉRICA: 302 (temporário — NUNCA 301, que o browser cacheia)
  if (r.destino === DESTINO.CANONICA || r.destino === DESTINO.GENERICA) {
    const alvo = r.destino === DESTINO.CANONICA ? cfg.canonical : cfg.generic;
    if (!alvo) return irParaGenerica(`${r.motivo}|config_ausente`);
    enviarLog(context, { ...logBase, alvo, status: 302 });
    return new Response(null, {
      status: 302,
      headers: {
        location: alvo,
        'cache-control': 'no-store, must-revalidate',
        'x-robots-tag': 'noindex',
        'referrer-policy': 'no-referrer',
      },
    });
  }

  // ---- clique repetido (link copiado/replay) -> genérica ANTES de buscar a LP
  if (r.destino === DESTINO.LP && r.mintar) {
    const usou = await cliqueJaUsado(r.fbclid);
    if (usou) return irParaGenerica('clique_reusado');
    // (ARQUITETURAOF §6.3 / §4) CAPA_TOKEN_NA_URL=on: entrega o token TAMBÉM na URL
    // na 1ª visita (302 para a MESMA URL com ?t=), para webview que bloqueia cookie.
    if (cfg.tokenNaUrl && !url.searchParams.get('t') && segredoForte) {
      const { token } = await emitirToken(cfg.segredo, { ip, ua, expMs: cfg.ttlMin * 60 * 1000 });
      const destinoUrl = new URL(url.toString());
      destinoUrl.searchParams.set('t', token);
      enviarLog(context, { ...logBase, destino: DESTINO.LP, motivo: 'token_entregue_na_url', status: 302 });
      return new Response(null, {
        status: 302,
        headers: {
          location: destinoUrl.toString(),
          'set-cookie': `lp_t=${token}; Path=/; Max-Age=${cfg.ttlMin * 60}; HttpOnly; Secure; SameSite=Lax`,
          'cache-control': 'no-store',
          'x-robots-tag': 'noindex',
          'referrer-policy': 'no-referrer',
        },
      });
    }
  }

  // ---- LP: serve o conteúdo original da Netlify -----------------------------
  // (FASE 4 / L04) erro na origem NUNCA vira "passa direto": cai na genérica.
  // (29ª rodada) DEADLINE DA ORIGEM: se a LP travar (não responde), o visitante ficava
  // pendurado até o limite da plataforma — medido: 4 s sem NENHUMA resposta (e no fim 502).
  // Agora existe teto configurável (`CAPA_ORIGEM_DEADLINE_MS`, default 8000): estourou →
  // cai na genérica, o MESMO fail-safe do erro de origem (L04).
  const deadlineMs = Math.max(500, Number(env('CAPA_ORIGEM_DEADLINE_MS', '8000')) || 8000);
  let res = null;
  let timerDeadline = null;
  try {
    const deadline = new Promise((r) => { timerDeadline = setTimeout(() => r(null), deadlineMs); });
    res = await Promise.race([context.next(), deadline]);
  } catch (erro) {
    enviarLog(context, { ...logBase, destino: DESTINO.GENERICA, motivo: `erro_origem:${String(erro?.message || erro).slice(0, 40)}`, status: cfg.generic ? 302 : 503 });
    if (cfg.generic) return new Response(null, { status: 302, headers: { location: cfg.generic, 'cache-control': 'no-store', 'x-robots-tag': 'noindex' } });
    return new Response('Serviço temporariamente indisponível.', { status: 503, headers: { 'cache-control': 'no-store' } });
  } finally {
    if (timerDeadline) clearTimeout(timerDeadline);
  }

  // origem que NÃO respondeu dentro do deadline → genérica (nunca deixa a pessoa pendurada)
  if (!res) {
    enviarLog(context, { ...logBase, destino: DESTINO.GENERICA, motivo: `origem_timeout:${deadlineMs}ms`, status: cfg.generic ? 302 : 503 });
    if (cfg.generic) return new Response(null, { status: 302, headers: { location: cfg.generic, 'cache-control': 'no-store', 'x-robots-tag': 'noindex' } });
    return new Response('Serviço temporariamente indisponível.', { status: 503, headers: { 'cache-control': 'no-store' } });
  }

  // (18ª rodada) ORIGEM COM 5xx não vai para o visitante: mesma regra do erro de origem —
  // cai na genérica (o motivo fica no log). Antes o 500 do site era repassado e a pessoa
  // via uma página quebrada no tráfego pago.
  if (res.status >= 500) {
    enviarLog(context, { ...logBase, destino: DESTINO.GENERICA, motivo: `origem_5xx:${res.status}`, status: cfg.generic ? 302 : 503 });
    if (cfg.generic) return new Response(null, { status: 302, headers: { location: cfg.generic, 'cache-control': 'no-store', 'x-robots-tag': 'noindex' } });
    return new Response('Serviço temporariamente indisponível.', { status: 503, headers: { 'cache-control': 'no-store' } });
  }

  // ==========================================================================
  // TIER A — ASSET FANTASMA: o origin devolveu HTML (fallback da SPA) para um
  // caminho com extensão de asset. O arquivo NÃO EXISTE; devolver HTML vazaria
  // e executaria a SPA. Resposta: 404 vazio. Assets reais têm content-type
  // próprio e continuam passando; o middleware não conhece a lista de public.
  // ==========================================================================
  if (asset) {
    const tipoAsset = String(res.headers.get('content-type') || '').toLowerCase();
    if (res.status < 400 && tipoAsset.includes('text/html')) {
      enviarLog(context, { ...logBase, destino: DESTINO.BLOQUEADO, motivo: 'asset_404:fantasma', status: 404 });
      return new Response(null, {
        status: 404,
        headers: { 'cache-control': 'no-store', 'x-robots-tag': 'noindex' },
      });
    }
  }

  if (r.destino === DESTINO.LP && r.mintar) {
    // (26ª rodada) sem segredo forte não emite token: serve a LP pelo clique fresco
    const { token } = segredoForte ? await emitirToken(cfg.segredo, { ip, ua, expMs: cfg.ttlMin * 60 * 1000 }) : { token: '' };
    const headersOut = new Headers(res.headers);
    if (token) headersOut.append('set-cookie', `lp_t=${token}; Path=/; Max-Age=${cfg.ttlMin * 60}; HttpOnly; Secure; SameSite=Lax`);
    // (35ª rodada — CRÍTICO) credencial LONGA: sobrevive à perda/expiração do `lp_t`
    // (Ctrl+F5, F12 "Clear storage", 25 min vencidos). Assinada, presa ao UA + prefixo de IP.
    if (token && cfg.cookieLongo) {
      const { token: longo } = await emitirTokenLongo(cfg.segredo, { ip, ua, expMs: cfg.ttlLongoH * 3600 * 1000 });
      headersOut.append('set-cookie', `lp_r=${longo}; Path=/; Max-Age=${cfg.ttlLongoH * 3600}; HttpOnly; Secure; SameSite=Lax`);
      enviarLog(context, { ...logBase, destino: DESTINO.LP, motivo: 'credencial_longa_emitida' });
    }
    headersOut.set('cache-control', 'no-store');
    headersOut.set('x-robots-tag', 'noindex');
    headersOut.set('referrer-policy', 'no-referrer');
    const tipo = headersOut.get('content-type') || '';
    let corpo = res.body;
    if (tipo.includes('text/html')) {
      // (15ª rodada) RESPOSTA PARCIAL (Range/206) NUNCA é reescrita: injetar num pedaço
      // faria o Content-Range deixar de valer (o cliente recebe bytes fora do intervalo).
      const respostaParcial = res.status === 206 || Boolean(headersOut.get('content-range'));
      if (respostaParcial) {
        enviarLog(context, { ...logBase, destino: DESTINO.LP, motivo: 'injecao_ignorada:resposta_parcial' });
      } else {
      // (13ª rodada / §15-11 — LEVEZA) TETO DE INJEÇÃO: ler+reescrever uma página
      // gigante custa CPU (medido: 2 MB ≈ 55 ms, acima do limite de 50 ms da Netlify).
      // Acima de CAPA_INJECT_MAX_KB a LP é servida SEM injeção; cookie e `?t=`
      // continuam valendo (2 dos 3 carriers) e o corpo nem é lido.
      const tetoInjecaoKb = Number(env('CAPA_INJECT_MAX_KB', '1024')) || 1024;
      const tamanhoDeclarado = Number(headersOut.get('content-length') || '0') || 0;
      const paginaGrande = tamanhoDeclarado > tetoInjecaoKb * 1024;
      // headers originais guardados ANTES de qualquer decisão (22ª rodada: o guarda de
      // charset precisa deles aqui em cima)
      const encOriginal = headersOut.get('content-encoding');
      const lenOriginal = headersOut.get('content-length');
      const etagOriginal = headersOut.get('etag');
      const restaurarHeaders = () => {
        if (encOriginal) headersOut.set('content-encoding', encOriginal);
        if (lenOriginal) headersOut.set('content-length', lenOriginal);
        if (etagOriginal) headersOut.set('etag', etagOriginal);
      };
      // (22ª rodada) CHARSET: `res.text()` decodifica como UTF-8 e a reescrita devolve UTF-8.
      // Numa LP em latin-1 (ou qualquer charset não-UTF-8) isso vira mojibake. Nesses casos
      // NÃO injeta: serve a página como veio (cookie e `?t=` continuam valendo).
      const charset = (tipo.match(/charset=["']?([\w-]+)/i) || [])[1]?.toLowerCase() || '';
      const charsetOk = !charset || charset === 'utf-8' || charset === 'utf8' || charset === 'us-ascii' || charset === 'ascii';
      if (!charsetOk) {
        enviarLog(context, { ...logBase, destino: DESTINO.LP, motivo: `injecao_ignorada:charset:${charset}` });
        restaurarHeaders();
      } else if (paginaGrande) {
        enviarLog(context, { ...logBase, destino: DESTINO.LP, motivo: `injecao_ignorada:pagina_grande:${Math.round(tamanhoDeclarado / 1024)}kb` });
      } else {
        // o conteúdo vai mudar: sem content-encoding/length/etag do original,
        // senão o cliente recebe tamanho/encoding errados (res.text() descomprime).
        // (16ª rodada) Mas se decidirmos NÃO reescrever (encoding que não sabemos tratar),
        // os headers originais têm de VOLTAR — senão entregamos bytes comprimidos sem o
        // header que diz ao browser como descomprimir (página vira lixo binário).
        headersOut.delete('content-encoding');
        headersOut.delete('content-length');
        headersOut.delete('etag');
        // (FASE 1) escolhe o modo do injetor conforme a CSP da resposta
        const csp = headersOut.get('content-security-policy') || '';
        const { modo, nonce: precisaNonce } = escolherModoInjecao(csp, cfg.localstorage);
        let nonce = '';
        if (precisaNonce && modo !== 'off') {
          nonce = gerarNonce();
          headersOut.set('content-security-policy', injetarNonceNaCSP(csp, nonce));
        }
        const injecao = token ? montarInjecaoHtml({ modo, token, jsPath: cfg.jsPath, nonce }) : '';
        if (injecao) {
          try {
            let html = null;
            // (16ª rodada) CONTENT-ENCODING: navegador SEMPRE negocia gzip/br. `res.text()`
            // NÃO descomprime quando a resposta chega com `content-encoding` — injetar nos
            // bytes comprimidos corrompia a LP. Agora: gzip/deflate → descomprime e injeta;
            // corpo já decodificado (header obsoleto) → injeta; exótico (br/zstd) → não
            // reescreve e devolve o original com os headers restaurados.
            const encoding = String(encOriginal || '').toLowerCase().trim();
            const comprimido = Boolean(encoding) && encoding !== 'identity';
            if (!comprimido) {
              if (tamanhoDeclarado) {
                html = await res.text();
              } else if (res.body) {
              // SEM content-length (resposta em chunked): lê no máximo o teto. Se passar
              // dele, devolve a página ORIGINAL INTEIRA (chunks já lidos + o resto do
              // stream) sem injetar — nunca corta conteúdo nem estoura a CPU do edge.
              const leitor = res.body.getReader();
              const dec = new TextDecoder();
              const limite = tetoInjecaoKb * 1024;
              const pedacos = [];
              let lido = 0, passou = false;
              for (;;) {
                const { value, done } = await leitor.read();
                if (done) break;
                pedacos.push(value);
                lido += value.byteLength;
                if (lido > limite) { passou = true; break; }
              }
              if (passou) {
                // devolve o que já foi lido + o restante do stream, na ordem original
                corpo = new ReadableStream({
                  start(c) { for (const p of pedacos) c.enqueue(p); },
                  async pull(c) {
                    const { value, done } = await leitor.read();
                    if (done) c.close(); else c.enqueue(value);
                  },
                });
                enviarLog(context, { ...logBase, destino: DESTINO.LP, motivo: 'injecao_ignorada:sem_content_length' });
                restaurarHeaders();
              } else {
                let texto = '';
                for (const p of pedacos) texto += dec.decode(p, { stream: true });
                html = texto + dec.decode();
              }
              }
            } else if (typeof DecompressionStream === 'function') {
              // corpo COMPRIMIDO: pega os bytes (declarados ou lidos até o teto) e decide
              let buf = null;
              if (tamanhoDeclarado) {
                buf = new Uint8Array(await res.arrayBuffer());
              } else if (res.body) {
                const leitor = res.body.getReader();
                const pedacos = [];
                const limite = tetoInjecaoKb * 1024;
                let lido = 0, passou = false;
                for (;;) {
                  const { value, done } = await leitor.read();
                  if (done) break;
                  pedacos.push(value);
                  lido += value.byteLength;
                  if (lido > limite) { passou = true; break; }
                }
                if (passou) {
                  corpo = new ReadableStream({
                    start(c) { for (const p of pedacos) c.enqueue(p); },
                    async pull(c) {
                      const { value, done } = await leitor.read();
                      if (done) c.close(); else c.enqueue(value);
                    },
                  });
                  restaurarHeaders();
                  enviarLog(context, { ...logBase, destino: DESTINO.LP, motivo: 'injecao_ignorada:encoding_sem_content_length' });
                } else {
                  const total = pedacos.reduce((a, p) => a + p.byteLength, 0);
                  buf = new Uint8Array(total);
                  let off = 0;
                  for (const p of pedacos) { buf.set(p, off); off += p.byteLength; }
                }
              }
              if (buf) {
              const ehGzip = buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b;
              const ehDeflate = buf.length > 2 && buf[0] === 0x78;
              let textoPlano = null;
              try {
                const amostra = new TextDecoder('utf-8', { fatal: true }).decode(buf.subarray(0, Math.min(buf.length, 512)));
                if (!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(amostra)) textoPlano = new TextDecoder().decode(buf);
              } catch { textoPlano = null; }
              if (ehGzip || ehDeflate) {
                const ds = new DecompressionStream(ehGzip ? 'gzip' : 'deflate');
                html = await new Response(new Response(buf).body.pipeThrough(ds)).text();
              } else if (textoPlano !== null) {
                html = textoPlano;   // header obsoleto: o runtime já entregou decodificado
              } else {
                corpo = buf;         // exótico (br/zstd): não reescreve, devolve os bytes
                restaurarHeaders();
                enviarLog(context, { ...logBase, destino: DESTINO.LP, motivo: `injecao_ignorada:encoding:${encoding}` });
              }
              }
            } else {
              restaurarHeaders();
              enviarLog(context, { ...logBase, destino: DESTINO.LP, motivo: `injecao_ignorada:encoding_sem_content_length:${encoding || 'sem_ds'}` });
            }
            if (typeof html === 'string') {
              // (22ª rodada) `</body>` pode aparecer ANTES do fechamento real — dentro de
              // <script>, comentário ou atributo. Injeta no ÚLTIMO, senão o token entra no
              // meio do código da página e pode quebrar o site.
              const posBody = html.toLowerCase().lastIndexOf('</body>');
              html = posBody >= 0 ? `${html.slice(0, posBody)}${injecao}${html.slice(posBody)}` : `${html}${injecao}`;
              corpo = html;
            }
          } catch {
            // (7ª rodada) stream cortado no meio (rede caiu durante o HTML):
            // NÃO deixa a exceção subir — vai para a genérica (nunca serve a LP quebrada).
            return irParaGenerica('erro_stream_injecao');
          }
        }
      }
      }  // fim do else de respostaParcial (15ª rodada)
    }
    res = new Response(corpo, { status: res.status, headers: headersOut });
    enviarLog(context, { ...logBase, destino: DESTINO.LP, motivo: token ? 'clique_fresco_token_emitido' : 'clique_fresco_sem_token:segredo_fraco', status: res.status });
    return res;
  }

  // (23ª rodada) DOCUMENTO servido pela via do TOKEN (cookie/`?t=`) saía SEM os headers de
  // segurança: o `?t=` podia vazar por Referer para terceiros (analytics/imagens) e a página
  // não estava marcada como noindex/no-store. Assets continuam como vieram (cache é leveza).
  const tipoFinal = res.headers.get('content-type') || '';
  if (res.status < 400 && tipoFinal.includes('text/html')) {
    const h = new Headers(res.headers);
    h.set('cache-control', 'no-store');
    h.set('x-robots-tag', 'noindex');
    h.set('referrer-policy', 'no-referrer');
    enviarLog(context, { ...logBase, destino: DESTINO.LP, motivo: 'token_ok_headers_seguranca', status: res.status });
    return new Response(res.body, { status: res.status, headers: h });
  }
  enviarLog(context, { ...logBase, status: res.status });
  return res;
}

export const config = { path: '/*' };
