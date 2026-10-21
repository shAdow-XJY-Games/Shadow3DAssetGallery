import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';
import {SOURCE,METADATA_SOURCE,ASSET_REPOSITORIES,METADATA_REPOSITORIES,rawURL,assetSource,validateCatalog} from '../docs/core.mjs';
import {metadataURL,validateV3Root,createPagedCatalogStore} from '../docs/core-catalog-v3.mjs';
import {buildPagedCatalog,pinPagedCatalog,appendCatalog,auditPagedCatalog} from './catalog-v3.mjs';
const hash='a'.repeat(64),commit='1'.repeat(40),path=`catalog/v3/aa/${hash}.json`;
const file=ext=>({path:`assets/separation-test/v1.0.0/model.${ext}`,size:1,sha256:hash});
const asset=id=>({id,title:id,description:'Synthetic separation test',version:'1.0.0',category:'props',assetKind:'prop',theme:'test',style:'soft',bounds:{x:1,y:1,z:1,unit:'m'},triangles:1,materials:1,status:'verified',license:'All rights reserved',files:{glb:file('glb'),blend:file('blend'),generator:file('py'),render:file('png')}});
test('asset and metadata repository allowlists are independent',()=>{
 assert.deepEqual(ASSET_REPOSITORIES,['shAdow-XJY-Games/Shadow3DAssetLibrary','shAdow-XJY-Games/Shadow3DAssetLibrary02']);
 assert.deepEqual(METADATA_REPOSITORIES,['shAdow-XJY-Games/Shadow3DAssetGallery','shAdow-XJY-Games/Shadow3DAssetLibrary']);
 for(const repo of ['Shadow3DAssetLibrary','Shadow3DAssetLibrary02'])assert.match(rawURL({...SOURCE,repo,commit},'assets/test/model.glb'),new RegExp('/'+repo+'/'));
 for(const repo of ['Shadow3DAssetGallery','other'])assert.throws(()=>rawURL({...SOURCE,repo,commit},'assets/test/model.glb'),/Unpinned/);
 for(const repo of ['Shadow3DAssetGallery','Shadow3DAssetLibrary'])assert.match(metadataURL({...SOURCE,repo,commit},path),new RegExp('/'+repo+'/'));
 for(const repo of ['Shadow3DAssetLibrary02','other'])assert.throws(()=>metadataURL({...SOURCE,repo,commit},path),/Unpinned/);
 for(const bad of ['main','HEAD',null]){assert.throws(()=>rawURL({...SOURCE,commit:bad},'assets/test/model.glb'));assert.throws(()=>metadataURL({...METADATA_SOURCE,commit:bad},path));}
 for(const bad of ['assets/../model.glb','assets/%2e%2e/model.glb','https://example.com/model.glb'])assert.throws(()=>rawURL({...SOURCE,commit},bad));
});
test('new metadata pins default to Gallery while original and second-volume asset URLs remain immutable',async()=>{
 const original={schemaVersion:1,collection:{title:'Synthetic split'},source:{...SOURCE,commit},sources:{old:{...SOURCE,commit}},assets:[{...asset('old-asset'),sourceId:'old'}]};
 const second={...SOURCE,repo:'Shadow3DAssetLibrary02',commit:'2'.repeat(40)};
 const combined=appendCatalog(original,{sources:{second},assets:[{...asset('second-asset'),sourceId:'second'}]});
 assert.deepEqual(combined.assets[0],original.assets[0]);assert.deepEqual(combined.sources.old,original.sources.old);
 const built=buildPagedCatalog(combined),root=pinPagedCatalog(built.template,'3'.repeat(40));assert.equal(root.metadataSource.repo,'Shadow3DAssetGallery');
 const audit=await auditPagedCatalog(root,p=>built.files.get(p));assert.deepEqual(audit.catalog.assets,combined.assets);
 const fetcher=async url=>{assert.match(url,/\/Shadow3DAssetGallery\//);return new Response(built.files.get(url.split('/'+'3'.repeat(40)+'/')[1]));};
 const store=createPagedCatalogStore(root,{fetcher}),page=await store.query();assert.equal(page.assets.length,2);
 assert.equal((await store.query({repository:'Shadow3DAssetLibrary02'})).assets[0].id,'second-asset');
 assert.equal(rawURL(assetSource(page,page.assets[0]),page.assets[0].files.glb.path),rawURL(assetSource(original,original.assets[0]),original.assets[0].files.glb.path));
 assert.match(rawURL(assetSource(page,page.assets[1]),page.assets[1].files.glb.path),/\/Shadow3DAssetLibrary02\/2222222222222222222222222222222222222222\/assets\//);
 assert.throws(()=>validateCatalog({...combined,sources:{...combined.sources,second:{...second,repo:'Shadow3DAssetGallery'}}}));
});
test('checked-in entry validates and schemas mirror the two separate source boundaries',async()=>{
 const entry=JSON.parse(await readFile(new URL('../docs/catalog-v3.json',import.meta.url),'utf8'));validateV3Root(entry);
 const root=JSON.parse(await readFile(new URL('../schemas/catalog-v3.schema.json',import.meta.url),'utf8'));
 assert.deepEqual(root.properties.metadataSource.properties.repo.enum,['Shadow3DAssetGallery','Shadow3DAssetLibrary']);
 assert.deepEqual(root.$defs.source.properties.repo.enum,['Shadow3DAssetLibrary','Shadow3DAssetLibrary02']);
 const node=JSON.parse(await readFile(new URL('../schemas/catalog-v3-node.schema.json',import.meta.url),'utf8'));
 for(const source of [node.properties.source,node.properties.sources.additionalProperties])assert.deepEqual(source.properties.repo.enum,['Shadow3DAssetLibrary','Shadow3DAssetLibrary02']);
});
