// ============================================================================
// capa-token.js — injetor de localStorage (MODO B / CSP estrita).
// Quem serve este arquivo é a PRÓPRIA CAPA (Edge Function), na mesma origem,
// no caminho configurado em CAPA_JS_PATH (default: /capa-token.js).
// Ele lê o <meta name="lp-t"> injetado pela capa, guarda o token no localStorage
// e, se o cookie estiver bloqueado, devolve o token pela URL (?t=) UMA vez.
// NENHUM segredo aqui dentro — só lógica. (X03 do ARQUITETURAOF.MD)
// A versão em execução é a constante TOKEN_INJECTOR_JS (lib/capa-core.js);
// o teste _pesquisa/teste-csp.mjs garante que as duas não divirjam.
// ============================================================================
(function(){
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
})();
