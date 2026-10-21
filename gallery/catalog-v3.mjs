// Offline deterministic builder and publisher adapter. No network or Git writes.
import {createHash} from 'node:crypto';
import {readFile,writeFile,mkdir,lstat} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {METADATA_SOURCE,assetSource,validateCatalog} from '../docs/core.mjs';
import {V3,FACETS,searchText,queryGrams,facetKey,validateV3Descriptor,validateV3Node,validateV3Root} from '../docs/core-catalog-v3.mjs';
export const GRAPH_STORAGE_BUDGET=268435456; // Offline published graph cap: 256 MiB, never a browser download.
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const encode=value=>Buffer.from(JSON.stringify(value)+'\n');
const compare=(a,b)=>a<b?-1:a>b?1:0;
export function canonicalCatalog(input){
  validateCatalog(input);const out={schemaVersion:1,collection:input.collection||{}};
  if(input.source?.commit)out.source=input.source;
  if(Object.keys(input.sources||{}).length)out.sources=Object.fromEntries(Object.entries(input.sources).sort(([a],[b])=>compare(a,b)));
  out.assets=input.assets;return out;
}
export function appendCatalog(input,{assets=[],sources={}}={}){
  const base=canonicalCatalog(input),known=new Set(base.assets.map(a=>a.id)),merged={...(base.sources||{})};
  for(const [id,source]of Object.entries(sources)){if(merged[id]&&JSON.stringify(merged[id])!==JSON.stringify(source))throw Error('Cannot replace an existing source ID');merged[id]=source;}
  for(const asset of assets){if(known.has(asset.id))throw Error('Cannot replace an existing asset ID');known.add(asset.id);}
  return canonicalCatalog({...base,sources:merged,assets:[...base.assets,...assets]});
}
export function buildPagedCatalog(input){
  const catalog=canonicalCatalog(input),files=new Map();let totalBytes=0;
  const emit=(payload,min,max,count,height)=>{
    const bytes=encode(payload);if(bytes.length>V3.nodeBytes)throw Error('Single catalog node exceeds 256 KiB');
    const sha256=sha(bytes),path=`catalog/v3/${sha256.slice(0,2)}/${sha256}.json`;
    if(!files.has(path)){totalBytes+=bytes.length;if(totalBytes>GRAPH_STORAGE_BUDGET)throw Error('Offline v3 graph storage budget exceeded');files.set(path,bytes);}
    const d={path,size:bytes.length,sha256,min,max,count,height};validateV3Node(payload,d,payload.family);return d;
  };
  const makeTree=(family,entries,{leafItems=V3.leafItems,makeLeaf=entries=>({schemaVersion:3,family,kind:'leaf',entries})}={})=>{
    if(!entries.length)return null;let pages=[],batch=[];const baseBytes=encode(makeLeaf([])).length;let estimatedBytes=baseBytes;
    const key=entry=>family==='postings'?entry:entry[0];
    const flush=()=>{const payload=makeLeaf(batch);pages.push(emit(payload,key(batch[0]),key(batch.at(-1)),batch.length,1));batch=[];estimatedBytes=baseBytes;};
    for(const entry of entries){const weight=encode(makeLeaf([entry])).length-baseBytes+1;if(batch.length&&(batch.length>=leafItems||estimatedBytes+weight>V3.targetNodeBytes))flush();batch.push(entry);estimatedBytes+=weight;}if(batch.length)flush();
    while(pages.length>1){const parents=[];
      // Avoid a one-child branch: distribute the last group evenly.
      for(let i=0;i<pages.length;){const remaining=pages.length-i,n=remaining===V3.fanout+1?V3.fanout-1:Math.min(V3.fanout,remaining),children=pages.slice(i,i+n);i+=n;
        if(children.length>V3.fanout||children.length<2)throw Error('Invalid tree fanout');
        parents.push(emit({schemaVersion:3,family,kind:'branch',children},children[0].min,children.at(-1).max,children.reduce((n,c)=>n+c.count,0),children[0].height+1));}
      pages=parents;
    }return pages[0];
  };
  // A compressed binary UTF-16 radix tree keeps lexicographic lookup/seek ordering while
  // splitting only the affected key bucket. Inserting a new source/gram must not
  // shift every later dictionary leaf as offset-based bulk pagination would.
  const makeKeyTree=(family,entries)=>{
    const bits=new Map(entries.map(([key])=>[key,Array.from({length:key.length},(_,i)=>key.charCodeAt(i).toString(2).padStart(16,'0')).join('')]));
    function partition(rows){
      if(!rows.length)return null;const payload={schemaVersion:3,family,kind:'leaf',entries:rows};
      if(rows.length<=(family==='terms'?V3.termLeafItems:V3.leafItems)&&encode(payload).length<=(family==='terms'?V3.termNodeBytes:V3.targetNodeBytes))return emit(payload,rows[0][0],rows.at(-1)[0],rows.length,1);
      if(rows.length===1)return emit(payload,rows[0][0],rows[0][0],1,1);
      const first=bits.get(rows[0][0]),last=bits.get(rows.at(-1)[0]);let at=0;while(at<first.length&&at<last.length&&first[at]===last[at])at++;
      const groups=[];let group=[],previous;
      for(const row of rows){const key=bits.get(row[0]).slice(at,at+1)||'';if(group.length&&key!==previous){groups.push(group);group=[];}group.push(row);previous=key;}if(group.length)groups.push(group);
      if(groups.length<2||groups.length>V3.fanout)throw Error('Invalid radix partition');
      // Fold small branch levels without repacking unrelated leaves. Dictionary key ranges are unique, so removed branch nodes have no other references.
      const children=groups.map(partition);for(let i=0;i<children.length;i++){const child=children[i];if(child.height>1){const payload=JSON.parse(files.get(child.path));if(children.length-1+payload.children.length<=V3.fanout){children.splice(i,1,...payload.children);totalBytes-=files.get(child.path).length;files.delete(child.path);i--;}}}const height=Math.max(...children.map(child=>child.height))+1;
      return emit({schemaVersion:3,family,kind:'branch',children},rows[0][0],rows.at(-1)[0],rows.length,height);
    }return partition(entries);
  };
  const sources=Object.entries(catalog.sources||{});if(catalog.source?.commit)sources.push(['',catalog.source]);sources.sort(([a],[b])=>compare(a,b));
  const sourceTree=makeKeyTree('sources',sources);
  const records=makeTree('records',catalog.assets.map((asset,i)=>[i,asset]),{leafItems:V3.pageSize,makeLeaf:entries=>{
    const node={schemaVersion:3,family:'records',kind:'leaf',entries};
    if(entries.some(([,a])=>a.sourceId===undefined))node.source=catalog.source;
    const used=[...new Set(entries.map(([,a])=>a.sourceId).filter(id=>id!==undefined))].sort();if(used.length)node.sources=Object.fromEntries(used.map(id=>[id,catalog.sources[id]]));return node;
  }});
  const postings=new Map(),facets=new Map();
  const add=(term,id)=>{let list=postings.get(term);if(!list){list=[];postings.set(term,list);}list.push(id);};
  for(const [ordinal,asset]of catalog.assets.entries()){
    for(const field of FACETS){const value=field==='repository'?assetSource(catalog,asset).repo:asset[field];if(typeof value!=='string'||value.length>512)throw Error('Facet value exceeds supported length');const key=facetKey(field,value);facets.set(key,(facets.get(key)||0)+1);add('f\u0000'+key,ordinal);}
    const text=searchText(asset),chars=Array.from(text),grams=new Set();
    for(const n of [1,2,3])for(let i=0;i<=chars.length-n;i++)grams.add(chars.slice(i,i+n).join(''));
    for(const gram of grams)add('g\u0000'+gram,ordinal);
  }
  const terms=makeKeyTree('terms',[...postings.entries()].sort(([a],[b])=>compare(a,b)).map(([key,ids])=>[key,ids.length<=V3.inlinePostings?{ids,count:ids.length,min:ids[0],max:ids.at(-1)}:makeTree('postings',ids,{leafItems:V3.postingLeafItems})]));
  const facetTree=makeKeyTree('facets',[...facets.entries()].sort(([a],[b])=>compare(a,b)));
  const template={schemaVersion:3,format:'shadow-paged-catalog-1',snapshot:sha(encode(catalog)),collection:catalog.collection,assetCount:catalog.assets.length,trees:{records,terms,facets:facetTree,sources:sourceTree}};
  const report={assetCount:catalog.assets.length,snapshot:template.snapshot,nodes:files.size,graphBytes:totalBytes,maxNodeBytes:[...files.values()].reduce((max,b)=>Math.max(max,b.length),0),rootTemplateBytes:encode(template).length,heights:Object.fromEntries(Object.entries(template.trees).map(([k,d])=>[k,d?.height||0])),graphStorageBudget:GRAPH_STORAGE_BUDGET,perInteractionBytes:V3.queryBytes};
  return {template,files,report,catalog};
}
export function pinPagedCatalog(template,commit){
  const root={...template,metadataSource:{...METADATA_SOURCE,commit}};validateV3Root(root);if(encode(root).length>V3.rootBytes)throw Error('Root byte budget exceeded');return root;
}
export async function auditPagedCatalog(root,reader,{verifySearch=true}={}){
  validateV3Root(root);const seen=new Map(),allRecords=[],sources={};let source,totalBytes=0;
  async function visit(d,family){
    if(!d)return [];validateV3Descriptor(d,family);
    let node=seen.get(d.path);
    if(!node){const bytes=await reader(d.path);if(bytes.length!==d.size||sha(bytes)!==d.sha256)throw Error('V3 graph integrity mismatch');totalBytes+=bytes.length;if(totalBytes>GRAPH_STORAGE_BUDGET)throw Error('Offline v3 graph storage budget exceeded');node=JSON.parse(bytes);seen.set(d.path,node);}
    validateV3Node(node,d,family);
    if(node.kind==='branch'){const out=[];for(const child of node.children)out.push(...await visit(child,family));return out;}
    if(family==='terms')for(const [,posting]of node.entries)if(!posting.ids)await visit(posting,'postings');
    return node.entries;
  }
  for(const [id,value]of await visit(root.trees.sources,'sources'))if(id)sources[id]=value;else source=value;
  const entries=await visit(root.trees.records,'records');for(let i=0;i<entries.length;i++){if(entries[i][0]!==i)throw Error('Record ordinals are incomplete');allRecords.push(entries[i][1]);}
  const catalog=canonicalCatalog({schemaVersion:1,collection:root.collection,...(source?{source}:{}),...(Object.keys(sources).length?{sources}:{}),assets:allRecords});
  if(catalog.assets.length!==root.assetCount||sha(encode(catalog))!==root.snapshot)throw Error('Snapshot or asset count mismatch');
  await visit(root.trees.terms,'terms');await visit(root.trees.facets,'facets');
  if(verifySearch){const expected=buildPagedCatalog(catalog);if(JSON.stringify(expected.template.trees)!==JSON.stringify(root.trees))throw Error('Search/facet/source/record graph is not exact');}
  return {catalog,report:{assetCount:allRecords.length,nodes:seen.size,graphBytes:totalBytes,snapshot:root.snapshot,exactSearchIndex:verifySearch}};
}
export async function preparePublication(input,out){
  const built=buildPagedCatalog(input);await mkdir(out);const manifest=[];
  for(const [path,bytes]of built.files){await mkdir(dirname(join(out,path)),{recursive:true});await writeFile(join(out,path),bytes);manifest.push({path,bytes:bytes.length,sha256:sha(bytes)});}
  await writeFile(join(out,'catalog-v3.template.json'),encode(built.template));await writeFile(join(out,'graph-manifest.json'),encode(manifest));await writeFile(join(out,'report.json'),encode(built.report));return built;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const [command,...args]=process.argv.slice(2);
  if(command==='prepare'){
    const [input,out,addition]=args;if(!input||!out)throw Error('Usage: prepare <expanded-v1.json> <fresh-output> [addition.json]');
    let catalog=JSON.parse(await readFile(input,'utf8'));if(addition)catalog=appendCatalog(catalog,JSON.parse(await readFile(addition,'utf8')));
    const result=await preparePublication(catalog,resolve(out));console.log(JSON.stringify(result.report));
  }else if(command==='pin'){
    const [prepared,commit,output]=args;if(!prepared||!commit||!output)throw Error('Usage: pin <prepared-directory> <verified-graph-commit> <output-entry>');
    const root=pinPagedCatalog(JSON.parse(await readFile(join(prepared,'catalog-v3.template.json'),'utf8')),commit);
    const audit=await auditPagedCatalog(root,path=>readFile(join(prepared,path)));await writeFile(output,encode(root));console.log(JSON.stringify(audit.report));
  }else if(command==='audit'){
    const [entry,repo]=args;if(!entry||!repo)throw Error('Usage: audit <catalog-v3.json> <graph-repository-root>');
    const root=JSON.parse(await readFile(entry,'utf8'));const audit=await auditPagedCatalog(root,async path=>{const file=join(repo,path);if((await lstat(file)).isSymbolicLink())throw Error('Graph symlink not allowed');return readFile(file);});console.log(JSON.stringify(audit.report));
  }else if(command==='expand'){
    const [entry,repo,output]=args;if(!entry||!repo||!output)throw Error('Usage: expand <catalog-v3.json> <graph-repository-root> <expanded-v1-output>');
    const root=JSON.parse(await readFile(entry,'utf8')),audit=await auditPagedCatalog(root,path=>readFile(join(repo,path)));await writeFile(output,encode(audit.catalog));console.log(JSON.stringify(audit.report));
  }else throw Error('Expected prepare, pin, audit or expand');
}
