// ============================================================================
// capa-core.js — NÚCLEO PURO da capa (sem APIs da Netlify = 100% testável).
// Decisão: canônica (crawler) / genérica (sem param, geo, automação, perfil
// implausível) / LP (clique fresco ou token válido em cookie|URL|localStorage).
// Ordem importa: crawler SEMPRE antes do token.
// ============================================================================

// ---------- listas embutidas (não dependem de rede) -------------------------
export const CRAWLER_UA_TOKENS = [
  'googlebot', 'google-inspectiontool', 'adsbot-google', 'mediapartners-google',
  'bingbot', 'msnbot', 'adidxbot', 'facebookexternalhit', 'facebookbot',
  'meta-externalagent', 'meta-externalfetcher', 'applebot', 'duckduckbot',
  // (18ª rodada) ACHADOS NA BASE REAL (meta_events.csv): o crawler de ANÚNCIOS da Meta
  // aparece em vários disfarces de Chrome/Safari ("... (compatible; meta-externalads/1.1 ...)")
  // e o Google Read Aloud também vinha fantasiado de Chrome Android. Sem estes tokens eles
  // recebiam a LP quando traziam param. `msie 10.6` não existe em navegador real (é UA falsa).
  'meta-externalads', 'google-read-aloud',
  'yandexbot', 'baiduspider', 'bytespider', 'petalbot', 'gptbot', 'oai-searchbot',
  'chatgpt-user', 'claudebot', 'ccbot', 'perplexitybot', 'amazonbot',
  'twitterbot', 'linkedinbot', 'slackbot', 'telegrambot', 'discordbot',
  'pinterestbot', 'semrushbot', 'ahrefsbot', 'mj12bot', 'siteaudit',
  'uptimerobot', 'pingdom', 'statuscake', 'datadog', 'betteruptime',
  // (25ª rodada) SEGUNDA ONDA de agentes de IA que se identificam por UA — medido:
  // 33 de 35 passavam para a LP. Tokens ESPECÍFICOS (com hífen/barra) para não colidir
  // com UA de navegador (a guarda D confere contra os 2.546 UAs reais da base).
  'anthropic-ai', 'claude-searchbot', 'cohere-ai', 'youbot', 'mistralai',
  'together-ai', 'fireworksai', 'deepseekbot', 'qwenbot', 'kimibot',
  'nousresearch', 'xai-bot', 'grok/',
  // (12ª rodada) FAMÍLIAS QUE PASSARAM BATIDO no catálogo de 74 bots testados.
  // Tokens ESPECÍFICOS de propósito (nunca uma palavra genérica como "yandex",
  // que existe em navegador real) — o teste A2 confere que nenhum UA de
  // navegador do CSV real casa com esta lista.
  'googleother', 'storebot-google', 'bingpreview', 'duckassistbot',
  'yandexmobilebot', 'yandeximages', 'yandexvideo', 'yandexmedia', 'yandexnews',
  'sogou web spider', 'sogou-test-spider', 'yisouspider',
  'claude-web', 'perplexity-user', 'yeti/', 'seznambot', 'qwantify',
  'diffbot', 'omgili', 'zoominfobot', 'blexbot', 'dotbot', 'dataforseo',
  'screaming frog', 'gtmetrix', 'chrome-lighthouse',
  // (2ª onda em nuvem) `pinterest/` SOZINHO era FALSO POSITIVO: o navegador interno do
  // app do Pinterest (`[Pinterest/iOS]`, `[Pinterest/Android]`) é PESSOA REAL com param
  // e caía na genérica. O crawler de verdade se identifica como `Pinterestbot` (já na
  // lista acima) ou `Pinterest/0.2 (+https://www.pinterest.com/bot.html)` — por isso
  // agora só os tokens ESPECÍFICOS do robô ficam aqui.
  'better uptime', 'whatsapp/', 'skypeuripreview', 'embedly',
  'pinterest/0.', 'pinterest.com/bot',
];
// (27ª rodada — FP de WEBVIEW) Tokens que só valem como crawler quando a UA NÃO tem
// marcadores de navegador. Caso real medido: o app do WhatsApp no Brasil manda UA de
// CHROME completo + `WhatsApp/2.x` (navegador interno = PESSOA com param) enquanto o
// buscador de preview manda `WhatsApp/2.x A` seco. Sem esta distinção a pessoa caía na
// genérica. É a MESMA doutrina do middleware Vercel antigo ("UA WhatsApp é sempre
// usuário: o preview do link pode ser gerado no aparelho do remetente, IP residencial").
// Segurança: um robô pode forjar `Mozilla/5.0` — mas ele já pode forjar qualquer UA de
// Chrome, então isto NÃO abre superfície nova (a lista de UA é higiene, não barreira).
export const CRAWLER_UA_SO_SEM_NAVEGADOR = new Set(['whatsapp/']);
const MARCADOR_NAVEGADOR = /mozilla\/|applewebkit|chrome\/|safari\/|firefox\/|crios|edg\//;

// ============================================================================
// TIER A — ROTAS DE SONDA E ASSETS (middleware independente do conteúdo de public)
// ----------------------------------------------------------------------------
// O middleware não conhece a lista de arquivos do build. Ele usa duas ideias:
//   1. rotas de sonda conhecidas (robots/meta/sitemap) -> 404 vazio para TODOS;
//   2. qualquer caminho com extensão de asset cujo origin devolveu HTML
//      (fallback da SPA) é asset inexistente -> 404 vazio.
// A normalização (decode + caixa + barra final) é única e compartilhada com o
// handler, para não haver divergência entre as camadas.
// ============================================================================
// Paths que SÓ crawler/robô pede (a LP não usa): 404 vazio para qualquer UA/IP.
// Fora da lista de propósito: /favicon.ico, /manifest.webmanifest, app links e
// /.well-known/acme-challenge (infra/browser); esses seguem o fluxo normal e o
// guard de asset fantasma só os bloqueia se o arquivo realmente não existir.
export const ROTAS_SONDA_DEFAULT = [
  '/robots.txt', '/meta.json', '/sitemap.xml',
  '/sitemap_index.xml', '/sitemap-index.xml', '/sitemap.xml.gz', '/sitemap.txt',
  '/news-sitemap.xml', '/image-sitemap.xml', '/video-sitemap.xml',
  '/ads.txt', '/app-ads.txt',
  '/security.txt', '/.well-known/security.txt',
  '/humans.txt',
  '/llms.txt', '/llms-full.txt', '/ai.txt', '/.well-known/ai.txt',
];
export function normalizarCaminhoParaMatch(pathname) {
  let s = String(pathname || '/');
  for (let i = 0; i < 2; i++) {
    try {
      const d = decodeURIComponent(s);
      if (d === s) break;
      s = d;
    } catch { break; }
  }
  s = s.toLowerCase();
  if (!s.startsWith('/')) s = `/${s}`;
  s = s.replace(/\/+$/, '');
  return s || '/';
}
export function ehRotaSonda(pathname, rotas = ROTAS_SONDA_DEFAULT) {
  const alvo = normalizarCaminhoParaMatch(pathname);
  return (rotas || []).some((r) => normalizarCaminhoParaMatch(r) === alvo);
}
export const ASSET_EXT_RE = /\.(png|jpe?g|gif|svg|webp|avif|ico|css|js|mjs|map|woff2?|ttf|otf|eot|mp4|webm|mp3|wav|pdf|zip|gz|tgz|br|zst|7z|rar|webmanifest|xml|txt|json|csv)$/i;
export const ehAssetPath = (pathname) => ASSET_EXT_RE.test(normalizarCaminhoParaMatch(pathname));
// Extensões de servidor e prefixos de painel que a LP estática NUNCA usa. São
// alvos clássicos de scanner; 404 vazio evita servir o SPA para ferramenta de
// reconhecimento. Não inclui /admin genérico (pode ser rota legítima do SPA).
export const EXTENSOES_SERVIDOR_RE = /\.(php\d?|phtml|asp|aspx|jsp|jspx|cgi|pl|py|rb|sh|bak|old|orig|swp)$/i;
export const PREFIXOS_SCANNER = [
  '/wp-login', '/wp-admin', '/wp-content', '/wp-includes', '/xmlrpc.php',
  '/phpmyadmin', '/pma', '/cgi-bin', '/vendor/phpunit', '/.svn', '/.hg',
  '/.ds_store', '/thumbs.db', '/server-status', '/server-info', '/actuator',
  '/manager/html', '/solr', '/console', '/trace',
];
export function ehRotaScanner(pathname) {
  const p = normalizarCaminhoParaMatch(pathname);
  return EXTENSOES_SERVIDOR_RE.test(p) || PREFIXOS_SCANNER.some((x) => p === x || p.startsWith(`${x}/`));
}

// ============================================================================
// (37ª rodada — REGRA DO DONO) LINUX/X11 -> CANÔNICA
// ----------------------------------------------------------------------------
// "Todo UA Linux/X11 — (X11; Linux x86_64), (X11; Ubuntu; Linux x86_64),
//  (X11; Linux aarch64), (X11; CrOS x86_64 ...) e semelhantes — seja Linux, headless
//  ou desktop, vai para a CANÔNICA, mesmo com IP residencial BR e headers de Chrome."
//
// POR QUE O PADRÃO É ESTE (medido na base real de 2.546 UAs, `_pesquisa/_padrao-linux-fp.mjs`):
//   * `(x11;` ............... 12 UAs casam, **0 de celular/app**  <- marcador de desktop Unix
//   * `linux x86_64` ........ mesmo conjunto (12), 0 de celular
//   * `linux aarch64` ....... 0 na base, mas existe no mundo real (Linux ARM)
//   * `cros` ................ 0 na base (ChromeOS manda `(X11; CrOS ...)` e já cai no 1º)
// Android manda `(Linux; Android ...)`, iPhone `(iPhone; ...)`, macOS `(Macintosh; ...)`:
// NENHUM contém `(X11;`. A guarda `MARCADOR_MOBILE_RE` é a segunda trava: se por qualquer
// motivo um UA de celular trouxer `x11`/`aarch64`, ele NÃO entra nesta regra.
export const LINUX_DESKTOP_RE = /\(x11;|linux aarch64|\bcros\b/i;
export const MARCADOR_MOBILE_RE = /android|iphone|ipad|ipod|mobile|windows phone|kaios|opera mini|blackberry|; ?wv\)|fb_iab|fban\/|fbav|instagram|tiktok|snapchat|reddit|micromessenger/i;
export function ehLinuxDesktop(ua) {
  const s = norm(ua);
  if (!s) return false;
  if (MARCADOR_MOBILE_RE.test(s)) return false;   // trava anti-falso-positivo (LG, Moto G, webviews)
  return LINUX_DESKTOP_RE.test(s);
}

// ============================================================================
// (TIER A — PEDIDO DO DONO, 20/09/2026) DUAS TRAVAS NOVAS, AMBAS DEFAULT
// ----------------------------------------------------------------------------
// 1) UA CONTRADITÓRIO: um UA com marcador de desktop Unix (`(X11;`, `linux
//    aarch64`, `cros`) E marcador de celular no mesmo texto escapava da regra
//    Linux (por causa da trava acima) e RECEBIA A LP. Medido no fuzz: 22/22
//    casos e 45,1% de 3.000 mutações. Agora vira GENÉRICA — a direção segura.
//    Evidência de falso positivo: 0 dos 2.546 UAs reais da base são assim.
// 2) FORMA DO UA: UA gigante (>400), com 40+ caracteres repetidos ou sem
//    NENHUM marcador conhecido de navegador/app/cliente -> GENÉRICA. Medido:
//    o maior UA real tem 332 chars, 0 têm repetição e o único sem marcador é
//    `meta-externalads` (que já é token de crawler) -> 0 falso positivo.
// ============================================================================
export const MARCADOR_CONHECIDO_RE = /mozilla|applewebkit|chrome|safari|firefox|edg|opera|samsung|ucbrowser|dalvik|okhttp|instagram|facebook|fbav|fban|tiktok|whatsapp|curl|wget|python|scrapy|crawl|spider|bot/i;
// marcador FORTE = versão de navegador/cliente conhecido; plataforma = SO declarado.
// Evidência (base real, 2.546 UAs): "mozilla" sem marcador forte E sem plataforma = 0.
// `trident|msie` entra porque 3 UAs reais da base são IE11/IE10 no Windows e NÃO
// têm outro marcador forte (sem isso, a regra de UA quebrado criaria falso positivo).
export const MARCADOR_FORTE_RE = /chrome\/\d|crios\/\d|safari\/\d|firefox\/\d|applewebkit|edg\/\d|opr\/\d|samsungbrowser\/\d|ucbrowser\/\d|dalvik|okhttp|trident|msie|curl\/|wget\/|python|scrapy|crawl|spider|bot/i;
export const PLATAFORMA_RE = /android|iphone|ipad|ipod|linux|macintosh|mac os x|windows|kaios|blackberry|cros|ubuntu|fedora|harmony|huawei/i;
export function ehUAContraditorio(ua) {
  const s = norm(ua);
  return Boolean(s) && LINUX_DESKTOP_RE.test(s) && MARCADOR_MOBILE_RE.test(s);
}
export function ehUAImplausivel(ua) {
  const bruto = String(ua || '');
  const s = bruto.toLowerCase().trim();
  if (!s) return false;                                  // UA vazio tem regra própria (ua_vazia)
  if (bruto.length > 400) return true;
  if (/(.)\1{40,}/.test(s)) return true;
  // UA truncado/quebrado: diz "Mozilla" mas não tem versão de navegador nem SO.
  // Medido: 0 dos 2.546 UAs reais caem aqui; pega o resíduo do fuzz (ex.: "FBAN/FBIOS Mozilla/5.0 (X1").
  // Diz "Mozilla" mas não tem NENHUM marcador forte de navegador/cliente = truncado
  // ou quebrado. Medição na base real: 0 de 2.546 UAs caem aqui (IE11/IE10 entram
  // como fortes via `trident|msie`; todo o resto tem chrome/safari/firefox/webkit).
  if (/mozilla/i.test(s) && !MARCADOR_FORTE_RE.test(s)) return true;
  // UA curto com marcador de APP (FB) e SEM plataforma = truncação/quebra
  // (ex.: "[FB_IAB/FB4A;FBAV/578.0.0."). Evidência: os únicos UAs reais < 60 chars
  // são `facebookexternalhit/1.1` e `meta-externalads/1.1` (nenhum com fbav) -> 0 FP.
  if (s.length < 60 && /fban\/|fb_iab|fbav\//i.test(s) && !PLATAFORMA_RE.test(s)) return true;
  // Limite 12 (era 20): UA curto SEM marcador algum = cliente quebrado/robô
  // (medido: `nook browser/1.0` entrava na LP). Evidência: no corpus de 51.543
  // UAs, os 434 curtos sem marcador são bots/monitores (ApacheBench, Datadog,
  // COMODO SSL Checker, Mediapartners-Google…); na base real do site, o único
  // curto é `meta-externalads/1.1` (já bloqueado) -> 0 falso positivo.
  return s.length > 12 && !MARCADOR_CONHECIDO_RE.test(s);
}

// ============================================================================
// (37ª rodada — HEADLESS "STEALTH") INCONSISTÊNCIA ENTRE UA E CLIENT HINTS
// ----------------------------------------------------------------------------
// MEDIDO com Chrome real (Chrome 153) em `_pesquisa/_headless-headers.mjs`:
//   headless padrão ......... UA `HeadlessChrome/153` + sec-ch-ua `v="153"` + platform "Windows"
//   stealth (UA Linux/151) .. UA diz Chrome/151 Linux, mas sec-ch-ua diz `v="153"` e platform "Windows"
//   stealth (UA Windows/151)  UA diz 151, sec-ch-ua diz 153
// Ou seja: o `sec-ch-ua` NÃO mente — o UA é que foi adulterado (Puppeteer/Playwright `--user-agent`
// ou troca de UA). Um Chrome REAL sempre tem a MESMA versão no UA e no `sec-ch-ua`.
//
// Só se aplica a navegadores Chromium de DESKTOP: qualquer UA com marcador de celular/app é
// ignorado (Android/iOS/KaiOS/webviews), e sem `sec-ch-ua` no request a função não opina.
// Devolve: null (ok), 'ua_ch_versao' ou 'ua_ch_plataforma'.
export function inconsistenciaClientHints(ua, headers = {}) {
  const s = norm(ua);
  if (!s) return null;
  const h = {};
  for (const [k, v] of Object.entries(headers || {})) h[String(k).toLowerCase()] = v;
  // (Tier A — pedido do dono, 20/09/2026) MOBILE com plataforma de DESKTOP nos
  // Client Hints = headless/desktop se passando por celular -> GENÉRICA.
  // Só Windows/macOS/ChromeOS contam: `Linux` fica de fora de propósito porque
  // Android é Linux-based e alguns clientes antigos reportam "Linux" (anti-FP).
  // O restante do mobile continua isento (webview de app manda headers parciais).
  const chPlatform = norm(String(h['sec-ch-ua-platform'] || '').replace(/"/g, ''));
  if (MARCADOR_MOBILE_RE.test(s)) {
    if (chPlatform && /windows|mac ?os|chrome ?os/.test(chPlatform)) return 'ua_ch_plataforma_mobile';
    return null;                                    // celular/app: fora do resto
  }
  const chUa = String(h['sec-ch-ua'] || '');
  if (!chUa) return null;                            // Safari/Firefox/curl: não se aplica
  // ---- R1: versão do produto no UA x versão no sec-ch-ua (comparação por MARCA) ----
  const marcas = [...chUa.matchAll(/"([^"]+)"\s*;\s*v="?(\d+)"?/g)].map((m) => ({ marca: m[1].toLowerCase(), ver: Number(m[2]) }));
  const porMarca = (frag) => marcas.find((m) => m.marca.includes(frag));
  const verUA = (re) => Number((s.match(re) || [])[1] || 0);
  const par = (marcaCh, verUa) => (marcaCh && verUa ? { verCh: marcaCh.ver, verUa } : null);
  let alvo = null;
  if (verUA(/\bedg\/(\d+)/)) alvo = par(porMarca('edge'), verUA(/\bedg\/(\d+)/));
  else if (verUA(/\bopr\/(\d+)/)) alvo = par(porMarca('opera'), verUA(/\bopr\/(\d+)/));
  else if (verUA(/samsungbrowser\/(\d+)/)) alvo = par(porMarca('samsung internet'), verUA(/samsungbrowser\/(\d+)/));
  else if (!/crios/.test(s) && verUA(/chrome\/(\d+)/)) alvo = par(porMarca('chromium') || porMarca('google chrome'), verUA(/chrome\/(\d+)/));
  if (alvo && alvo.verCh !== alvo.verUa) return 'ua_ch_versao';
  // ---- R2: plataforma do UA x `sec-ch-ua-platform` (só entre plataformas de DESKTOP) ----
  const plat = norm(String(h['sec-ch-ua-platform'] || '').replace(/"/g, ''));
  if (plat) {
    const uaPlat = /windows nt/.test(s) ? 'windows'
      // `\bcros\b` (e não `/cros/`): "Microsoft" contém "cros" e virava ChromeOS
      : /\bcros\b/.test(s) ? 'chromeos'
        : /macintosh|mac os x/.test(s) ? 'macos'
          : /x11|linux x86_64|linux aarch64|ubuntu|fedora/.test(s) ? 'linux' : '';
    const chPlat = /windows/.test(plat) ? 'windows'
      : /chrome os|chromeos/.test(plat) ? 'chromeos'
        : /macos|mac os/.test(plat) ? 'macos'
          : /linux/.test(plat) ? 'linux' : '';
    if (uaPlat && chPlat && uaPlat !== chPlat) return 'ua_ch_plataforma';
  }
  return null;
}
export const CRAWLER_ASNS_DEFAULT = '32934,63293,15169,8075,714,13238,38365';
export const AUTOMATION_UA_PATTERNS = [
  // (28ª rodada — REGRA DO DONO) "headless não vê a route-path". `headless` sozinho
  // cobre HeadlessChrome, HeadlessShell, chrome-headless e variações futuras; nenhum
  // navegador de gente manda isso (confirmado contra os 2.546 UAs da base real).
  'headless', 'headlesschrome', 'phantomjs', 'puppeteer', 'playwright', 'selenium',
  'curl', 'wget', 'python-requests', 'scrapy', 'node-fetch',
  'go-http-client', 'java/', 'okhttp', 'axios', 'libwww-perl', 'httpie',
  // (34ª rodada — PENTEST EM NUVEM) `node` e `undici` são a UA PADRÃO do fetch do
  // Node (medido em produção: request sem UA declarada chega como `node` e RECEBIA a LP).
  // Guarda de FP: 0 (zero) das 2.546 UAs da base real contêm esses substrings.
  'node', 'undici', 'nodejs',
  // (18ª rodada) `ruby` sozinho era FALSO POSITIVO: UA real de Xiaomi/Redmi traz o
  // codinome do aparelho — "xiaomi/redmi; 22101316g; ruby; mt6877; pt_br" — e a pessoa
  // caía na genérica. Agora só os clientes Ruby de verdade (com versão/nome de gem).
  'ruby/', 'rest-client', 'typhoeus', 'httparty',
  // (12ª rodada) clientes HTTP e scanners que também passavam batido
  'masscan', 'zgrab', 'nmap scripting engine',
  'msie 10.6',
  'postmanruntime', 'insomnia', 'dart/', 'powershell', 'winhttp',
  'guzzlehttp', 'libcurl',
  // (25ª rodada) serviços de SCRAPING/coleta que se identificam (o "bypass sofisticado"
  // que se anuncia): entram como automação -> genérica
  'firecrawl', 'browserless', 'browserbase', 'scrapingbee', 'zenrows', 'oxylabs',
  'brightdata', 'apify', 'scraperapi', 'serpapi', 'scrapegraphai', 'jinareader',
  'webz.io', 'meltwater', 'brandwatch', 'talkwalker', 'onclusive', 'newswhip',
  'dataminr', 'parsera',
];

// ---------- utilidades -------------------------------------------------------
export const norm = (s) => String(s || '').toLowerCase().trim();
// base64url SEM Buffer (Deno/edge não têm Buffer por padrão)
export const b64url = (bytes) => {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (const b of u8) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
// atalho async para hash curto (usado no nonce do clique / keys de KV)
export const hashCurtoSeguro = (s, n = 20) => sha256b64(s, n);

// Normaliza a UA por FAMÍLIA+ENGINE+versão (ignora o app: o MESMO aparelho manda
// UA completa no app e UA encurtada em parte das requisições — FP real medido).
export function normalizaUA(ua) {
  const s = norm(ua);
  const fam = /iphone|ipad|ipod/.test(s) ? 'ios'
    : /android/.test(s) ? 'android'
      : /windows nt|macintosh|x11|cros/.test(s) ? 'desktop' : 'outro';
  const eng = /chrome|crios|chromium|edg/.test(s) ? 'chromium'
    : /firefox|fxios/.test(s) ? 'gecko'
      : /safari/.test(s) ? 'webkit' : 'outro';
  const ver = (s.match(/chrome\/(\d+)/) || s.match(/version\/(\d+)/) || s.match(/firefox\/(\d+)/) || [])[1] || '';
  return `${fam}|${eng}|${ver}`;
}

// Prefixo de rede: /24 no IPv4 (tolera troca de IP dentro da mesma faixa —
// CGNAT móvel troca o último octeto no meio da sessão) e /64 no IPv6.
export function prefixoIP(ip) {
  // IPv6 é case-insensitive: normaliza para minúsculo antes de tirar o prefixo
  // (senão "2804:14D::" e "2804:14d::" viram assinaturas diferentes no token).
  // (12ª rodada) e zeros à esquerda também são equivalentes em IPv6
  // ("2804:014d::" = "2804:14d::") — sem isso o MESMO aparelho perdia o token
  // quando um proxy/provedor reescrevia o endereço com zeros.
  const s = String(ip || '').trim().toLowerCase();
  // IPv4-mapeado em IPv6 (::ffff:1.2.3.4) conta como IPv4 (/24)
  const mapeado = s.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  if (mapeado) {
    const p = mapeado[1].split('.');
    return `${p[0]}.${p[1]}.${p[2]}`;
  }
  // Mesma ideia para a forma hexadecimal (::ffff:0102:0304).
  const mapeadoHex = s.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (mapeadoHex) {
    const alto = parseInt(mapeadoHex[1], 16);
    const baixo = parseInt(mapeadoHex[2], 16);
    return `${alto >> 8}.${alto & 255}.${baixo >> 8}`;
  }
  if (s.includes(':')) {
    const grupos = ipv6Grupos(s);
    if (!grupos) return s;
    return grupos.slice(0, 4).map((g) => (g.replace(/^0+/, '') || '0')).join(':');
  }
  const p = s.split('.');
  return p.length === 4 ? `${p[0]}.${p[1]}.${p[2]}` : s;
}

// IPv6 textual -> 8 grupos hex canônicos (aceita ::, zona, brackets e IPv4 embutido).
function ipv6Grupos(entrada) {
  let s = String(entrada || '').trim().toLowerCase();
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  const zona = s.indexOf('%');
  if (zona !== -1) s = s.slice(0, zona);
  if (!s.includes(':')) return null;
  if (s.includes('.')) {
    const i = s.lastIndexOf(':');
    const v4 = s.slice(i + 1).split('.').map(Number);
    if (v4.length !== 4 || v4.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    s = `${s.slice(0, i + 1)}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const partes = s.split('::');
  if (partes.length > 2) return null;
  const esq = partes[0] ? partes[0].split(':') : [];
  const dir = partes.length === 2 ? (partes[1] ? partes[1].split(':') : []) : [];
  let grupos;
  if (partes.length === 1) {
    grupos = esq;
  } else {
    const faltam = 8 - esq.length - dir.length;
    if (faltam < 1) return null;
    grupos = [...esq, ...Array(faltam).fill('0'), ...dir];
  }
  if (grupos.length !== 8) return null;
  for (const g of grupos) if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
  return grupos;
}

// ============================================================================
// (36ª rodada — CASO DO CRAWLER DA META) FAIXAS ESTÁTICAS DE CRAWLER
// ----------------------------------------------------------------------------
// Evidência (base histórica de 42.067 eventos, deploys antigos — serve como
// ASSINATURA DE COMPORTAMENTO do crawler, não como tráfego atual): a faixa
// **66.220.144.0/21** (Meta, AS32934) gerou 180 eventos / 45 IPs com UAs que
// IMITAM NAVEGADOR — X11 Chrome, Windows Chrome, iPhone "iOS 26.6.1" (inexistente),
// Instagram "443" (inexistente), FB4A, Samsung… **nenhum** com token de robô no UA —
// e disparou ViewContent/InitiateCheckout. Só o ASN/faixa pega isso.
//
// O ASN vem de DoH; se o DoH falhar, esse tráfego caía no fluxo normal (um UA de
// Chrome perfeito poderia receber a LP). `ipEmCidr()` roda ANTES do DoH e resolve
// na hora. Ajustável/desligável por env `CAPA_CRAWLER_CIDRS` (vazio ou `off` = não usa).
// ============================================================================
export const CRAWLER_CIDRS_DEFAULT = '66.220.144.0/21,173.252.64.0/18,69.171.224.0/19,69.63.176.0/20';
export function ipEmCidr(ip, cidr) {
  const s = String(ip || '').trim();
  const partes = String(cidr || '').trim().split('/');
  if (partes.length !== 2) return false;
  const rede = partes[0];
  const bits = Number(partes[1]);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const paraInt = (v) => {
    const p = String(v).trim().split('.');
    if (p.length !== 4) return null;
    let n = 0;
    for (const oct of p) {
      const x = Number(oct);
      if (!Number.isInteger(x) || x < 0 || x > 255) return null;
      n = (n * 256) + x;
    }
    return n >>> 0;
  };
  const a = paraInt(s);
  const b = paraInt(rede);
  if (a === null || b === null) return false;
  if (bits === 0) return true;
  const mascara = (0xFFFFFFFF << (32 - bits)) >>> 0;
  return ((a & mascara) >>> 0) === ((b & mascara) >>> 0);
}
export const ipEmAlgumCidr = (ip, lista) => (lista || []).some((c) => ipEmCidr(ip, c));

// ---------- ad param ---------------------------------------------------------
// (38ª rodada — CORREÇÃO PRIORITÁRIA DO DONO) `CAPA_AD_PARAMS_ONLY=on`:
// SOMENTE os parâmetros do dono (CAPA_AD_PARAMS) abrem a LP. `fbclid`/`gclid`/
// `utm_*`/`ttclid` deixam de ser chave e passam a ser só reforço de tracking.
export function temParamDono(sp, params = []) {
  const nomes = new Set((params || []).map(norm));
  if (!nomes.size) return false;
  for (const k of sp.keys()) if (nomes.has(norm(k))) return true;
  return false;
}

export function temAdParam(sp, extras = []) {
  const nomes = new Set([...extras.map(norm)]);
  for (const k of sp.keys()) if (nomes.has(norm(k))) return true;
  const embutidos = ['fbclid', 'gclid', 'gbraid', 'wbraid', 'msclkid', 'ttclid', 'twclid', 'li_fat_id'];
  for (const k of sp.keys()) {
    const kk = norm(k);
    if (embutidos.includes(kk) || kk.startsWith('utm_')) return true;
  }
  return false;
}

// ---------- perfil de navegador (a regra nova) -------------------------------
// Objetivo: "bot com UA de Chrome mas sem os headers que o Chrome real manda"
// NÃO recebe a LP. Mobile/in-app é mais tolerante (webview de app reduz headers).
export function perfilNavegador(ua, headers = {}) {
  const s = norm(ua);
  // chaves normalizadas para minúsculas: o núcleo pode receber um objeto simples
  // (fora do handler, onde os Headers do Fetch já vêm minúsculos)
  const h = {};
  for (const [k, v] of Object.entries(headers || {})) h[String(k).toLowerCase()] = v;
  const g = (k) => norm(h[k] ?? '');
  const acceptLang = g('accept-language');
  const secFetch = g('sec-fetch-mode') || g('sec-fetch-dest') || g('sec-fetch-site');
  const chUa = g('sec-ch-ua') || g('sec-ch-ua-platform');
  const ehChromium = /chrome|crios|chromium|edg/.test(s) && !/fxios/.test(s);
  const ehMobile = /android|iphone|ipad|mobile/.test(s);
  const ehApp = /fb_iab|fban\/|fbav|instagram|; wv\)/.test(s);

  if (!ehChromium) return { plausivel: true, motivo: 'nao_chromium' }; // Firefox/Safari têm outras regras
  // (15ª rodada) A tolerância de mobile/webview vem ANTES da exigência de
  // `accept-language`: webview de app e proxy de operadora cortam esse header com
  // frequência — e era falso positivo real (pessoa com param caindo na genérica).
  // Mas tolerância NÃO é "nenhum header": request com ZERO sinal de navegador
  // (só o UA) continua implausível, senão qualquer cliente cru passaria.
  if (ehApp || ehMobile) {
    const temSinal = Boolean(acceptLang || secFetch || chUa || g('accept') || g('accept-encoding'));
    return temSinal
      ? { plausivel: true, motivo: 'mobile_app_tolerante' }
      : { plausivel: false, motivo: 'mobile_sem_headers' };
  }
  if (!acceptLang) return { plausivel: false, motivo: 'sem_accept_language' };
  // (17ª rodada — COMPATIBILIDADE) As exigências valem para a versão que JÁ tem o header:
  //   * `Sec-Fetch-*` chegou no Chromium **76**;
  //   * `sec-ch-ua` chegou no Chromium **89**.
  // Exigir de um Chrome 60/75/80 real mandava gente de navegador antigo para a genérica.
  // Versão desconhecida continua exigindo tudo (é o "Chrome falso" que o dono quer barrar).
  const verChromium = Number((s.match(/(?:chrome|crios|chromium|edg)\/(\d+)/) || [])[1] || 0);
  const exigeSecFetch = verChromium === 0 || verChromium >= 76;
  const exigeHints = verChromium === 0 || verChromium >= 89;
  if (exigeSecFetch && !secFetch) return { plausivel: false, motivo: 'desktop_sem_sec_fetch' };
  if (exigeHints && !chUa) return { plausivel: false, motivo: 'desktop_sem_client_hints' };
  return { plausivel: true, motivo: 'desktop_completo' };
}

// ---------- token ------------------------------------------------------------
// Auto-contido (HMAC) — o edge valida sem consultar banco. Preso a UA normalizado
// + prefixo de IP + expiração. Curto de propósito (~60 chars).
export async function emitirToken(segredo, { ip, ua, expMs, agora = Date.now() }) {
  const id = b64url(crypto.getRandomValues(new Uint8Array(10)));     // 80 bits
  const exp = agora + expMs;
  const uaH = await sha256b64(normalizaUA(ua), 16);
  const ipH = await sha256b64(prefixoIP(ip), 12);
  const corpo = `${id}.${exp}.${uaH}.${ipH}`;
  const mac = await hmacb64(segredo, corpo, 22);
  return { token: `${corpo}.${mac}`, uaH, ipH, exp, id };
}

// (35ª rodada) NÚCLEO ÚNICO de validação — `prefixo` isola DOMÍNIOS de MAC diferentes
// (o cookie longo `lp_r` não pode ser reutilizado como `lp_t` nem vice-versa) e `tetoMs`
// limita a validade máxima aceita.
async function validarTokenCom(segredo, token, { ip, ua, agora = Date.now(), prefixo = '', tetoMs = 25 * 60 * 60 * 1000 }) {
  const partes = String(token || '').split('.');
  if (partes.length !== 5) return { ok: false, motivo: 'malformado' };
  const [id, exp, uaH, ipH, mac] = partes;
  // (9ª rodada) DEFESA EM PROFUNDIDADE: `Number(exp) < agora` era FALSO para
  // "NaN"/"Infinity"/"1e999" — um token MINTADO com exp quebrado (env ou erro de
  // código) nunca expiraria. Agora o exp tem de ser finito e positivo.
  const expNum = Number(exp);
  if (!Number.isFinite(expNum) || expNum <= 0) return { ok: false, motivo: 'exp_invalido' };
  // (30ª rodada — LAB DE ADVERSÁRIO) TETO DE VALIDADE: o TTL máximo configurável é 24 h
  // (`clampTtlMin`), então um token com exp MUITO à frente só pode vir de mintagem errada
  // (TTL gigante) ou de quem tem o segredo. Recusar acima de 25 h é defesa em profundidade
  // e não afeta token legítimo nenhum (folga de 1 h para relógio entre isolates).
  if (expNum - agora > tetoMs) return { ok: false, motivo: 'exp_longe_demais' };
  const esperado = await hmacb64(segredo, `${prefixo}${id}.${exp}.${uaH}.${ipH}`, 22);
  if (mac !== esperado) return { ok: false, motivo: 'assinatura' };
  if (expNum < agora) return { ok: false, motivo: 'expirado' };
  const uaAtual = await sha256b64(normalizaUA(ua), 16);
  const ipAtual = await sha256b64(prefixoIP(ip), 12);
  if (uaAtual !== uaH) return { ok: false, motivo: 'ua_divergente' };
  if (ipAtual !== ipH) return { ok: false, motivo: 'ip_divergente' };
  return { ok: true, motivo: 'ok', id };
}

export const validarToken = (segredo, token, opts = {}) => validarTokenCom(segredo, token, opts);

// ============================================================================
// (35ª rodada — CRÍTICO) COOKIE LONGO `lp_r`
// ----------------------------------------------------------------------------
// Motivo medido em produção: quem entrava com o parâmetro e depois recarregava uma
// rota interna (Ctrl+F5) — ou perdia o cookie curto (`lp_t`, 25 min / F12 "Clear
// storage") — caía na GENÉRICA. A pessoa aprovada era expulsa no meio da sessão.
//
// `lp_r` é a MESMA cripto do token, com DOMÍNIO DE MAC separado (`r|`) e validade
// longa (12 h por default, `CAPA_TOKEN_LONGO_H`). Propriedades de segurança:
//   * não é forjável (HMAC com o segredo forte do servidor);
//   * é preso ao UA normalizado + prefixo de IP (/24 IPv4, /64 IPv6) — copiar o
//     cookie para outro aparelho/IP não vale;
//   * NÃO pode ser usado como `lp_t` e vice-versa (MAC de domínio diferente);
//   * NUNCA sobrepõe decisão de crawler/automação/geo/rate-limit — é usada apenas
//     quando a única razão para a genérica era "sem ad param".
// ============================================================================
export async function emitirTokenLongo(segredo, { ip, ua, expMs, agora = Date.now() }) {
  const id = b64url(crypto.getRandomValues(new Uint8Array(10)));
  const exp = agora + expMs;
  const uaH = await sha256b64(normalizaUA(ua), 16);
  const ipH = await sha256b64(prefixoIP(ip), 12);
  const corpo = `${id}.${exp}.${uaH}.${ipH}`;
  const mac = await hmacb64(segredo, `r|${corpo}`, 22);
  return { token: `${corpo}.${mac}`, uaH, ipH, exp, id };
}
export const validarTokenLongo = (segredo, token, opts = {}) =>
  validarTokenCom(segredo, token, { ...opts, prefixo: 'r|', tetoMs: 73 * 60 * 60 * 1000 });

// ---------- assinatura do LOG (capa -> Vercel) --------------------------------
export async function assinarLog(segredo, ts, corpo) {
  return hmacb64(segredo, `${ts}.${corpo}`, 43);
}

// ============================================================================
// (FASE 1 — ARQUITETURAOF.MD §8) INJETOR DE LOCALSTORAGE
// ----------------------------------------------------------------------------
// O servidor NÃO lê localStorage: o injetor é quem devolve o token por ?t=
// quando o cookie foi bloqueado. Dois modos:
//   * inline  — 2 scripts no HTML (modo A, funciona quando a CSP permite inline)
//   * arquivo — <meta name="lp-t"> + <script src="/capa-token.js"> (modo B,
//               para CSP estrita que libera 'self' na script-src)
// Com CSP de NONCE: a capa gera um nonce, adiciona na CSP e usa na tag.
// ============================================================================

// Conteúdo do arquivo servido em CAPA_JS_PATH (lê o meta, guarda e faz o bootstrap).
// É a MESMA string copiada em frontnetlify/capa-token.js (o teste garante que não
// divirjam). Sem segredo nenhum dentro.
export const TOKEN_INJECTOR_JS = String.raw`(function(){
  try{
    var KEY='lp_t';
    var m=document.querySelector('meta[name="lp-t"]');
    var t=(m&&m.getAttribute('content'))||'';
    if(!t) return;
    try{ localStorage.setItem(KEY,t); }catch(e){}
    var temCookie=/(?:^|;\s*)lp_t=/.test(document.cookie||'');
    if(!temCookie && !/[?&]t=/.test(location.search)){
      var u=new URL(location.href);
      u.searchParams.set('t',t);
      location.replace(u.toString());
    }
  }catch(e){}
})();`;

// Decide o modo de injeção a partir da CSP (ou do que o dono forçou na env).
// Devolve { modo: 'inline'|'arquivo'|'off', nonce: boolean }.
export function escolherModoInjecao(csp, config = 'auto') {
  const cfg = String(config || 'auto').trim().toLowerCase();
  if (cfg === 'inline' || cfg === 'arquivo' || cfg === 'off') return { modo: cfg, nonce: false };
  const c = String(csp || '');
  if (!c) return { modo: 'inline', nonce: false };                       // sem CSP: inline
  const diretiva = c.split(';').map((s) => s.trim())
    .find((s) => /^script-src(-elem)?\b/i.test(s)) || '';
  if (!diretiva) {
    // (14ª rodada) CSP SEM script-src ainda pode reger scripts pelo `default-src`:
    // `default-src 'self'` BLOQUEIA inline — escolher inline ali só perdia o carrier
    // do localStorage em silêncio. Sem 'unsafe-inline' no default-src, vai de arquivo.
    const padrao = c.split(';').map((s) => s.trim()).find((s) => /^default-src\b/i.test(s)) || '';
    if (padrao && !/'unsafe-inline'/i.test(padrao)) return { modo: 'arquivo', nonce: false };
    return { modo: 'inline', nonce: false };                             // CSP sem script-src nem default-src
  }
  if (/'unsafe-inline'/i.test(diretiva)) return { modo: 'inline', nonce: false };
  if (/'nonce-/i.test(diretiva)) return { modo: 'inline', nonce: true }; // nonce: inline liberado
  return { modo: 'arquivo', nonce: false };                              // ex.: 'self'
}

// Adiciona o nosso nonce na script-src (e script-src-elem, se existir).
export function injetarNonceNaCSP(csp, nonce) {
  const c = String(csp || '');
  if (!c || !nonce) return c;
  const token = `'nonce-${nonce}'`;
  let achouScript = false;
  let achouElem = false;
  const partes = c.split(';').map((bruta) => {
    const s = bruta.trim();
    if (/^script-src\b/i.test(s)) { achouScript = true; return `${s} ${token}`; }
    if (/^script-src-elem\b/i.test(s)) { achouElem = true; return `${s} ${token}`; }
    return bruta;
  });
  if (achouScript && !achouElem) {
    // script-src-elem, quando ausente, herda da script-src — nada a fazer
  }
  return partes.join(';');
}

// Gera um nonce com EXATAMENTE 16 caracteres alfanuméricos (para o header CSP).
// (bug antigo: base64url podia conter "-"/"_" e o filtro encolhia o nonce)
const ALFANUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
export function gerarNonce() {
  const b = crypto.getRandomValues(new Uint8Array(16));
  let s = '';
  for (const x of b) s += ALFANUM[x % ALFANUM.length];
  return s; // 16 chars, ~95 bits de entropia
}

// Monta o HTML da injeção (função PURA: dá para testar sem edge).
// (14ª rodada) O token é SEMPRE gerado por nós (base64url + pontos), mas a interpolação
// passa a ser escapada: se um dia ele vier de outra fonte (env/erro), não vira XSS na LP.
const escaparTokenInline = (t) => String(t ?? '')
  .replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/</g, '\\x3C')
  .replace(/[\r\n\u2028\u2029]/g, '');
const escaparTokenAtributo = (t) => String(t ?? '')
  .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export function montarInjecaoHtml({ modo, token, jsPath = '/capa-token.js', nonce = '' } = {}) {
  if (!token || !modo || modo === 'off') return '';
  const n = nonce ? ` nonce="${nonce}"` : '';
  if (modo === 'arquivo') {
    return `<meta name="lp-t" content="${escaparTokenAtributo(token)}"><script src="${jsPath}" defer${n}></script>`;
  }
  const guarda = `<script${n}>try{localStorage.setItem('lp_t','${escaparTokenInline(token)}')}catch(e){}</script>`;
  const bootstrap = `<script${n}>(function(){try{if(!document.cookie.includes('lp_t')&&localStorage.getItem('lp_t')&&!location.search.includes('t=')){var u=new URL(location.href);u.searchParams.set('t',localStorage.getItem('lp_t'));location.replace(u.toString());}}catch(e){}})();</script>`;
  return guarda + bootstrap;
}
export async function conferirLog(segredo, ts, corpo, assinatura, janelaSeg = 180) {
  const agora = Math.floor(Date.now() / 1000);
  if (Math.abs(agora - Number(ts)) > janelaSeg) return { ok: false, motivo: 'ts_fora_da_janela' };
  const esperado = await assinarLog(segredo, ts, corpo);
  return { ok: esperado === String(assinatura || ''), motivo: esperado === assinatura ? 'ok' : 'assinatura' };
}

// ---------- hashing (WebCrypto: funciona em Deno, edge e Node) ---------------
// (14ª rodada — LEVEZA) CACHE DE DIGEST: o UA normalizado e o prefixo de IP (e o id do
// clique) repetem MUITO dentro do mesmo isolate. Memoizar corta a maior parte do custo
// de crypto por request (medido: digests+HMAC eram ~97% das etapas de CPU). O HMAC não
// entra no cache (a entrada muda a cada token). Limite de 1000 chaves e só chaves curtas,
// para não segurar UA gigante na memória do edge.
const cacheDigest = new Map();
export const cacheDigestTamanho = () => cacheDigest.size;
export async function sha256b64(texto, n = 16) {
  const chave = String(texto);
  const cacheavel = chave.length <= 256;
  if (cacheavel) {
    const guardado = cacheDigest.get(chave);
    if (guardado !== undefined) return guardado.slice(0, n);
  }
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(chave));
  const completo = b64url(new Uint8Array(b));
  if (cacheavel) {
    if (cacheDigest.size >= 1000) cacheDigest.delete(cacheDigest.keys().next().value);
    cacheDigest.set(chave, completo);
  }
  return completo.slice(0, n);
}
export async function hmacb64(segredo, texto, n = 43) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(String(segredo)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(String(texto)));
  return b64url(new Uint8Array(sig)).slice(0, n);
}

// ---------- decisão ----------------------------------------------------------
export const DESTINO = { CANONICA: 'canonica', GENERICA: 'generica', LP: 'lp', BLOQUEADO: 'blocked' };

export async function decidir(input, cfg) {
  const { ip = '', ua = '', asn = '', pathname = '/', busca = '', cookie = null, tokenUrl = null, headers = {}, agora = Date.now() } = input;
  const sp = new URLSearchParams(busca);
  const uaL = norm(ua);
  // (33ª rodada — PENTEST) mesmas extensões do handler: `.webmanifest/.xml/.txt/.json/.csv`
  // também são ASSETS (manifest do SPA, robots.txt, sitemap.xml). Sem isso o núcleo decidia
  // por eles e o `/manifest.webmanifest` sem param virava 302 para a genérica.
  const ehAsset = ehAssetPath(pathname);

  const out = (destino, motivo, extra = {}) => ({ destino, motivo, ...extra });

  if (ehAsset) return out(DESTINO.LP, 'asset_passa'); // assets não decidem nada

  // (28ª rodada — REGRA DO DONO) "headless e pessoas sem UA não devem ver a route-path":
  //   * headless -> já sai no passo (3) abaixo (`AUTOMATION_UA_PATTERNS`);
  //   * UA VAZIA (ou só espaços) -> GENÉRICA aqui.
  // Por que aqui e não antes: ASSETS passam no bloco acima — sem isso a renderização da LP
  // quebraria quando o runtime busca um asset sem UA. Evidência da base real: 0 eventos sem
  // UA em 42.067 (ARQUITETURAOF §15-8, agora RESOLVIDO a pedido do dono).
  if (!uaL) return out(DESTINO.GENERICA, 'ua_vazia');

  // (TIER A — pedido do dono) FORMA DO UA IMPLAUSÍVEL -> GENÉRICA (default).
  // Fecha o "UA lixo" de 600 chars que abria a LP; 0 falso positivo na base real.
  if (cfg.uaEstrita !== false && ehUAImplausivel(ua)) {
    return out(DESTINO.GENERICA, 'ua_implausivel', { crawler: false, automation: true });
  }

  // (1) ASN de crawler -> CANÔNICA (não olha UA)
  if (cfg.trustAsns.length && asn && cfg.trustAsns.includes(String(asn))) {
    return out(DESTINO.CANONICA, `asn_crawler:${asn}`, { crawler: true, verified: true, bot: `asn:${asn}` });
  }
  // (1-b, 36ª rodada) FAIXA ESTÁTICA de crawler -> CANÔNICA sem depender do DoH
  // (evidência: a faixa da Meta manda UA de navegador e dispararia evento na LP)
  if (cfg.crawlerCidrs?.length && ip && ipEmAlgumCidr(ip, cfg.crawlerCidrs)) {
    return out(DESTINO.CANONICA, 'cidr_crawler', { crawler: true, verified: true, bot: 'cidr' });
  }

  // (2) UA que se declara crawler
  // (27ª rodada) token "seco" (ex.: `WhatsApp/2.x A`) conta; o MESMO token dentro de uma
  // UA de navegador completo (navegador interno do app) NÃO conta — é pessoa.
  const tokenCrawler = CRAWLER_UA_TOKENS.find((t) => uaL.includes(t)
    && !(CRAWLER_UA_SO_SEM_NAVEGADOR.has(t) && MARCADOR_NAVEGADOR.test(uaL)));
  if (tokenCrawler) {
    const verificado = cfg.trustAsns.includes(String(asn));
    return verificado
      ? out(DESTINO.CANONICA, 'crawler_verificado', { crawler: true, verified: true, bot: tokenCrawler })
      : out(DESTINO.GENERICA, 'crawler_nao_verificado', { crawler: true, verified: false, bot: tokenCrawler });
  }

  // (TIER A — pedido do dono) UA CONTRADITÓRIO (Linux/X11 + marcador de celular)
  // -> GENÉRICA (default). Antes escapava da regra Linux e recebia a LP (medido:
  // 22/22 casos, 45,1% das mutações de fuzz). Roda ANTES da regra Linux.
  if (cfg.uaEstrita !== false && ehUAContraditorio(ua)) {
    return out(DESTINO.GENERICA, 'ua_contraditoria', { crawler: false, automation: true });
  }

  // (1-c, 37ª rodada — REGRA DO DONO) LINUX/X11 -> CANÔNICA
  // Roda DEPOIS do crawler que se declara (mantém o motivo dele) e ANTES da automação,
  // do token e do param: Linux não vê a LP em hipótese nenhuma — nem com `HeadlessChrome`,
  // nem com headers completos de Chrome, nem com token válido.
  // A guarda `MARCADOR_MOBILE_RE` (dentro de `ehLinuxDesktop`) preserva Android/LG/Moto G/
  // webviews IG-FB, que continuam indo para a LP normalmente.
  if (cfg.linuxCanonica !== false && ehLinuxDesktop(uaL)) {
    return out(DESTINO.CANONICA, 'ua_linux_desktop', { crawler: false, linuxDesktop: true });
  }

  // (1-d, 37ª rodada) HEADLESS "STEALTH": UA adulterado x Client Hints reais -> GENÉRICA
  // Medido em Chrome real: o `sec-ch-ua` mantém a versão/plataforma VERDADEIRA quando o UA é
  // trocado (`--user-agent`/`setUserAgent`). Só dispara quando há contradição objetiva e o UA
  // é de desktop Chromium (celulares/apps ficam de fora). Em `CAPA_HEADERS_SHADOW=on` (default)
  // apenas registra a sombra — nenhuma pessoa sai da LP até o dono mandar.
  const inconsistencia = cfg.checarClientHints === false ? null : inconsistenciaClientHints(uaL, headers);
  if (inconsistencia) {
    // Em sombra (default) a decisão segue normal e o HANDLER registra o marcador no log.
    if (!cfg.headersShadow) return out(DESTINO.GENERICA, inconsistencia);
  }

  // (3) automação declarada
  if (AUTOMATION_UA_PATTERNS.some((t) => uaL.includes(t))) {
    return out(DESTINO.GENERICA, 'ua_automacao', { crawler: false, automation: true });
  }

  // (4) perfil de navegador implausível (NOVO — o "Chrome falso" sem headers)
  const perfil = perfilNavegador(ua, headers);
  if (!perfil.plausivel) {
    if (cfg.modoLog) return out(DESTINO.LP, `perfil_implausivel:${perfil.motivo} (sombra)`);
    return out(DESTINO.GENERICA, `perfil_implausivel:${perfil.motivo}`, { crawler: false, profile: perfil.motivo });
  }

  // (5) token em qualquer UM dos 3 carriers: cookie -> URL -> localStorage(JS)
  // (8, 38ª rodada — DECISÃO DO DONO) GEO AUSENTE -> GENÉRICA, ANTES do token/param:
  //   "sem país = genérica, independente se tem ad parâmetros ou não". Vale também para
  //   token/cookie válidos (a regra vence o token, como a regra de Linux). Crawler
  //   continua indo para a canônica (bloco acima) porque ali não há LP exposta.
  //   `paisesOk` vazio = checagem de geo desligada (nenhuma punição por dado ausente).
  //   (38ª rodada — BUG do teste) o país é normalizado UMA vez (trim + caixa): antes,
  //   " BR " passava no `toUpperCase()` mas não na comparação -> `geo_fora` indevido.
  const paisNorm = String(input.pais || '').trim().toUpperCase();
  if (cfg.paisesOk.length && !paisNorm) {
    return out(DESTINO.GENERICA, 'geo_ausente');
  }

  const token = cookie || tokenUrl || null;
  if (token) {
    const v = await validarToken(cfg.segredo, token, { ip, ua, agora });
    if (v.ok) return out(DESTINO.LP, 'token_ok', { tokenId: v.id });
    // token inválido NÃO vira bloqueio de sessão nova: segue o fluxo abaixo
    input.__tokenInvalido = v.motivo;
  }

  // (6) ad param -> GENÉRICA
  // (38ª rodada — CORREÇÃO PRIORITÁRIA DO DONO) `CAPA_AD_PARAMS_ONLY` (default `on`):
  //   SOMENTE o parâmetro do dono (CAPA_AD_PARAMS) abre a LP. `fbclid`, `gclid`, `utm_*`,
  //   `ttclid` etc. deixam de ser chave e viram apenas reforço de tracking.
  //   Motivo separado (`param_nao_autorizado`) para o dono medir nos logs quantos chegam
  //   só com parâmetro de plataforma. `off` volta ao comportamento anterior (qualquer um abre).
  if (cfg.adParamsOnly !== false) {
    if (!temParamDono(sp, cfg.adParams)) {
      return out(DESTINO.GENERICA, temAdParam(sp, cfg.adParams) ? 'param_nao_autorizado' : 'sem_ad_param');
    }
  } else if (!temAdParam(sp, cfg.adParams)) {
    return out(DESTINO.GENERICA, 'sem_ad_param');
  }

  // (7) geo fora -> GENÉRICA
  if (cfg.paisesOk.length && !cfg.paisesOk.includes(paisNorm)) {
    return out(DESTINO.GENERICA, 'geo_fora');
  }

  // (8) clique fresco? (o nonce/uso único é checado no handler, que tem KV)
  return out(DESTINO.LP, 'clique_fresco', { mintar: true, fbclid: sp.get('fbclid') || '' });
}
