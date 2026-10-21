import {METADATA_REPOSITORIES, assetSource, validateCatalog} from './core.mjs';
import {fetchCatalogEntry} from './core-catalog-v2.mjs';

// These are per-interaction limits, NOT a cap on the number of catalog assets.
export const V3 = Object.freeze({rootBytes:16384, nodeBytes:262144, targetNodeBytes:49152,
  fanout:32, leafItems:128, termLeafItems:1024, termNodeBytes:98304, inlinePostings:512, postingLeafItems:4096, pageSize:24, queryBytes:1048576, queryRequests:96,
  cacheBytes:2097152, cacheNodes:128, concurrency:4, retries:2, timeoutMs:30000,
  candidateLimit:256, seekLimit:2048, maxHeight:12, maxQueryChars:128});
export const FACETS = Object.freeze(['repository','assetKind','category','theme','style']);
const entryByteCounts=new WeakMap();
const hashPattern=/^[a-f0-9]{64}$/;
const numeric=kind=>kind==='records'||kind==='postings';
const keyOK=(key,kind)=>numeric(kind)?Number.isSafeInteger(key)&&key>=0:typeof key==='string'&&key.length<=1024;
export const normalizeQuery=query=>String(query||'').trim().toLowerCase();
export const searchText=a=>[a.id,a.title,a.description,a.category,a.theme,a.style].join(' ').toLowerCase();
export const facetKey=(field,value)=>`${field}\u0000${value}`;
export function queryGrams(text,all=false){
  const chars=Array.from(text),n=Math.min(3,chars.length),set=new Set();
  if(!n)return [];
  for(let i=0;i<=chars.length-n;i++)set.add(chars.slice(i,i+n).join(''));
  const grams=[...set];
  // A subset is a necessary condition only. Exact substring validation is mandatory.
  return all||grams.length<=8?grams:Array.from({length:8},(_,i)=>grams[Math.floor(i*(grams.length-1)/7)]);
}
export function normalizeFilters(input={}){
  const filters={query:normalizeQuery(input.query)};
  if(Array.from(filters.query).length>V3.maxQueryChars)throw Error('Search is too long');
  for(const field of FACETS){filters[field]=input[field]||'';if(typeof filters[field]!=='string'||filters[field].length>512)throw Error('Invalid filter');}
  return filters;
}
export function matchesAsset(asset,catalog,filters){
  return FACETS.every(field=>!filters[field]||(field==='repository'?assetSource(catalog,asset).repo:asset[field])===filters[field])&&(!filters.query||searchText(asset).includes(filters.query));
}
export function validatePosting(d){if(Array.isArray(d?.ids)){if(!d.ids.length||d.ids.length>V3.inlinePostings||d.count!==d.ids.length||d.min!==d.ids[0]||d.max!==d.ids.at(-1)||d.ids.some((id,i)=>!Number.isSafeInteger(id)||id<0||(i&&id<=d.ids[i-1])))throw Error('Invalid inline posting');return d;}return validateV3Descriptor(d,'postings');}
export function validateV3Descriptor(d,kind){
  if(!d||!hashPattern.test(d.sha256)||d.path!==`catalog/v3/${d.sha256.slice(0,2)}/${d.sha256}.json`||
    !Number.isSafeInteger(d.size)||d.size<1||d.size>V3.nodeBytes||!Number.isSafeInteger(d.count)||d.count<1||
    !Number.isInteger(d.height)||d.height<1||d.height>V3.maxHeight||!keyOK(d.min,kind)||!keyOK(d.max,kind)||d.min>d.max)throw Error('Invalid v3 descriptor');
  return d;
}
export function metadataURL(source,path){
  if(!source||!METADATA_REPOSITORIES.includes(`${source.owner}/${source.repo}`)||!/^[a-f0-9]{40}$/.test(source.commit)||/^0{40}$/.test(source.commit))throw Error('Unpinned metadata source');
  if(!/^catalog\/v3\/[a-f0-9]{2}\/[a-f0-9]{64}\.json$/.test(path)||path.split('/')[2]!==path.split('/')[3].slice(0,2))throw Error('Unsafe metadata path');
  return `https://raw.githubusercontent.com/${source.owner}/${source.repo}/${source.commit}/${path}`;
}
export function validateV3Root(root){
  if(!root||root.schemaVersion!==3||root.format!=='shadow-paged-catalog-1'||!hashPattern.test(root.snapshot)||
    !Number.isSafeInteger(root.assetCount)||root.assetCount<0||!root.trees||!root.collection||typeof root.collection!=='object'||
    new TextEncoder().encode(JSON.stringify(root)).length>V3.rootBytes)throw Error('Invalid v3 root');
  metadataURL(root.metadataSource,`catalog/v3/${root.snapshot.slice(0,2)}/${root.snapshot}.json`);
  if(Object.keys(root.trees).sort().join(',')!=='facets,records,sources,terms')throw Error('Invalid v3 trees');
  for(const kind of ['records','terms','facets','sources'])if(root.trees[kind]!==null)validateV3Descriptor(root.trees[kind],kind);
  if((root.trees.records?.count||0)!==root.assetCount||Boolean(root.assetCount)!==Boolean(root.trees.terms)||Boolean(root.assetCount)!==Boolean(root.trees.facets))throw Error('V3 root count mismatch');
  if(root.assetCount&&(root.trees.records.min!==0||root.trees.records.max!==root.assetCount-1))throw Error('V3 ordinal range mismatch');
  return root;
}
export function validateV3Node(node,d,kind){
  validateV3Descriptor(d,kind);
  if(!node||node.schemaVersion!==3||node.family!==kind)throw Error('V3 node family mismatch');
  if(d.height>1){
    if(node.kind!=='branch'||!Array.isArray(node.children)||node.children.length<2||node.children.length>V3.fanout)throw Error('Invalid v3 branch');
    let count=0,previous;
    for(const child of node.children){validateV3Descriptor(child,kind);if(child.height>=d.height||(previous!==undefined&&(previous>=child.min||(kind==='records'&&child.min!==previous+1))))throw Error('Invalid v3 branch ordering');count+=child.count;previous=child.max;}
    if(d.height!==Math.max(...node.children.map(child=>child.height))+1||count!==d.count||node.children[0].min!==d.min||previous!==d.max)throw Error('V3 branch range mismatch');
  }else{
    if(node.kind!=='leaf'||!Array.isArray(node.entries)||!node.entries.length||node.entries.length>(kind==='postings'?V3.postingLeafItems:kind==='terms'?V3.termLeafItems:V3.leafItems)||node.entries.length!==d.count)throw Error('Invalid v3 leaf');
    const keys=node.entries.map(entry=>kind==='postings'?entry:entry?.[0]);
    if(keys.some((key,i)=>!keyOK(key,kind)||(i&&keys[i-1]>=key))||keys[0]!==d.min||keys.at(-1)!==d.max)throw Error('V3 leaf ordering mismatch');
    if(kind==='records'){
      if(keys.some((key,i)=>i&&key!==keys[i-1]+1))throw Error('Noncontiguous v3 record page');
      validateCatalog({schemaVersion:1,source:node.source,sources:node.sources,assets:node.entries.map(entry=>entry[1])});
    }else if(kind==='terms')for(const entry of node.entries){if(entry.length!==2)throw Error('Invalid term');validatePosting(entry[1]);}
    else if(kind==='facets')for(const entry of node.entries){if(entry.length!==2||!FACETS.some(f=>entry[0].startsWith(f+'\u0000'))||!Number.isSafeInteger(entry[1])||entry[1]<1)throw Error('Invalid facet');}
    else if(kind==='sources')for(const entry of node.entries){if(entry.length!==2)throw Error('Invalid source');validateCatalog({schemaVersion:1,sources:{[entry[0]||'default']:entry[1]},assets:[]});}
  }
  return node;
}
const deepFreeze=value=>{if(value&&typeof value==='object'&&!Object.isFrozen(value)){for(const item of Object.values(value))deepFreeze(item);Object.freeze(value);}return value;};
class BudgetError extends Error {constructor(){super('Catalog query budget reached');this.name='CatalogBudgetError';}}
export function reserveQueryRequest(session,size){if(!Number.isSafeInteger(size)||size<1||size>V3.nodeBytes)throw Error('Invalid request size');if(session.bytes+size>V3.queryBytes||session.requests>=V3.queryRequests)throw new BudgetError();session.requests++;session.bytes+=size;}
const abortError=()=>new DOMException('Aborted','AbortError');
const sleep=(ms,signal)=>new Promise((resolve,reject)=>{signal.throwIfAborted();const abort=()=>{clearTimeout(timer);reject(signal.reason||abortError());};const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},ms);signal.addEventListener('abort',abort,{once:true});});
export function createPagedCatalogStore(input,{fetcher=fetch,cryptoProvider=globalThis.crypto,timeoutMs=V3.timeoutMs,retryDelayMs=100,entryBytes}={}){
  // Snapshot ownership: callers cannot change a source or descriptor after validation.
  const root=deepFreeze(validateV3Root(structuredClone(input))),cache=new Map();
  const rootBytes=Math.max(new TextEncoder().encode(JSON.stringify(root)).length,entryByteCounts.get(input)||entryBytes||V3.rootBytes);if(!Number.isSafeInteger(rootBytes)||rootBytes>V3.rootBytes)throw Error('Invalid actual root byte count');let cacheBytes=0,active=0;const waiters=[];
  const stats={requests:0,bytes:0,cacheHits:0,peakConcurrency:0};
  async function acquire(signal){
    signal.throwIfAborted();
    if(active>=V3.concurrency){if(waiters.length>=V3.queryRequests)throw Error('Catalog request queue is full');await new Promise((resolve,reject)=>{const waiter={resolve,reject,signal};const abort=()=>{const i=waiters.indexOf(waiter);if(i>=0)waiters.splice(i,1);reject(signal.reason||abortError());};waiter.abort=abort;signal.addEventListener('abort',abort,{once:true});waiters.push(waiter);});try{signal.throwIfAborted();}catch(error){release();throw error;}}else active++;
    stats.peakConcurrency=Math.max(stats.peakConcurrency,active);
  }
  function release(){const waiter=waiters.shift();if(waiter){waiter.signal.removeEventListener('abort',waiter.abort);waiter.resolve();}else active--;}
  function session(signal){return {signal:AbortSignal.any([AbortSignal.timeout(timeoutMs),...(signal?[signal]:[])]),bytes:0,requests:0};}
  function cacheNode(d,node){
    if(cache.has(d.path)){cacheBytes-=cache.get(d.path).size;cache.delete(d.path);}cache.set(d.path,{node,size:d.size});cacheBytes+=d.size;
    while(cacheBytes>V3.cacheBytes||cache.size>V3.cacheNodes){const [key,value]=cache.entries().next().value;cache.delete(key);cacheBytes-=value.size;}
  }
  async function node(d,kind,s){
    s.signal.throwIfAborted();validateV3Descriptor(d,kind);
    const cached=cache.get(d.path);if(cached){cache.delete(d.path);cache.set(d.path,cached);stats.cacheHits++;return validateV3Node(cached.node,d,kind);}
    await acquire(s.signal);
    try{
      for(let attempt=0;attempt<=V3.retries;attempt++){
        s.signal.throwIfAborted();reserveQueryRequest(s,d.size);stats.requests++;
        let response;
        try{response=await fetcher(metadataURL(root.metadataSource,d.path),{mode:'cors',credentials:'omit',redirect:'error',signal:s.signal});}
        catch(error){s.signal.throwIfAborted();if(error instanceof TypeError&&attempt<V3.retries){await sleep(retryDelayMs*(attempt+1),s.signal);continue;}throw error;}
        if(!response.ok){await response.body?.cancel();if([408,429,500,502,503,504].includes(response.status)&&attempt<V3.retries){await sleep(retryDelayMs*(attempt+1),s.signal);continue;}throw Error(`Catalog node HTTP ${response.status}`);}
        const bytes=await readMetadataBytes(response,{limit:d.size,exactSize:d.size,signal:s.signal});stats.bytes+=bytes.length;
        if(!cryptoProvider?.subtle)throw Error('SHA-256 requires a secure context');
        const digest=await cryptoProvider.subtle.digest('SHA-256',bytes);s.signal.throwIfAborted();
        const hash=Array.from(new Uint8Array(digest),v=>v.toString(16).padStart(2,'0')).join('');
        if(hash!==d.sha256)throw Error('V3 SHA-256 mismatch');
        const value=deepFreeze(validateV3Node(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)),d,kind));cacheNode(d,value);return value;
      }
    }finally{release();}
  }
  async function seek(d,kind,target,s,exclusive=false){
    if(!d||d.max<target||(exclusive&&d.max===target))return null;
    const value=await node(d,kind,s);
    if(d.height>1){const child=value.children.find(c=>c.max>target||(!exclusive&&c.max===target));return child?seek(child,kind,target,s,exclusive):null;}
    const entry=value.entries.find(e=>{const key=kind==='postings'?e:e[0];return key>target||(!exclusive&&key===target);});
    if(entry===undefined)return null;
    return kind==='postings'?{key:entry,value:entry,node:value}:{key:entry[0],value:entry[1],node:value};
  }
  async function seekPosting(d,key,s){if(d.ids){const id=d.ids.find(id=>id>=key);return id===undefined?null:{key:id};}return seek(d,'postings',key,s);}
  async function lookup(d,kind,key,s){const found=await seek(d,kind,key,s);return found?.key===key?found:null;}
  async function query(filtersInput={}, {cursor=null,limit=V3.pageSize,signal}={},sharedSession){
    const filters=normalizeFilters(filtersInput),signature=JSON.stringify(filters),s=sharedSession||session(signal),startBytes=s.bytes,startRequests=s.requests;
    if(!Number.isInteger(limit)||limit<1||limit>V3.pageSize)throw Error('Invalid page size');
    if(cursor&&(cursor.snapshot!==root.snapshot||cursor.signature!==signature||!Number.isSafeInteger(cursor.next)||cursor.next<0||cursor.next>root.assetCount||!Number.isSafeInteger(cursor.matched)||cursor.matched<0||cursor.matched>cursor.next))throw Error('Stale or invalid catalog cursor');
    let next=cursor?.next||0,matched=cursor?.matched||0,scanned=0,seeks=0,budgetLimited=false,complete=false;
    const terms=FACETS.filter(field=>filters[field]).map(field=>'f\u0000'+facetKey(field,filters[field])).concat(queryGrams(filters.query).map(gram=>'g\u0000'+gram));
    const lists=[];
    // Sequential lookup keeps queues bounded; the global semaphore also covers concurrent UI queries.
    for(const term of terms){const found=await lookup(root.trees.terms,'terms',term,s);if(!found)return {assets:[],sources:{},source:undefined,total:root.assetCount,matchedTotal:0,cursor:null,scanned:0,metrics:{bytes:s.bytes-startBytes,requests:s.requests-startRequests},budgetLimited:false};validatePosting(found.value);if(found.value.max>=root.assetCount)throw Error('Posting outside catalog');lists.push(found.value);}
    lists.sort((a,b)=>a.count-b.count);const assets=[],sources={};let source;
    try{
      while(next<root.assetCount&&assets.length<limit){
        s.signal.throwIfAborted();if(scanned>=V3.candidateLimit||seeks>=V3.seekLimit){budgetLimited=true;break;}
        let ordinal=next;
        if(lists.length){const driver=await seekPosting(lists[0],next,s);seeks++;if(!driver){complete=true;break;}ordinal=driver.key;next=ordinal;
          let skip=false;
          for(const list of lists.slice(1)){const found=await seekPosting(list,ordinal,s);seeks++;if(!found){complete=true;skip=true;break;}if(found.key!==ordinal){next=found.key;skip=true;break;}}
          if(complete)break;if(skip)continue;
        }
        const found=await lookup(root.trees.records,'records',ordinal,s);if(!found)throw Error('Missing catalog record');
        if(ordinal>=root.assetCount)throw Error('Posting outside catalog');
        const header={source:found.node.source,sources:found.node.sources};scanned++;
        if(matchesAsset(found.value,header,filters)){
          // Never modify frozen records or their sourceId. Resolve only the current page's sources.
          if(assets.some(a=>a.id===found.value.id))throw Error('Duplicate asset ID in result page');assets.push(found.value);matched++;if(found.node.source){if(source&&JSON.stringify(source)!==JSON.stringify(found.node.source))throw Error('Conflicting default source');source=found.node.source;}
          for(const [id,value]of Object.entries(found.node.sources||{})){if(sources[id]&&JSON.stringify(sources[id])!==JSON.stringify(value))throw Error('Conflicting source ID');sources[id]=value;}
        }
        next=ordinal+1;
      }
    }catch(error){if(error instanceof BudgetError)budgetLimited=true;else throw error;}
    s.signal.throwIfAborted();complete=complete||next>=root.assetCount;
    // An incomplete intersection/search has no exact total yet. Never label a loaded subset as global.
    return {schemaVersion:1,collection:root.collection,source,sources,assets,total:root.assetCount,
      matchedTotal:!terms.length?root.assetCount:(lists.length===1&&Array.from(filters.query).length<=3)?lists[0].count:complete?matched:null,cursor:complete?null:{snapshot:root.snapshot,signature,next,matched},
      scanned,budgetLimited,metrics:{bytes:s.bytes-startBytes,requests:s.requests-startRequests}};
  }
  async function facets(field,{after=null,limit=24,signal}={},sharedSession){
    if(!FACETS.includes(field)||!Number.isInteger(limit)||limit<1||limit>64||(after!==null&&(typeof after!=='string'||after.length>512)))throw Error('Invalid facet page');
    const s=sharedSession||session(signal),startBytes=s.bytes,startRequests=s.requests,prefix=field+'\u0000',values=[];let key=after===null?prefix:prefix+after,exclusive=after!==null;
    for(let i=0;i<=limit;i++){const found=await seek(root.trees.facets,'facets',key,s,exclusive);if(!found||!found.key.startsWith(prefix))return {values,cursor:null,metrics:{bytes:s.bytes-startBytes,requests:s.requests-startRequests}};if(i===limit)return {values,cursor:values.at(-1).value,metrics:{bytes:s.bytes-startBytes,requests:s.requests-startRequests}};values.push({value:found.key.slice(prefix.length),count:found.value});key=found.key;exclusive=true;}
  }
  async function bootstrap(filters={}, {signal}={}){const s=session(signal);s.bytes=rootBytes;s.requests=1;const page=await query(filters,{signal},s),pages={},failures=[];for(const field of FACETS){try{pages[field]=await facets(field,{signal},s);}catch(error){s.signal.throwIfAborted();failures.push({field,message:error.message});}}return {page,facets:pages,facetFailures:failures,metrics:{bytes:s.bytes,requests:s.requests}};}
  return {root,total:root.assetCount,query:(filters,options)=>query(filters,options),facets:(field,options)=>facets(field,options),bootstrap,stats:()=>({...stats,cacheBytes,cacheNodes:cache.size,active}),clearCache(){cache.clear();cacheBytes=0;}};
}
export async function fetchPagedCatalogEntry({signal,fetcher=fetch,timeoutMs=V3.timeoutMs}={}){
  const combined=AbortSignal.any([AbortSignal.timeout(timeoutMs),...(signal?[signal]:[])]);combined.throwIfAborted();
  const response=await fetcher('./catalog-v3.json',{mode:'cors',credentials:'omit',redirect:'error',signal:combined});
  if(response.status===404){await response.body?.cancel();return fetchCatalogEntry({signal:combined,fetcher,timeoutMs});}
  if(!response.ok)throw Error(`Catalog HTTP ${response.status}`);
  const bytes=await readMetadataBytes(response,{limit:V3.rootBytes,signal:combined});
  const root=validateV3Root(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)));entryByteCounts.set(root,bytes.length);return root;
}

// Self-contained v3 transport: compatible with cached, unmodified v2 runtimes.
async function readMetadataBytes(response,{limit,exactSize,signal}){
 // CORS exposes Content-Length but may hide Content-Encoding. Fetch has already
 // decoded the body, so an absent cross-origin encoding header is not identity.
 const encoding=response.headers.get('content-encoding'),declared=response.headers.get('content-length');
 const identity=encoding?.trim().toLowerCase()==='identity'||(encoding===null&&response.type!=='cors');
 if(identity&&declared!==null&&(Number(declared)>limit||(exactSize!==undefined&&Number(declared)!==exactSize)))throw Error('Metadata length mismatch');
 if(!response.body)throw Error('Metadata body unavailable');const reader=response.body.getReader(),chunks=[];let length=0;
 const cancel=()=>{reader.cancel(signal.reason).catch(()=>{});};signal.addEventListener('abort',cancel,{once:true});
 try{while(true){signal.throwIfAborted();const {done,value}=await reader.read();signal.throwIfAborted();if(done)break;length+=value.byteLength;if(length>limit)throw Error('Metadata exceeds expected size');chunks.push(value);}}catch(error){await reader.cancel().catch(()=>{});throw error;}finally{signal.removeEventListener('abort',cancel);reader.releaseLock();}
 signal.throwIfAborted();if(exactSize!==undefined&&length!==exactSize)throw Error('Metadata length mismatch');const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}return bytes;
}
