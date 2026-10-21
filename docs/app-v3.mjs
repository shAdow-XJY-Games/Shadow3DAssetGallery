import {rawURL,filterAssets,formatBytes,validateCatalog,assetSource} from './core.mjs';
import {createCatalogStore} from './core-catalog-v2.mjs';
import {createPagedCatalogStore,fetchPagedCatalogEntry,FACETS,normalizeFilters} from './core-catalog-v3.mjs?v=20261019-cors1';
const $=s=>document.querySelector(s), statuses={prototype:'试产样品',review:'待审阅',verified:'已验证'};
let catalog, selected, selectedCatalog, detailTrigger, mode='render', viewer, pendingLoad, sequence=0;
let pagedStore, browseReady=false, browseAbort, browseSequence=0, currentCursor=null, nextCursor=null, previousCursors=[], requestedCursor=null, requestedNavigation, queryTimer;
const facetCursors=new Map();
const BROWSE_PREFERENCE='shadow-catalog-browse-v1',WINDOW_PAGES=5,WINDOW_BYTES=2*1024*1024,MAX_SCROLL_PAGES=8192,MAX_SCROLL_HEIGHT=16000000;
let browseMode='pages';try{if(localStorage.getItem(BROWSE_PREFERENCE)==='scroll')browseMode='scroll';}catch{}
let scrollState,scrollBusy=false,scrollFailure=null,scrollObserver,scrollFrame=false,scrollArmed=false;
const frame=fn=>globalThis.requestAnimationFrame?requestAnimationFrame(fn):setTimeout(fn,0);
const node=(tag,text,className)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(className)e.className=className;return e;};
const readFilters=()=>Object.fromEntries(['query','repository','assetKind','category','theme','style'].map(k=>[k,$('#'+k).value]));
function draw(){const assets=filterAssets(catalog.assets,readFilters());renderCards(assets,`${assets.length} / ${catalog.assets.length} 件已入库`);}
function renderCards(assets,label){$('#catalog').replaceChildren();$('#count').textContent=label;appendCards($('#catalog'),assets,catalog);
 $('#empty').hidden=assets.length>0;if((pagedStore?.total||catalog.assets.length)){$('#empty h3').textContent='没有匹配的素材';$('#empty p').textContent='试试其他关键词，或重置筛选。';}
}
function appendCards(container,assets,pageCatalog){
 for(const a of assets){const card=node('button',undefined,'card');card.type='button';const cover=node('div',undefined,'card-image'),img=node('img');img.src=rawURL(assetSource(pageCatalog,a),a.files.render.path);img.loading='lazy';img.alt=a.title+' · 渲染图';img.addEventListener('error',()=>{cover.replaceChildren(node('span','预览图暂不可用'));},{once:true});cover.append(img);const body=node('div',undefined,'card-body');body.append(node('span',`${a.category} / ${a.theme}`,'eyebrow'),node('h3',a.title));const meta=node('div',undefined,'card-meta');meta.append(node('span',a.triangles.toLocaleString()+' triangles'),node('span',statuses[a.status]));body.append(meta);card.append(cover,body);card.addEventListener('click',()=>{detailTrigger=card;openAsset(a,pageCatalog);});container.append(card);}
}
function release(){sequence++;pendingLoad?.abort();pendingLoad=null;viewer?.dispose();viewer=null;$('#viewer').replaceChildren();$('#reset-view').disabled=true;}
async function setMode(next){release();mode=next;const token=sequence;document.querySelectorAll('[data-mode]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.mode===mode)));$('#viewer-status').textContent='';$('#preview').hidden=next==='3d';$('#viewer').hidden=next!=='3d';
 if(next!=='3d'){const f=selected.files[next];if(!f){$('#preview').removeAttribute('src');$('#viewer-status').textContent='尚未提供参考图';return;}$('#preview').alt=selected.title+(next==='render'?' · 渲染图':' · 参考图');$('#preview').onerror=()=>{if(token===sequence&&mode===next)$('#viewer-status').textContent='图片暂不可用，请稍后重试。';};$('#preview').onload=()=>{if(token===sequence&&mode===next)$('#viewer-status').textContent='';};$('#preview').src=rawURL(assetSource(selectedCatalog,selected),f.path);return;}
 $('#viewer-status').textContent='正在按需载入 3D 预览…';try{const {createViewer}=await import('./viewer.mjs');if(token!==sequence)return;pendingLoad=new AbortController();const current=await createViewer($('#viewer'),rawURL(assetSource(selectedCatalog,selected),selected.files.glb.path),selected.files.glb,()=>token===sequence,pendingLoad.signal);if(token!==sequence){current?.dispose();return;}viewer=current;$('#viewer-status').textContent='';$('#reset-view').disabled=false;}catch(e){if(token===sequence){$('#viewer-status').textContent='3D 预览暂不可用，可查看渲染图或下载 GLB。';console.error(e);}}
}
function openAsset(a,pageCatalog=catalog){selected=a;selectedCatalog=pageCatalog;$('#detail-title').textContent=a.title;$('#detail-kind').textContent=[a.category,a.theme,a.style].join(' / ');$('#detail-description').textContent=a.description||'原创卡通场景素材。';$('#detail-status').textContent=statuses[a.status];$('#specs').replaceChildren();for(const [k,v] of [['版本',a.version],['类型',a.assetKind||'prop'],['三角面',a.triangles.toLocaleString()],['材质',a.materials],['尺寸（米）',`${a.bounds.x} × ${a.bounds.y} × ${a.bounds.z}`]])$('#specs').append(node('dt',k),node('dd',v));$('#downloads').replaceChildren();for(const [role,label] of [['glb','GLB 模型'],['blend','Blender 源文件'],['generator','生成脚本']]){const f=a.files[role],link=node('a');link.href=rawURL(assetSource(selectedCatalog,selected),f.path);link.target='_blank';link.rel='noopener noreferrer';link.append(node('span',label+' ↗'),node('span',formatBytes(f.size)));link.title=`SHA-256: ${f.sha256}`;$('#downloads').append(link);}$('#source-note').textContent='SOURCE / '+assetSource(selectedCatalog,a).repo+' @ '+assetSource(selectedCatalog,a).commit;document.querySelector('[data-mode="reference"]').disabled=!a.files.reference;$('#detail').showModal();setMode('render');}
$('#close').onclick=()=>$('#detail').close();$('#detail').addEventListener('close',()=>{release();selected=null;selectedCatalog=null;if(detailTrigger?.isConnected)detailTrigger.focus({preventScroll:true});detailTrigger=null;});$('#detail').addEventListener('click',e=>{if(e.target===$('#detail')){const r=e.target.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)e.target.close();}});document.querySelectorAll('[data-mode]').forEach(b=>b.onclick=()=>setMode(b.dataset.mode));$('#reset-view').onclick=()=>viewer?.reset();$('#filters').addEventListener('submit',e=>e.preventDefault());$('#filters').addEventListener('input',()=>{if(!pagedStore){if(catalog)draw();return;}restartBrowse(180);});
$('#filters').addEventListener('reset',()=>{if(pagedStore)restartBrowse(0);else setTimeout(()=>{if(catalog)draw();},0);});
function invalidateBrowse(){++browseSequence;browseAbort?.abort();clearTimeout(queryTimer);scrollObserver?.disconnect();scrollBusy=false;scrollFailure=null;scrollState=null;currentCursor=nextCursor=null;previousCursors=[];$('#catalog').replaceChildren();$('#empty').hidden=true;$('#error').hidden=true;$('#retry-catalog').hidden=true;$('#count').textContent='正在查询全库目录…';pageControls(true);}
function restartBrowse(delay=0){invalidateBrowse();queryTimer=setTimeout(()=>browsePage(null),delay);}
function syncBrowseMode(){const scrolling=browseMode==='scroll';$('#browse-mode').value=browseMode;$('#pagination').hidden=scrolling;$('#scroll-navigation').hidden=!scrolling;$('#catalog').className=scrolling?'scroll-catalog':'grid';$('#catalog').setAttribute('aria-live',scrolling?'off':'polite');}
$('#browse-mode').value=browseMode;
$('#browse-mode').onchange=()=>{browseMode=$('#browse-mode').value==='scroll'?'scroll':'pages';try{localStorage.setItem(BROWSE_PREFERENCE,browseMode);}catch{}if(pagedStore){syncBrowseMode();restartBrowse();}};
function pageControls(busy=false){$('#previous-page').disabled=busy||previousCursors.length===0;$('#next-page').disabled=busy||!nextCursor;$('#catalog').setAttribute('aria-busy',String(busy));}
async function browsePage(cursor,{navigation,initialResult}={}){
 if(browseMode==='scroll')return loadScrollPage(0,{initialResult});
 const token=++browseSequence;browseAbort?.abort();browseAbort=new AbortController();requestedCursor=cursor;requestedNavigation=navigation;$('#error').hidden=true;$('#retry-catalog').hidden=true;$('#catalog').replaceChildren();$('#empty').hidden=true;$('#count').textContent='正在查询全库目录…';pageControls(true);
 try{const result=initialResult||await pagedStore.query(readFilters(),{cursor,signal:browseAbort.signal});if(token!==browseSequence)return false;
  if(navigation==='next')previousCursors.push(currentCursor);if(navigation==='previous')previousCursors.pop();
  currentCursor=cursor;nextCursor=result.cursor;catalog=result;browseReady=true;
  const first=(cursor?.matched||0)+1,last=(cursor?.matched||0)+result.assets.length;
  const range=result.assets.length?`本页 ${first}–${last} 件`:'本页暂无匹配';
  const total=result.matchedTotal===null?'匹配总数尚未遍历完':`共 ${result.matchedTotal} 件匹配`;
  renderCards(result.assets,`${range} · ${total} · 全库 ${result.total} 件`);
  $('#page-status').textContent=result.budgetLimited?'本轮查询已达预算，可继续查找。':`第 ${previousCursors.length+1} 页，每页最多 24 件`;
  $('#next-page').textContent=result.budgetLimited?'继续查找':'下一页';
  if(!result.assets.length&&result.cursor){$('#empty h3').textContent='本轮尚未找到匹配';$('#empty p').textContent='查询尚未结束，请选择“继续查找”。';}
  pageControls();return true;
 }catch(error){if(token!==browseSequence||error.name==='AbortError')return false;$('#count').textContent='目录查询失败';$('#error').hidden=false;$('#error').textContent='本页未加载。检查网络后重试，已选筛选条件会保留。';$('#retry-catalog').hidden=false;pageControls(true);console.error(error);return false;}
}
// Only page bookmarks survive eviction. Old records are restored from this store's immutable snapshot.
function newScrollState(){return {marks:new Float64Array(MAX_SCROLL_PAGES*4),prefix:new Float64Array(MAX_SCROLL_PAGES+1),length:0,pages:new Map(),bytes:0,signature:JSON.stringify(normalizeFilters(readFilters())),filters:readFilters(),tail:null,matched:0,total:null,budgetLimited:false,viewIndex:0};}
function scrollCursor(index){if(index===0)return null;const s=scrollState;return {snapshot:pagedStore.root.snapshot,signature:s.signature,next:s.marks[index*4],matched:s.marks[index*4+1]};}
function rebuildHeights(){const s=scrollState;s.prefix[0]=0;for(let i=0;i<s.length;i++)s.prefix[i+1]=s.prefix[i]+s.marks[i*4+3];}
function pageAt(offset){const s=scrollState;let lo=0,hi=s.length;while(lo<hi){const mid=(lo+hi)>>>1;if(s.prefix[mid+1]<=offset)lo=mid+1;else hi=mid;}return Math.min(lo,s.length-1);}
function renderScrollWindow(){
 const s=scrollState,container=$('#catalog'),rect=container.getBoundingClientRect(),offset=Math.max(0,-rect.top),anchor=s.length?pageAt(offset):0,oldTop=s.prefix[anchor]||0,focused=document.activeElement;
 const children=[];let position=0;const spacer=(height,index)=>{if(height>0){const e=node('div',undefined,'scroll-spacer');e.style.height=height+'px';const button=node('button',`恢复第 ${index+1} 批素材`,'restore-gap');button.type='button';button.onclick=()=>loadScrollPage(index,{jump:true,focus:true});e.append(button);children.push(e);}};
 for(const [index,page] of [...s.pages].sort((a,b)=>a[0]-b[0])){spacer(s.prefix[index]-s.prefix[position],position);children.push(page.element);position=index+1;}spacer(s.prefix[s.length]-s.prefix[position],position);container.replaceChildren(...children);
 for(const [index,page] of s.pages)s.marks[index*4+3]=Math.max(1,page.element.getBoundingClientRect().height);
 rebuildHeights();position=0;let child=0;for(const [index,page] of [...s.pages].sort((a,b)=>a[0]-b[0])){if(s.prefix[index]>s.prefix[position])container.children[child++].style.height=(s.prefix[index]-s.prefix[position])+'px';child++;position=index+1;}if(s.prefix[s.length]>s.prefix[position])container.children[child].style.height=(s.prefix[s.length]-s.prefix[position])+'px';
 if(focused&&container.contains(focused))focused.focus?.({preventScroll:true});
 $('#empty').hidden=s.matched>0;
 if(!s.matched){$('#empty h3').textContent=s.tail?'本轮尚未找到匹配':'没有匹配的素材';$('#empty p').textContent=s.tail?'查询尚未结束，请选择“继续查找”。':'试试其他关键词，或重置筛选。';}
 const total=s.total===null?'匹配总数尚未遍历完':`共 ${s.total} 件匹配`;
 $('#count').textContent=`已浏览 ${s.matched} 件 · ${total} · 全库 ${pagedStore.total} 件`;
 container.dataset.renderedPages=String(s.pages.size);container.dataset.cachedBytes=String(s.bytes);container.dataset.bookmarkedPages=String(s.length);
 scrollControls();
 // Native scroll anchoring is disabled in this mode; compensate the same retained page once.
 if(rect.top<0){const delta=container.getBoundingClientRect().top+s.prefix[anchor]-(rect.top+oldTop);if(delta)globalThis.scrollBy?.(0,delta);}
}
function scrollControls(){
 const s=scrollState,index=s?.viewIndex||0;
 const capped=s&&(s.length>=MAX_SCROLL_PAGES||s.prefix[s.length]>=MAX_SCROLL_HEIGHT);
 $('#scroll-earlier').hidden=!s||index===0;$('#scroll-earlier').disabled=scrollBusy;
 $('#scroll-later').hidden=!s||index>=s.length-1;$('#scroll-later').disabled=scrollBusy;
 $('#load-more').disabled=scrollBusy||!s||!s.tail||capped;
 $('#load-more').textContent=scrollBusy?'正在加载…':s?.budgetLimited?'继续查找':'加载更多';
 $('#scroll-status').textContent=scrollBusy?'正在按需加载一页…':scrollFailure?'加载失败，已显示的素材保留。':capped?'本次滚动已达安全上限，可细化筛选或切换分页。':!s?.tail?'已显示全部匹配素材。':s.budgetLimited?'本轮查询已达预算，请手动继续查找。':'滚动到底部自动追加；向上滚动可恢复较早素材。';
 $('#catalog').setAttribute('aria-busy',String(scrollBusy));
}
async function loadScrollPage(index,{initialResult,jump=false,focus=false}={}){
 if(scrollBusy)return false;
 if(!scrollState)scrollState=newScrollState();const s=scrollState,append=index===s.length;
 if(index<0||index>s.length||(append&&s.length&&(!s.tail||s.length>=MAX_SCROLL_PAGES||s.prefix[s.length]>=MAX_SCROLL_HEIGHT)))return false;
 if(s.pages.has(index)){s.viewIndex=index;scrollControls();if(jump)jumpToScrollPage(index);if(focus)s.pages.get(index).element.children[0]?.focus({preventScroll:true});return true;}
 const cursor=append?s.tail:scrollCursor(index),count=append?24:s.marks[index*4+2];
 const token=++browseSequence;browseAbort?.abort();browseAbort=new AbortController();scrollBusy=true;scrollFailure=null;$('#error').hidden=true;$('#retry-catalog').hidden=true;scrollControls();
 try{
  const result=initialResult||(!append&&count===0?{schemaVersion:1,assets:[],total:pagedStore.total,matchedTotal:s.total}:await pagedStore.query(s.filters,{cursor,limit:count||24,signal:browseAbort.signal}));
  if(token!==browseSequence||s!==scrollState)return false;
  if(!append&&result.assets.length!==count)throw Error('Restoring this page needs another bounded retry');
  const ids=new Set();for(const page of s.pages.values())for(const a of page.result.assets)ids.add(a.id);for(const a of result.assets){if(ids.has(a.id))throw Error('Duplicate asset in scroll window');ids.add(a.id);}
  const bytes=new TextEncoder().encode(JSON.stringify(result)).length;if(bytes>WINDOW_BYTES)throw Object.assign(Error('Scroll page exceeds memory budget'),{userMessage:'这一批数据超出滚动浏览的缓存上限，请切换分页浏览。'});
  const evictions=[];let retainedBytes=s.bytes,retainedPages=s.pages.size;for(const [key,page] of s.pages){if(retainedPages<WINDOW_PAGES&&retainedBytes+bytes<=WINDOW_BYTES)break;if(page.element.contains(document.activeElement)||($('#detail').open&&detailTrigger&&page.element.contains(detailTrigger)))continue;evictions.push(key);retainedBytes-=page.bytes;retainedPages--;}if(retainedPages>=WINDOW_PAGES||retainedBytes+bytes>WINDOW_BYTES)throw Object.assign(Error('Focused page is retained; move focus before loading more'),{userMessage:'为保留当前键盘焦点，已暂停追加。将焦点移到“加载更多”后重试。'});
  if(append){if(s.length){s.marks[index*4]=cursor.next;s.marks[index*4+1]=cursor.matched;}s.marks[index*4+2]=result.assets.length;s.marks[index*4+3]=result.assets.length?1:0;s.length++;s.tail=result.cursor;s.matched=(cursor?.matched||0)+result.assets.length;s.total=result.matchedTotal;s.budgetLimited=result.budgetLimited;}
  const element=node('section',undefined,'scroll-page grid');element.dataset.page=String(index);element.setAttribute('aria-label',`第 ${index+1} 批素材`);appendCards(element,result.assets,result);
  for(const key of evictions){s.bytes-=s.pages.get(key).bytes;s.pages.delete(key);}
  s.viewIndex=index;s.pages.set(index,{result,bytes,element});s.bytes+=bytes;catalog=result;browseReady=true;scrollBusy=false;rebuildHeights();renderScrollWindow();
  if(jump)jumpToScrollPage(index);if(focus)element.children[0]?.focus({preventScroll:true});installScrollObserver();frame(()=>checkScrollPosition(true));return true;
 }catch(error){if(token!==browseSequence||error.name==='AbortError')return false;scrollBusy=false;scrollFailure={index,jump,focus};$('#error').hidden=false;$('#error').textContent=error.userMessage||'这一批素材未加载。检查网络后重试，之前的结果会保留。';$('#retry-catalog').hidden=false;scrollControls();console.error(error);return false;}
}
function jumpToScrollPage(index){const top=$('#catalog').getBoundingClientRect().top+scrollState.prefix[index];globalThis.scrollBy?.(0,top);}
function installScrollObserver(){scrollObserver?.disconnect();scrollArmed=false;if(!globalThis.IntersectionObserver)return;scrollObserver=new IntersectionObserver(entries=>{for(const entry of entries){if(!entry.isIntersecting){scrollArmed=true;continue;}if(scrollArmed){scrollArmed=false;autoAppend();}}},{rootMargin:'0px'});scrollObserver.observe($('#scroll-sentinel'));}
function autoAppend(){if(browseMode==='scroll'&&scrollState&&!scrollBusy&&!scrollFailure&&!scrollState.budgetLimited&&scrollState.matched>0)loadScrollPage(scrollState.length);}
function checkScrollPosition(restoreOnly=false){
 scrollFrame=false;const s=scrollState;if(browseMode!=='scroll'||!s||!s.length||scrollBusy||scrollFailure)return;
 const rect=$('#catalog').getBoundingClientRect();if(rect.top>globalThis.innerHeight||rect.bottom<0)return;
 const index=pageAt(Math.max(0,-rect.top)),last=Math.min(pageAt(Math.max(0,globalThis.innerHeight-rect.top)),index+2);s.viewIndex=index;scrollControls();for(let visible=index;visible<=last;visible++){const page=s.pages.get(visible);if(page){s.pages.delete(visible);s.pages.set(visible,page);}}for(let visible=index;visible<=last;visible++)if(visible>=0&&s.marks[visible*4+2]>0&&!s.pages.has(visible)){loadScrollPage(visible);return;}
 if(restoreOnly)return;
 // A user scroll, not a completed request, rearms the bottom edge. Never recursively drain the catalog.
 const sentinel=$('#scroll-sentinel').getBoundingClientRect();if(sentinel.top>globalThis.innerHeight)scrollArmed=true;else if(sentinel.bottom>=0&&scrollArmed){scrollArmed=false;autoAppend();}
}
globalThis.addEventListener?.('scroll',()=>{if(!scrollFrame){scrollFrame=true;frame(checkScrollPosition);}},{passive:true});
globalThis.addEventListener?.('resize',()=>{if(scrollState&&!scrollBusy){renderScrollWindow();checkScrollPosition();}},{passive:true});
$('#load-more').onclick=()=>scrollState&&loadScrollPage(scrollState.length);
$('#scroll-earlier').onclick=()=>scrollState&&loadScrollPage(Math.max(0,scrollState.viewIndex-1),{jump:true});
$('#scroll-later').onclick=()=>scrollState&&loadScrollPage(Math.min(scrollState.length-1,scrollState.viewIndex+1),{jump:true});
function installFacet(field,page){const button=$('#'+field+'-more');for(const item of page.values)$('#'+field).append(new Option(`${item.value} (${item.count})`,item.value));facetCursors.set(field,page.cursor);button.hidden=!page.cursor;button.textContent='更多选项';}
async function loadFacet(field){
 const button=$('#'+field+'-more');button.disabled=true;
 try{const page=await pagedStore.facets(field,{after:facetCursors.get(field)||null});installFacet(field,page);}
 catch(error){button.hidden=false;button.textContent='重试选项';console.error(error);}finally{button.disabled=false;}
}
$('#previous-page').onclick=()=>browsePage(previousCursors.at(-1),{navigation:'previous'});
$('#next-page').onclick=()=>browsePage(nextCursor,{navigation:'next'});
$('#retry-catalog').onclick=()=>browseMode==='scroll'&&scrollFailure?loadScrollPage(scrollFailure.index,{jump:scrollFailure.jump,focus:scrollFailure.focus}):pagedStore&&browseReady?browsePage(requestedCursor,{navigation:requestedNavigation}):initialize();
for(const field of FACETS)$('#'+field+'-more').onclick=()=>loadFacet(field);
async function initialize(){
 try{const input=await fetchPagedCatalogEntry();if(input.schemaVersion===3){pagedStore=createPagedCatalogStore(input);browseReady=false;for(const field of FACETS){const button=$('#'+field+'-more');button.hidden=false;button.textContent='载入选项';}$('#browse-options').hidden=false;syncBrowseMode();const token=++browseSequence;browseAbort?.abort();browseAbort=new AbortController();const initial=await pagedStore.bootstrap(readFilters(),{signal:browseAbort.signal});if(token!==browseSequence)return;await browsePage(null,{initialResult:initial.page});for(const field of FACETS){if(initial.facets[field])installFacet(field,initial.facets[field]);else{const button=$('#'+field+'-more');button.hidden=false;button.textContent='载入选项';}}return;}
  $('#compatibility-note').hidden=false;
  if(input.schemaVersion===2){$('#count').textContent='正在校验兼容目录…';catalog=await createCatalogStore(input).load();}else catalog=validateCatalog(input);
  for(const a of catalog.assets)a._repository=assetSource(catalog,a).repo;
  for(const repo of [...new Set(catalog.assets.map(a=>a._repository))].sort())$('#repository').append(new Option(repo,repo));
  for(const key of ['assetKind','category','theme','style'])for(const v of [...new Set(catalog.assets.map(a=>a[key]))].sort())$('#'+key).append(new Option(v,v));draw();
 }catch(error){if(error.name==='AbortError')return;$('#count').textContent='目录读取失败';$('#error').hidden=false;$('#error').textContent='无法读取素材目录，请检查网络后重试。';$('#retry-catalog').hidden=false;console.error(error);}
}
await initialize();
