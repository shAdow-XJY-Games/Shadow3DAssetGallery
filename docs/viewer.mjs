import * as THREE from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {RoomEnvironment} from 'three/addons/environments/RoomEnvironment.js';
import {fetchVerifiedGLB} from './core.mjs';

// Viewer-only presentation. Asset materials, textures, normals and verified bytes stay unchanged.
export const VIEWER_APPEARANCE = Object.freeze({
 version:'neutral-pbr-agx-v1', toneMapping:'AgX', exposure:1,
 environmentIntensity:0.55, hemisphereIntensity:0.30,
 keyIntensity:2.5, fillIntensity:0.65, shadowOpacity:0.12,
 shadowMapSize:1024, maxPixelRatio:2,
});

export async function createViewer(container,url,file,isCurrent,signal){
 const bytes=await fetchVerifiedGLB(url,file,{signal});
 if(!isCurrent())return null;
 const scene=new THREE.Scene();scene.background=new THREE.Color('#d8dcd7');
 const camera=new THREE.PerspectiveCamera(38,1,.01,1000);
 let renderer,controls,observer,environmentTarget,disposed=false,frame=null;
 const requestRender=()=>{if(!disposed&&frame===null)frame=requestAnimationFrame(tick);};
 const tick=()=>{
  frame=null;if(disposed)return;
  if(!isCurrent()||signal?.aborted){dispose();return;}
  const moving=controls.update();renderer.render(scene,camera);
  if(moving)requestRender();
 };
 const dispose=()=>{
  if(disposed)return;disposed=true;if(frame!==null)cancelAnimationFrame(frame);
  observer?.disconnect();controls?.removeEventListener('change',requestRender);controls?.dispose();
  signal?.removeEventListener('abort',dispose);
  const geometries=new Set(),materials=new Set(),textures=new Set();
  scene.traverse(o=>{if(o.isLight&&o.shadow){o.shadow.map?.dispose();o.shadow.mapPass?.dispose();}if(o.geometry)geometries.add(o.geometry);for(const m of Array.isArray(o.material)?o.material:o.material?[o.material]:[]){materials.add(m);for(const v of Object.values(m))if(v?.isTexture)textures.add(v);}});
  for(const t of textures)t.dispose();for(const m of materials)m.dispose();for(const g of geometries)g.dispose();
  environmentTarget?.dispose();renderer?.dispose();renderer?.forceContextLoss();renderer?.domElement.remove();
 };
 try{
  renderer=new THREE.WebGLRenderer({antialias:true});
  renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio||1,VIEWER_APPEARANCE.maxPixelRatio));
  renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.AgXToneMapping;
  renderer.toneMappingExposure=VIEWER_APPEARANCE.exposure;
  renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFShadowMap;
  renderer.shadowMap.autoUpdate=false;
  renderer.domElement.setAttribute('aria-label','可旋转的 3D 材质预览');container.append(renderer.domElement);
  controls=new OrbitControls(camera,renderer.domElement);controls.enableDamping=true;
  controls.addEventListener('change',requestRender);
  // Procedural neutral reflection environment: no remote HDR file or asset dependency.
  const room=new RoomEnvironment(),pmrem=new THREE.PMREMGenerator(renderer);
  try{environmentTarget=pmrem.fromScene(room,0.04);}finally{room.dispose();pmrem.dispose();}
  scene.environment=environmentTarget.texture;scene.environmentIntensity=VIEWER_APPEARANCE.environmentIntensity;
  scene.add(new THREE.HemisphereLight(0xffffff,0xb8bcc4,VIEWER_APPEARANCE.hemisphereIntensity));
  const key=new THREE.DirectionalLight(0xffffff,VIEWER_APPEARANCE.keyIntensity);key.castShadow=true;
  key.shadow.mapSize.set(VIEWER_APPEARANCE.shadowMapSize,VIEWER_APPEARANCE.shadowMapSize);
  key.shadow.bias=-0.00015;key.shadow.radius=3;scene.add(key,key.target);
  const fill=new THREE.DirectionalLight(0xffffff,VIEWER_APPEARANCE.fillIntensity);scene.add(fill,fill.target);
  const manager=new THREE.LoadingManager();
  manager.setURLModifier(request=>{if(request.startsWith('blob:')||request.startsWith('data:'))return request;throw Error('External model resource blocked');});
  const gltf=await new GLTFLoader(manager).parseAsync(bytes,'');scene.add(gltf.scene);
  if(!isCurrent()||signal?.aborted){dispose();return null;}
  const box=new THREE.Box3().setFromObject(gltf.scene),size=box.getSize(new THREE.Vector3()),center=box.getCenter(new THREE.Vector3());
  if(box.isEmpty()||![size.x,size.y,size.z,center.x,center.y,center.z].every(Number.isFinite))throw Error('Invalid model bounds');
  gltf.scene.position.sub(center);
  const radius=Math.max(size.length()/2,.01),distance=radius/Math.sin(THREE.MathUtils.degToRad(camera.fov/2))*1.2;
  camera.near=radius/100;camera.far=radius*100;camera.updateProjectionMatrix();
  controls.minDistance=radius*.7;controls.maxDistance=radius*12;
  gltf.scene.traverse(o=>{if(o.isMesh){o.castShadow=true;o.receiveShadow=true;}});
  key.position.set(-3*radius,5*radius,4*radius);key.target.position.set(0,0,0);
  fill.position.set(4*radius,2*radius,-3*radius);fill.target.position.set(0,0,0);
  const extent=radius*1.65;Object.assign(key.shadow.camera,{left:-extent,right:extent,top:extent,bottom:-extent,near:radius*.05,far:radius*15});
  key.shadow.camera.updateProjectionMatrix();key.shadow.normalBias=radius*.002;
  const ground=new THREE.Mesh(new THREE.PlaneGeometry(radius*12,radius*12),new THREE.ShadowMaterial({opacity:VIEWER_APPEARANCE.shadowOpacity}));
  ground.name='Preview_shadow_receiver_not_asset';ground.rotation.x=-Math.PI/2;
  ground.position.y=box.min.y-center.y-radius*.002;ground.receiveShadow=true;scene.add(ground);
  renderer.shadowMap.needsUpdate=true;
  const resize=()=>{if(disposed)return;const w=Math.max(container.clientWidth,1),h=Math.max(container.clientHeight,1);renderer.setSize(w,h,false);camera.aspect=w/h;camera.updateProjectionMatrix();requestRender();};
  observer=new ResizeObserver(resize);observer.observe(container);resize();
  const reset=()=>{if(disposed)return;controls.target.set(0,0,0);camera.position.set(distance*.7,distance*.5,distance*.85);controls.update();requestRender();};
  signal?.addEventListener('abort',dispose,{once:true});reset();
  return {dispose,reset};
 }catch(error){dispose();throw error;}
}
