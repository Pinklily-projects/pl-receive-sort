/* ============================================================
   Pink Lily Web FX — GSAP + Three.js motion, drop-in.
   Requires (load BEFORE this file), all from CDN:
     three.js r128, gsap 3.x, and (optional) vanta.fog.
   Everything degrades gracefully if a library is missing.
   Public API: window.PLFX = { setCalm, animateCounts, entrance }
   ============================================================ */
(function(){
  "use strict";
  var reduceMotion = !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
  var CALM=false, headerInited=false, headerActive=false, headerTick=null, vanta=null;

  /* ---------- Three.js floating-petal header ---------- */
  function createHeader(){
    var canvas=document.getElementById('fx-bg'); var host=canvas&&canvas.parentElement;
    if(!canvas||!host||!window.THREE) return;
    var w=host.clientWidth||1, h=host.clientHeight||1;
    var renderer=new THREE.WebGLRenderer({canvas:canvas,alpha:true,antialias:true});
    renderer.setPixelRatio(Math.min(window.devicePixelRatio||1,2)); renderer.setSize(w,h,false);
    var scene=new THREE.Scene();
    var camera=new THREE.PerspectiveCamera(60,w/h,0.1,1000); camera.position.z=60;
    var c=document.createElement('canvas'); c.width=c.height=64; var g=c.getContext('2d');
    var rg=g.createRadialGradient(32,32,0,32,32,32);
    rg.addColorStop(0,'rgba(255,255,255,1)'); rg.addColorStop(.4,'rgba(255,255,255,.55)'); rg.addColorStop(1,'rgba(255,255,255,0)');
    g.fillStyle=rg; g.beginPath(); g.arc(32,32,32,0,Math.PI*2); g.fill();
    var tex=new THREE.CanvasTexture(c);
    var N=440, pos=new Float32Array(N*3), spd=new Float32Array(N);
    for(var i=0;i<N;i++){ pos[i*3]=(Math.random()-.5)*210; pos[i*3+1]=(Math.random()-.5)*110; pos[i*3+2]=(Math.random()-.5)*90; spd[i]=.02+Math.random()*.08; }
    var geo=new THREE.BufferGeometry(); geo.setAttribute('position',new THREE.BufferAttribute(pos,3));
    var mat=new THREE.PointsMaterial({size:2.6,map:tex,transparent:true,opacity:.9,depthWrite:false,blending:THREE.AdditiveBlending});
    var pts=new THREE.Points(geo,mat); scene.add(pts);
    var mx=0,my=0;
    host.addEventListener('mousemove',function(e){ var r=host.getBoundingClientRect(); mx=(e.clientX-r.left)/r.width-.5; my=(e.clientY-r.top)/r.height-.5; });
    window.addEventListener('resize',function(){ w=host.clientWidth||1; h=host.clientHeight||1; renderer.setSize(w,h,false); camera.aspect=w/h; camera.updateProjectionMatrix(); });
    headerTick=function(){ if(!headerActive) return; var p=geo.attributes.position.array;
      for(var i=0;i<N;i++){ p[i*3+1]+=spd[i]; if(p[i*3+1]>54) p[i*3+1]=-54; }
      geo.attributes.position.needsUpdate=true; pts.rotation.y+=.0006;
      camera.position.x+=(mx*18-camera.position.x)*.04; camera.position.y+=(-my*9-camera.position.y)*.04; camera.lookAt(0,0,0);
      renderer.render(scene,camera); requestAnimationFrame(headerTick); };
    headerInited=true; headerActive=true; headerTick();
  }
  function startHeader(){ if(reduceMotion||CALM) return; try{ if(!headerInited){ if(window.THREE) createHeader(); } else if(!headerActive){ headerActive=true; headerTick&&headerTick(); } }catch(e){} }
  function stopHeader(){ headerActive=false; }

  /* ---------- Vanta fog full-page background (optional) ---------- */
  function startVanta(){ if(reduceMotion||CALM||vanta||!window.VANTA||!window.VANTA.FOG||!document.getElementById('fx-fog')) return;
    try{ vanta=VANTA.FOG({ el:'#fx-fog', THREE:window.THREE, mouseControls:false, touchControls:false, gyroControls:false,
      highlightColor:0xff5db1, midtoneColor:0xd6196c, lowlightColor:0xa8124f, baseColor:0xfdf3f8, blurFactor:0.62, speed:1.4, zoom:0.85 }); }catch(e){} }
  function stopVanta(){ if(vanta){ try{vanta.destroy();}catch(e){} vanta=null; } }
  function fogParallax(){ var el=document.getElementById('fx-fog'); if(!el) return; var rid=null,tx=0,ty=0;
    window.addEventListener('mousemove',function(e){ if(CALM||reduceMotion) return; tx=(e.clientX/window.innerWidth-.5)*-40; ty=(e.clientY/window.innerHeight-.5)*-40;
      if(!rid) rid=requestAnimationFrame(function(){ el.style.transform='translate3d('+tx.toFixed(1)+'px,'+ty.toFixed(1)+'px,0)'; rid=null; }); }); }

  /* ---------- GSAP helpers ---------- */
  // Animate any element with [data-count="123"] from 0 -> value.
  function animateCounts(scope){ scope=scope||document;
    var els=scope.querySelectorAll('[data-count]');
    if(!window.gsap || CALM){ els.forEach(function(el){ el.textContent=(parseFloat(el.dataset.count)||0).toLocaleString(); }); return; }
    els.forEach(function(el){ var to=parseFloat(el.dataset.count)||0, o={v:0};
      gsap.to(o,{v:to,duration:.7,ease:'power2.out',onUpdate:function(){ el.textContent=Math.round(o.v).toLocaleString(); }}); });
  }
  // Stagger-in any elements marked [data-fx-in] (once).
  function entrance(scope){ scope=scope||document;
    if(!window.gsap || CALM) return;
    var els=scope.querySelectorAll('[data-fx-in]'); if(!els.length) return;
    gsap.from(els,{opacity:0,y:18,duration:.5,stagger:.05,ease:'power2.out'});
  }

  /* ---------- Calm mode (persisted; auto-on for low-end / reduced-motion) ---------- */
  function setCalm(on){ CALM=!!on; document.body.classList.toggle('calm',CALM);
    try{ localStorage.setItem('fx_calm', CALM?'1':'0'); }catch(e){}
    document.querySelectorAll('[data-fx-calm]').forEach(function(b){ b.setAttribute('aria-pressed', CALM?'true':'false'); b.dataset.state=CALM?'off':'on'; });
    var fog=document.getElementById('fx-fog');
    if(CALM){ stopHeader(); stopVanta(); if(fog){ fog.style.display='none'; fog.style.transform='none'; } }
    else{ if(fog) fog.style.display=''; startHeader(); startVanta(); }
  }
  function decideCalm(){ var s=null; try{ s=localStorage.getItem('fx_calm'); }catch(e){}
    if(s==='1') return true; if(s==='0') return false;
    var cores=navigator.hardwareConcurrency||8, mem=navigator.deviceMemory||8;
    return reduceMotion || cores<=4 || mem<=4;
  }

  /* ---------- boot ---------- */
  function boot(){
    CALM=decideCalm(); document.body.classList.toggle('calm',CALM);
    if(!CALM){ startHeader(); startVanta(); } else { var f=document.getElementById('fx-fog'); if(f) f.style.display='none'; }
    fogParallax();
    document.querySelectorAll('[data-fx-calm]').forEach(function(b){ b.addEventListener('click',function(){ setCalm(!CALM); }); });
    animateCounts(document); entrance(document);
  }
  window.PLFX={ setCalm:setCalm, animateCounts:animateCounts, entrance:entrance, isCalm:function(){return CALM;} };
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',boot); else boot();
})();
