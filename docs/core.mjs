export const SOURCE = Object.freeze({owner:'shAdow-XJY-Games',repo:'Shadow3DAssetLibrary'});
// Asset bytes stay in the asset repositories. Gallery hosts only the website and metadata.
export const ASSET_REPOSITORIES = Object.freeze(['shAdow-XJY-Games/Shadow3DAssetLibrary','shAdow-XJY-Games/Shadow3DAssetLibrary02']);
export const METADATA_REPOSITORIES = Object.freeze(['shAdow-XJY-Games/Shadow3DAssetGallery','shAdow-XJY-Games/Shadow3DAssetLibrary']);
export const METADATA_SOURCE = Object.freeze({owner:'shAdow-XJY-Games',repo:'Shadow3DAssetGallery'});
export function assetSource(catalog,asset){if(asset.sourceId!==undefined&&(typeof asset.sourceId!=='string'||!/^[a-z0-9-]+$/.test(asset.sourceId)||!Object.hasOwn(catalog.sources||{},asset.sourceId)))throw Error('Unknown source ID');const source=asset.sourceId!==undefined?catalog.sources[asset.sourceId]:catalog.source;if(!source)throw Error('Unknown source ID');return source;}
export function rawURL(source,path){
 if(!ASSET_REPOSITORIES.includes(`${source.owner}/${source.repo}`)||! /^[a-f0-9]{40}$/.test(source.commit)) throw Error('Unpinned asset source');
 if(!/^assets\/(?:(?:[A-Za-z0-9_-]+|v?[0-9]+[.][0-9]+[.][0-9]+)\/)*[A-Za-z0-9_-]+[.][A-Za-z0-9]+$/.test(path)||path.split('/').some(p=>!p||p==='.'||p==='..')) throw Error('Unsafe asset path');
 return `https://raw.githubusercontent.com/${source.owner}/${source.repo}/${source.commit}/${path.split('/').map(encodeURIComponent).join('/')}`;
}
export function filterAssets(assets,{query='',category='',theme='',style='',assetKind='',repository=''}={}){
 const q=query.trim().toLocaleLowerCase();return assets.filter(a=>(!repository||a._repository===repository)&&(!assetKind||a.assetKind===assetKind)&&(!category||a.category===category)&&(!theme||a.theme===theme)&&(!style||a.style===style)&&(!q||[a.id,a.title,a.description,a.category,a.theme,a.style].join(' ').toLocaleLowerCase().includes(q)));
}
export const formatBytes=n=>n<1024?`${n} B`:n<1048576?`${(n/1024).toFixed(1)} KB`:`${(n/1048576).toFixed(1)} MB`;
export function validateCatalog(c){
 if(!c||c.schemaVersion!==1||!Array.isArray(c.assets))throw Error('Invalid catalog');
 if(c.source && !ASSET_REPOSITORIES.includes(`${c.source.owner}/${c.source.repo}`))throw Error('Unapproved default repository');
 for(const [id,source] of Object.entries(c.sources||{})){if(!/^[a-z0-9-]+$/.test(id))throw Error('Invalid source ID');rawURL(source,'assets/source-check.glb');}
 const ids=new Set();for(const a of c.assets){if(!a||typeof a!=='object')throw Error('Invalid asset');
 if(!['prop','modular','scene','character'].includes(a.assetKind)||!/^[0-9]+[.][0-9]+[.][0-9]+$/.test(a.version))throw Error('Invalid asset type or version');
 for(const k of ['category','theme','style','title'])if(typeof a[k]!=='string'||!a[k].trim())throw Error('Invalid asset label');
 if(!Number.isInteger(a.triangles)||a.triangles<1||a.triangles>100000||!Number.isInteger(a.materials)||a.materials<1||a.materials>64)throw Error('Invalid geometry budget');
 if(a.bounds?.unit!=='m'||!['x','y','z'].every(k=>Number.isFinite(a.bounds[k])&&a.bounds[k]>0))throw Error('Invalid dimensions');
if(typeof a.id!=='string'||!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(a.id)||ids.has(a.id))throw Error('Invalid or duplicate ID');ids.add(a.id);
 if(!['prototype','review','verified'].includes(a.status)||a.license!=='All rights reserved')throw Error('Invalid status or license');
 for(const role of ['glb','blend','generator','render'])if(!a.files?.[role])throw Error('Missing file');
 const ext={glb:/[.]glb$/,blend:/[.]blend$/,generator:/[.]py$/,render:/[.](png|jpg|jpeg|webp)$/,reference:/[.](png|jpg|jpeg|webp)$/};
 for(const [role,f] of Object.entries(a.files)){if(!f||!ext[role]?.test(f.path))throw Error('Invalid file role');const budget=role==='glb'?5242880:role==='render'||role==='reference'?2097152:role==='generator'?524288:26214400;if(f.size>budget)throw Error('File budget exceeded');rawURL(assetSource(c,a),f.path);if(!Number.isInteger(f.size)||f.size<1||f.size>26214400||!/^[a-f0-9]{64}$/.test(f.sha256))throw Error('Invalid file record');}
 }return c;
}

// Fetch uses browser CORS, sends no credentials, and verifies bytes before GLTF parsing.
export async function fetchVerifiedGLB(url,file,{signal,fetcher=fetch,cryptoProvider=globalThis.crypto}={}){
 if(!Number.isInteger(file.size)||file.size<1||file.size>5242880||!/^[a-f0-9]{64}$/.test(file.sha256))throw Error('Invalid GLB metadata');
 const timeout=AbortSignal.timeout(30000), combined=signal?AbortSignal.any([signal,timeout]):timeout;
 const response=await fetcher(url,{mode:'cors',credentials:'omit',redirect:'error',signal:combined});
 if(!response.ok)throw Error(`GLB HTTP ${response.status}`);
 const declared=response.headers.get('content-length');if(declared!==null&&Number(declared)!==file.size)throw Error('GLB length mismatch');
 if(!response.body)throw Error('GLB body unavailable');const reader=response.body.getReader(),chunks=[];let length=0;
 try{while(true){combined.throwIfAborted();const {done,value}=await reader.read();if(done)break;length+=value.byteLength;if(length>file.size)throw Error('GLB exceeds expected size');chunks.push(value);}}catch(e){await reader.cancel().catch(()=>{});throw e;}finally{reader.releaseLock();}
 combined.throwIfAborted();if(length!==file.size)throw Error('GLB length mismatch');const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
 if(!cryptoProvider?.subtle)throw Error('SHA-256 requires a secure context');const digest=await cryptoProvider.subtle.digest('SHA-256',bytes);combined.throwIfAborted();const hash=Array.from(new Uint8Array(digest),v=>v.toString(16).padStart(2,'0')).join('');if(hash!==file.sha256)throw Error('GLB SHA-256 mismatch');
 return bytes.buffer;
}
