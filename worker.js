// LechPlay Webshare Worker
// Cloudflare Secrets required:
//   WEBSHARE_USERNAME
//   WEBSHARE_PASSWORD
// Optional:
//   ALLOWED_ORIGIN=https://tvoje-github-pages-url

const API = "https://webshare.cz/api/";
const VIDEO_EXT = /\.(mkv|mp4|avi|mov|webm|m4v)(\.|$|\?)/i;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (request.method === "OPTIONS") return cors(json({ ok: true }), env);
      if (url.pathname === "/") return cors(json({ ok: true, name: "LechPlay Webshare API", endpoints: ["/api/status", "/api/search?q=...", "/api/resolve?ident=...", "/proxy?url=..."] }), env);
      if (url.pathname === "/api/status") return cors(json(await status(env)), env);
      if (url.pathname === "/api/search") return cors(json(await search(url.searchParams.get("q") || "", url.searchParams.get("sort") || "rating", env)), env);
      if (url.pathname === "/api/resolve") return cors(json(await resolveFile(required(url, "ident"), env)), env);
      if (url.pathname === "/proxy") return proxy(required(url, "url"), request, env);
      return cors(json({ error: true, message: "Not found" }, 404), env);
    } catch (e) {
      return cors(json({ error: true, message: e?.message || String(e) }, 500), env);
    }
  }
};

function required(url, key) { const v = url.searchParams.get(key); if (!v) throw new Error("Missing " + key); return v; }

async function status(env) {
  const username = env.WEBSHARE_USERNAME || "";
  const password = env.WEBSHARE_PASSWORD || "";
  if (!username || !password) return { loggedIn: false, hasCredentials: false, message: "Chýbajú WEBSHARE_USERNAME / WEBSHARE_PASSWORD secrets." };
  const token = await login(env);
  return { loggedIn: !!token, hasCredentials: true, username };
}

async function search(q, sort, env) {
  q = String(q || "").trim();
  if (!q) return { q, total: 0, items: [] };
  const token = await login(env);
  const xml = await postApi("search/", { what: q, sort, limit: 80, offset: 0, category: "video", wst: token });
  ensureOk(xml);
  const files = parseFiles(xml).filter(isVideoCandidate);
  const checked = await Promise.all(files.slice(0, 40).map(async f => ({ ...f, playable: await quickPlayable(f.ident, token).catch(() => false) })));
  const items = dedupeAndScore(checked.filter(f => f.playable));
  return { q, total: Number(tag(xml, "total") || items.length), items };
}

async function resolveFile(ident, env) {
  const token = await login(env);
  const xml = await postApi("file_link/", { ident, wst: token, download_type: "video_stream", force_https: 1 });
  ensureOk(xml);
  const link = tag(xml, "link");
  if (!link) throw new Error("Webshare nevrátil stream link.");
  return { ident, link };
}

async function quickPlayable(ident, token) {
  const xml = await postApi("file_link/", { ident, wst: token, download_type: "video_stream", force_https: 1 });
  if (tag(xml, "status") !== "OK") return false;
  const link = tag(xml, "link");
  if (!link) return false;
  const res = await fetch(link, { method: "GET", headers: { Range: "bytes=0-1", "user-agent": UA } });
  const ct = res.headers.get("content-type") || "";
  return (res.status === 200 || res.status === 206) && (/video|octet-stream|application\/vnd\.apple\.mpegurl/i.test(ct) || true);
}

async function proxy(target, request, env) {
  const u = new URL(target);
  if (!/^https?:$/.test(u.protocol)) throw new Error("Nepovolený protokol.");
  const headers = new Headers();
  headers.set("user-agent", UA);
  const range = request.headers.get("range");
  if (range) headers.set("range", range);
  const upstream = await fetch(u.href, { headers, redirect: "follow" });
  const h = new Headers(upstream.headers);
  h.set("access-control-allow-origin", env.ALLOWED_ORIGIN || "*");
  h.set("access-control-allow-methods", "GET,HEAD,OPTIONS");
  h.set("access-control-allow-headers", "range,content-type,accept");
  h.delete("content-security-policy");
  h.delete("x-frame-options");
  return new Response(upstream.body, { status: upstream.status, headers: h });
}

async function login(env) {
  if (!env.WEBSHARE_USERNAME || !env.WEBSHARE_PASSWORD) throw new Error("Nastav Cloudflare secrets WEBSHARE_USERNAME a WEBSHARE_PASSWORD.");
  const saltXml = await postApi("salt/", { username_or_email: env.WEBSHARE_USERNAME });
  ensureOk(saltXml);
  const salt = tag(saltXml, "salt");
  const crypt = md5crypt(env.WEBSHARE_PASSWORD, salt);
  const passwordHash = await sha1Hex(crypt);
  const digest = md5Hex(strBytes(env.WEBSHARE_USERNAME + ":Webshare:" + env.WEBSHARE_PASSWORD));
  const loginXml = await postApi("login/", { username_or_email: env.WEBSHARE_USERNAME, password: passwordHash, digest, keep_logged_in: 1 });
  ensureOk(loginXml);
  const token = tag(loginXml, "token");
  if (!token) throw new Error("Login OK, ale chýba token.");
  return token;
}

async function postApi(endpoint, params) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) body.set(k, String(v));
  const res = await fetch(API + endpoint.replace(/^\//, ""), { method: "POST", headers: { "accept": "text/xml; charset=UTF-8", "content-type": "application/x-www-form-urlencoded; charset=UTF-8", "x-requested-with": "XMLHttpRequest", "referer": "https://webshare.cz/" }, body: body.toString() });
  return await res.text();
}

function ensureOk(xml) { if (tag(xml, "status") !== "OK") throw new Error(tag(xml, "message") || tag(xml, "code") || "Webshare API chyba"); }
function tag(xml, name) { const m = new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`, "i").exec(xml || ""); return m ? decodeXml(m[1]) : ""; }
function decodeXml(s) { return String(s || "").replace(/&amp;/g,"&").replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&lt;/g,"<").replace(/&gt;/g,">").trim(); }
function parseFiles(xml) { const out=[]; const re=/<file>([\s\S]*?)<\/file>/gi; let m; while((m=re.exec(xml||""))){ const block=m[1]; out.push({ ident: tag(block,"ident"), name: tag(block,"name"), type: tag(block,"type"), img: absolutize(tag(block,"img")), size: Number(tag(block,"size")||0), positive_votes:Number(tag(block,"positive_votes")||0), negative_votes:Number(tag(block,"negative_votes")||0), password: tag(block,"password") }); } return out.filter(x=>x.ident&&x.name); }
function absolutize(u){ if(!u) return ""; try { return new URL(u, "https://webshare.cz/").href; } catch { return u; } }
function isVideoCandidate(f){ return String(f.type).toLowerCase()==="video" || VIDEO_EXT.test(f.name); }
function dedupeAndScore(files){ const groups=new Map(); for(const f of files){ f.quality=quality(f.name); f.score=score(f); const key=normalizeName(f.name); const prev=groups.get(key); if(!prev || f.score>prev.score) groups.set(key, { ...f, duplicates:(prev?.duplicates||0)+1 }); else prev.duplicates=(prev.duplicates||1)+1; } return Array.from(groups.values()).sort((a,b)=>b.score-a.score).slice(0,60); }
function normalizeName(name){ return String(name||"").toLowerCase().replace(/\.(mkv|mp4|avi|mov|webm|m4v)$/i,"").replace(/\b(2160p|1080p|720p|4k|uhd|bluray|bdrip|web-dl|webrip|hdrip|x264|x265|h264|h265|hevc|aac|dts|cz|sk|dabing|titulky|subs?)\b/gi," ").replace(/[^a-z0-9áäčďéíĺľňóôŕšťúýž]+/gi," ").trim(); }
function quality(n){ n=String(n||"").toLowerCase(); if(/2160p|4k|uhd/.test(n)) return "4K"; if(/1080p/.test(n)) return "1080p"; if(/720p/.test(n)) return "720p"; return "video"; }
function score(f){ const n=String(f.name||"").toLowerCase(); let s=0; if(/2160p|4k|uhd/.test(n)) s+=40; if(/1080p/.test(n)) s+=32; if(/720p/.test(n)) s+=20; if(/web-dl|bluray|bdrip/.test(n)) s+=15; if(/webrip|hdrip/.test(n)) s+=8; if(/cz|sk|dabing/.test(n)) s+=18; if(/titulky|subs?/.test(n)) s+=7; const gb=Number(f.size||0)/1024/1024/1024; if(gb>.5&&gb<18)s+=10; if(gb>30)s-=25; s += Math.min(20, Math.max(0, (f.positive_votes||0)-(f.negative_votes||0))); if(f.password==="1") s-=80; return s; }

function json(data, status=200){ return new Response(JSON.stringify(data), { status, headers: { "content-type":"application/json; charset=utf-8" } }); }
function cors(resp, env){ const h=new Headers(resp.headers); h.set("access-control-allow-origin", env?.ALLOWED_ORIGIN || "*"); h.set("access-control-allow-methods","GET,POST,OPTIONS"); h.set("access-control-allow-headers","content-type,accept,range"); return new Response(resp.body,{status:resp.status,headers:h}); }
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36";

async function sha1Hex(s){ const buf=await crypto.subtle.digest("SHA-1", new TextEncoder().encode(s)); return [...new Uint8Array(buf)].map(b=>b.toString(16).padStart(2,"0")).join(""); }
function strBytes(s){ return Array.from(new TextEncoder().encode(String(s))); }
function md5Hex(bytes){ return [...md5Bytes(bytes)].map(b=>b.toString(16).padStart(2,"0")).join(""); }
function md5crypt(password, salt){ const magic="$1$"; password=String(password); salt=String(salt||"").replace(/^\$1\$/,"").split("$")[0].slice(0,8); const pw=strBytes(password), sb=strBytes(salt), mb=strBytes(magic); let ctx=[...pw,...mb,...sb]; const alt=md5Bytes([...pw,...sb,...pw]); for(let i=pw.length;i>0;i-=16) ctx.push(...alt.slice(0,Math.min(16,i))); for(let i=pw.length;i>0;i>>=1) ctx.push(...((i&1)?[0]:[pw[0]])); let final=md5Bytes(ctx); for(let i=0;i<1000;i++){ let c=[]; if(i&1)c.push(...pw);else c.push(...final); if(i%3)c.push(...sb); if(i%7)c.push(...pw); if(i&1)c.push(...final);else c.push(...pw); final=md5Bytes(c); } const itoa="./0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"; const to64=(v,n)=>{let r=""; while(n--){r+=itoa[v&0x3f]; v>>=6;} return r}; const f=final; let out=""; out+=to64((f[0]<<16)|(f[6]<<8)|f[12],4); out+=to64((f[1]<<16)|(f[7]<<8)|f[13],4); out+=to64((f[2]<<16)|(f[8]<<8)|f[14],4); out+=to64((f[3]<<16)|(f[9]<<8)|f[15],4); out+=to64((f[4]<<16)|(f[10]<<8)|f[5],4); out+=to64(f[11],2); return magic+salt+"$"+out; }
function md5Bytes(bytes){ bytes=bytes.slice(); const origLen=bytes.length*8; bytes.push(0x80); while(bytes.length%64!==56)bytes.push(0); for(let i=0;i<8;i++)bytes.push((origLen/(2**(8*i)))&255); let a0=0x67452301,b0=0xefcdab89,c0=0x98badcfe,d0=0x10325476; const K=Array.from({length:64},(_,i)=>Math.floor(Math.abs(Math.sin(i+1))*2**32)>>>0); const S=[7,12,17,22,7,12,17,22,7,12,17,22,7,12,17,22,5,9,14,20,5,9,14,20,5,9,14,20,5,9,14,20,4,11,16,23,4,11,16,23,4,11,16,23,4,11,16,23,6,10,15,21,6,10,15,21,6,10,15,21,6,10,15,21]; for(let off=0;off<bytes.length;off+=64){ const M=[]; for(let i=0;i<16;i++)M[i]=(bytes[off+4*i]|(bytes[off+4*i+1]<<8)|(bytes[off+4*i+2]<<16)|(bytes[off+4*i+3]<<24))>>>0; let A=a0,B=b0,C=c0,D=d0; for(let i=0;i<64;i++){ let F,g; if(i<16){F=(B&C)|((~B)&D);g=i}else if(i<32){F=(D&B)|((~D)&C);g=(5*i+1)%16}else if(i<48){F=B^C^D;g=(3*i+5)%16}else{F=C^(B|(~D));g=(7*i)%16} const tmp=D; D=C; C=B; const x=(A+F+K[i]+M[g])>>>0; B=(B+rotl(x,S[i]))>>>0; A=tmp; } a0=(a0+A)>>>0;b0=(b0+B)>>>0;c0=(c0+C)>>>0;d0=(d0+D)>>>0; } const out=[]; for(const n of [a0,b0,c0,d0]) for(let i=0;i<4;i++) out.push((n>>>(8*i))&255); return out; }
function rotl(x,c){ return ((x<<c)|(x>>>(32-c)))>>>0; }
