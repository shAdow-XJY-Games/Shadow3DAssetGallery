import {validateCatalog} from './core.mjs';
// v2 contains metadata only. Content-addressed same-origin paths prevent mixed deployments.
export const METADATA_LIMIT=262144, METADATA_TOTAL_LIMIT=1048576, MAX_METADATA_SHARDS=256;
export function validateCatalogIndex(c){
 if(c?.schemaVersion===1)return validateCatalog(c);
 if(c?.schemaVersion!==2||!Array.isArray(c.shards)||c.shards.length>MAX_METADATA_SHARDS||!Number.isSafeInteger(c.assetCount)||c.assetCount<0)throw Error('Invalid catalog index');
 validateCatalog({...c,schemaVersion:1,assets:[]});
 const indexBytes=new TextEncoder().encode(JSON.stringify(c)).length;if(indexBytes>METADATA_LIMIT)throw Error('Catalog index budget exceeded');
 const paths=new Set();let count=0,bytes=indexBytes;
 for(const s of c.shards){if(!s||typeof s.theme!=='string'||!s.theme.trim()||!Number.isSafeInteger(s.count)||s.count<1||!Number.isSafeInteger(s.size)||s.size<1||s.size>METADATA_LIMIT||!/^[a-f0-9]{64}$/.test(s.sha256)||s.path!==`metadata/${s.sha256}.json`||paths.has(s.path))throw Error('Invalid metadata shard');paths.add(s.path);count+=s.count;bytes+=s.size;if(bytes>METADATA_TOTAL_LIMIT)throw Error('Aggregate metadata budget exceeded');}
 if(count!==c.assetCount)throw Error('Catalog count mismatch');return c;
}
export function validateMetadataShard(index,descriptor,payload){
 if(payload?.schemaVersion!==2||payload.theme!==descriptor.theme||!Array.isArray(payload.assets)||payload.assets.length!==descriptor.count||payload.assets.some(a=>a?.theme!==descriptor.theme))throw Error('Metadata shard mismatch');
 // Sources are owned exclusively by the index; shard content cannot replace them.
 return validateCatalog({...index,schemaVersion:1,assets:payload.assets}).assets;
}
export function createCatalogStore(input,{fetcher=fetch,cryptoProvider=globalThis.crypto,timeoutMs=30000}={}){
 const index=validateCatalogIndex(input),cache=new Map();
 const total=index.schemaVersion===1?index.assets.length:index.assetCount;
 return {index,total,async load({theme='',signal}={}){
 signal?.throwIfAborted();validateCatalogIndex(index);
 if(index.schemaVersion===1)return {...index,assets:index.assets.filter(a=>!theme||a.theme===theme)};
 const required=index.shards.filter(s=>!theme||s.theme===theme), timeout=AbortSignal.timeout(timeoutMs), group=new AbortController(), combined=AbortSignal.any([group.signal,timeout,...(signal?[signal]:[])]);
 // Stage a query atomically: failures/cancellation never expose partial global results.
 const staged=new Map();let cursor=0;
 try{await Promise.all(Array.from({length:Math.min(4,required.length)},async()=>{while(cursor<required.length){combined.throwIfAborted();const s=required[cursor++];if(cache.has(s.path)){staged.set(s.path,cache.get(s.path));continue;}
 const bytes=await fetchVerifiedMetadata(s,{signal:combined,fetcher,cryptoProvider});
 const assets=validateMetadataShard(index,s,JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)));staged.set(s.path,assets);
 }}));}catch(error){group.abort();throw error;}combined.throwIfAborted();
 const seen=new Set();for(const s of index.shards){const assets=staged.get(s.path)||cache.get(s.path)||[];for(const a of assets){if(seen.has(a.id))throw Error('Duplicate ID across metadata shards');seen.add(a.id);}}
 for(const [path,assets]of staged)cache.set(path,assets);
 return {...index,schemaVersion:1,assets:required.flatMap(s=>cache.get(s.path))};
 }};
}

// Fetch bodies are already decoded by the browser. Compressed Content-Length is not JSON size.
async function readMetadataBytes(response,{limit,exactSize,signal}){
 const encoding=(response.headers.get('content-encoding')||'identity').trim().toLowerCase(),declared=response.headers.get('content-length');
 if(encoding==='identity'&&declared!==null&&(Number(declared)>limit||(exactSize!==undefined&&Number(declared)!==exactSize)))throw Error('Metadata length mismatch');
 if(!response.body)throw Error('Metadata body unavailable');const reader=response.body.getReader(),chunks=[];let length=0;
 const cancel=()=>{reader.cancel(signal.reason).catch(()=>{});};signal.addEventListener('abort',cancel,{once:true});
 try{while(true){signal.throwIfAborted();const {done,value}=await reader.read();signal.throwIfAborted();if(done)break;length+=value.byteLength;if(length>limit)throw Error('Metadata exceeds expected size');chunks.push(value);}}catch(error){await reader.cancel().catch(()=>{});throw error;}finally{signal.removeEventListener('abort',cancel);reader.releaseLock();}
 signal.throwIfAborted();if(exactSize!==undefined&&length!==exactSize)throw Error('Metadata length mismatch');const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}return bytes;
}
export async function fetchVerifiedMetadata(file,{signal,fetcher=fetch,cryptoProvider=globalThis.crypto}={}){
 if(!Number.isSafeInteger(file.size)||file.size<1||file.size>METADATA_LIMIT||!/^[a-f0-9]{64}$/.test(file.sha256)||file.path!==`metadata/${file.sha256}.json`)throw Error('Invalid metadata descriptor');
 const combined=signal?AbortSignal.any([signal,AbortSignal.timeout(30000)]):AbortSignal.timeout(30000);combined.throwIfAborted();
 const response=await fetcher('./'+file.path,{mode:'cors',credentials:'omit',redirect:'error',signal:combined});
 if(!response.ok)throw Error(`Metadata HTTP ${response.status}`);
 const bytes=await readMetadataBytes(response,{limit:file.size,exactSize:file.size,signal:combined});
 if(!cryptoProvider?.subtle)throw Error('SHA-256 requires a secure context');const digest=await cryptoProvider.subtle.digest('SHA-256',bytes);combined.throwIfAborted();const hash=Array.from(new Uint8Array(digest),v=>v.toString(16).padStart(2,'0')).join('');if(hash!==file.sha256)throw Error('Metadata SHA-256 mismatch');return bytes.buffer;
}
export async function fetchCatalogEntry({signal,fetcher=fetch,timeoutMs=30000}={}){
 const controller=new AbortController(),combined=AbortSignal.any([controller.signal,AbortSignal.timeout(timeoutMs),...(signal?[signal]:[])]),options={mode:'cors',credentials:'omit',redirect:'error',signal:combined};
 try{combined.throwIfAborted();let response=await fetcher('./catalog-v2.json',options),legacy=false;
 if(response.status===404){await response.body?.cancel();combined.throwIfAborted();legacy=true;response=await fetcher('./catalog.json',options);}
 if(!response.ok)throw Error(`Catalog HTTP ${response.status}`);
 const bytes=await readMetadataBytes(response,{limit:METADATA_LIMIT,signal:combined});const catalog=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
 if(catalog.schemaVersion!==(legacy?1:2))throw Error('Unexpected catalog version');validateCatalogIndex(catalog);
 if(!legacy&&bytes.length+catalog.shards.reduce((n,s)=>n+s.size,0)>METADATA_TOTAL_LIMIT)throw Error('Aggregate metadata budget exceeded');return catalog;
 }catch(error){controller.abort();throw error;}
}
