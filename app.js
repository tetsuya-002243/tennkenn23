document.addEventListener("gesturestart",e=>e.preventDefault());
let lastTouchEnd=0;document.addEventListener("touchend",e=>{let now=Date.now();if(now-lastTouchEnd<=300)e.preventDefault();lastTouchEnd=now},{passive:false});
pdfjsLib.GlobalWorkerOptions.workerSrc="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
const $=id=>document.getElementById(id);

const app={bridges:{},currentBridgeId:null,currentPdfId:null};
const view={pdf:null,page:1,pages:0,w:0,h:0,scale:1,tx:0,ty:0,tool:"move",selected:null,pendingIcon:null,relocate:null,pointers:new Map(),down:null,pan:null,pinch:null,drawing:false,stroke:null};

// ---------- IndexedDB (PDF本体・写真本体はここに保存し、localStorageには軽い情報だけを置く) ----------
let fileDb=null;
const FILE_DB_NAME="fieldbook_v21_files";
const FILE_DB_VERSION=2;
function openFileDb(){
  return new Promise((resolve,reject)=>{
    const req=indexedDB.open(FILE_DB_NAME,FILE_DB_VERSION);
    req.onupgradeneeded=e=>{
      const db=e.target.result;
      if(!db.objectStoreNames.contains("pdfs"))db.createObjectStore("pdfs");
      if(!db.objectStoreNames.contains("photos"))db.createObjectStore("photos");
    };
    req.onsuccess=e=>{fileDb=e.target.result;resolve(fileDb)};
    req.onerror=e=>reject(e);
  });
}
function dbPut(store,key,value){
  return new Promise((resolve,reject)=>{
    const tx=fileDb.transaction(store,"readwrite");
    tx.objectStore(store).put(value,key);
    tx.oncomplete=()=>resolve();
    tx.onerror=e=>reject(e);
  });
}
function dbGet(store,key){
  return new Promise((resolve,reject)=>{
    const tx=fileDb.transaction(store,"readonly");
    const req=tx.objectStore(store).get(key);
    req.onsuccess=()=>resolve(req.result);
    req.onerror=e=>reject(e);
  });
}
function dbDelete(store,key){
  return new Promise((resolve,reject)=>{
    if(!key||!fileDb){resolve();return;}
    const tx=fileDb.transaction(store,"readwrite");
    tx.objectStore(store).delete(key);
    tx.oncomplete=()=>resolve();
    tx.onerror=e=>reject(e);
  });
}
function putPdfFile(key,file){return dbPut("pdfs",key,file);}
function getPdfFile(key){return dbGet("pdfs",key);}
function deletePdfFile(key){return dbDelete("pdfs",key);}
function putPhotoBlob(key,blob){return dbPut("photos",key,blob);}
function getPhotoBlob(key){return dbGet("photos",key);}
function deletePhotoBlob(key){return dbDelete("photos",key);}

// 写真のBlob→表示用URLはメモリ上にキャッシュ（毎回IndexedDBを読みに行かないため）
const photoUrlCache=new Map();
async function getPhotoUrl(id){
  if(photoUrlCache.has(id))return photoUrlCache.get(id);
  if(!fileDb)await openFileDb();
  const blob=await getPhotoBlob(id);
  if(!blob)return null;
  const url=URL.createObjectURL(blob);
  photoUrlCache.set(id,url);
  return url;
}

function uid(){return Date.now().toString(36)+Math.random().toString(36).slice(2,7)}
function safe(s){return String(s||"橋梁").replace(/[\\/:*?"<>| 　]/g,"_")}

// ---------- localStorageの保存・読込（写真本体は含めない軽い情報のみ） ----------
const STORAGE_KEY="fieldbook_v22";
const LEGACY_STORAGE_KEYS=["fieldbook_v20","fieldbook_v21"];

function save(){
  try{
    localStorage.setItem(STORAGE_KEY,JSON.stringify(app));
  }catch(err){
    alert("保存に失敗しました。端末の空き容量が不足している可能性があります。不要な橋梁やPDFを削除するか、バックアップ後にデータ整理をしてください。\n詳細: "+(err.message||err));
  }
  renderLists();
}
function load(){
  try{Object.assign(app,JSON.parse(localStorage.getItem(STORAGE_KEY)||"{}"))}catch(e){}
  renderLists();
}

// v20/v21時代は写真をbase64のままlocalStorageに保存していたため、
// 起動時に一度だけ写真本体をIndexedDBへ移し、点検箇所番号(no)や損傷入力欄の初期値を補う。
async function migrateLegacyData(){
  if(localStorage.getItem(STORAGE_KEY))return false;
  let oldRaw=null,oldKeyFound=null;
  for(const k of LEGACY_STORAGE_KEYS){
    const v=localStorage.getItem(k);
    if(v){oldRaw=v;oldKeyFound=k;break;}
  }
  if(!oldRaw)return false;
  let old;
  try{old=JSON.parse(oldRaw);}catch(e){return false;}
  if(!old||!old.bridges)return false;
  if(!fileDb)await openFileDb();
  for(const bId in old.bridges){
    const b=old.bridges[bId];
    b.photoSeq=b.photoSeq||1;
    b.iconSeq=b.iconSeq||1;
    const newPhotos=[];
    for(const p of (b.photos||[])){
      if(p&&p.src){
        try{
          const buf=dataUrlToArrayBuffer(p.src);
          const blob=new Blob([buf],{type:"image/jpeg"});
          await putPhotoBlob(p.id,blob);
        }catch(err){console.warn("写真の移行に失敗しました",p.id,err);}
        newPhotos.push({id:p.id,name:p.name,takenAt:p.takenAt||Date.now()});
      }else if(p){
        newPhotos.push(p);
      }
    }
    b.photos=newPhotos;
    let maxNo=0;
    (b.pdfs||[]).forEach(pdf=>{
      (pdf.icons||[]).forEach(icon=>{
        if(icon.no==null){maxNo++;icon.no=maxNo;}else{maxNo=Math.max(maxNo,icon.no);}
        icon.member=icon.member||"";icon.damageType=icon.damageType||"";icon.rank=icon.rank||"";icon.comment=icon.comment||"";
      });
    });
    b.iconSeq=Math.max(b.iconSeq,maxNo+1);
  }
  try{
    localStorage.setItem(STORAGE_KEY,JSON.stringify(old));
    localStorage.removeItem(oldKeyFound);
  }catch(err){
    console.warn("移行データの保存に失敗しました",err);
    return false;
  }
  return true;
}

function currentBridge(){return app.bridges[app.currentBridgeId]}
function currentPdf(){const b=currentBridge();return b?b.pdfs.find(p=>p.id===app.currentPdfId):null}
function show(id){document.querySelectorAll(".page").forEach(p=>p.classList.remove("active"));$(id).classList.add("active");if(id==="savePage")renderSave();}
$("homeBtn").onclick=()=>show("home");$("editBtn").onclick=()=>show("editor");$("saveBtn").onclick=()=>show("savePage");

$("createBridgeBtn").onclick=()=>{
  const name=$("newBridgeName").value.trim();
  if(!name)return alert("橋梁名を入力してください");
  const id=safe(name);
  if(!app.bridges[id])app.bridges[id]={id,name,pdfs:[],photos:[],photoSeq:1,iconSeq:1};
  app.currentBridgeId=id; save();
};
$("bridgeSearch").oninput=()=>renderLists();

function renderLists(){
  const b=currentBridge();
  $("currentStatus").innerHTML=b?`現在の橋梁：<b>${b.name}</b>　PDF:${b.pdfs.length}　写真:${b.photos.length}`:"現在の橋梁：未選択";
  const q=($("bridgeSearch").value||"").toLowerCase();
  $("bridgeList").innerHTML="";
  Object.values(app.bridges).filter(b=>b.name.toLowerCase().includes(q)).forEach(b=>{
    const div=document.createElement("div");div.className="bridgeCard"+(b.id===app.currentBridgeId?" active":"");
    div.innerHTML=`<div class="bridgeTitle">${b.name}</div><div class="bridgeStats">PDF ${b.pdfs.length}件 / 写真 ${b.photos.length}枚</div><div class="cardActions"></div>`;
    const actions=div.querySelector(".cardActions");
    const open=document.createElement("button");open.textContent="開く";open.onclick=()=>{app.currentBridgeId=b.id;app.currentPdfId=b.pdfs[0]?.id||null;save();renderPdfSelect();};
    const edit=document.createElement("button");edit.textContent="編集";edit.onclick=async()=>{app.currentBridgeId=b.id;app.currentPdfId=b.pdfs[0]?.id||null;save();renderPdfSelect();if(app.currentPdfId)await openPdf(app.currentPdfId);show("editor");};
    const saveBtn=document.createElement("button");saveBtn.textContent="写真保存";saveBtn.onclick=()=>{app.currentBridgeId=b.id;save();show("savePage");};
    actions.append(open,edit,saveBtn);$("bridgeList").appendChild(div);
  });
  renderPdfList();renderPdfSelect();
}
function renderPdfList(){
  const b=currentBridge();$("pdfList").innerHTML="";
  if(!b){$("pdfList").innerHTML="<p>橋梁を選択してください。</p>";return}
  if(!b.pdfs.length){$("pdfList").innerHTML="<p>PDF未登録です。</p>";return}
  b.pdfs.forEach(pdf=>{
    const div=document.createElement("div");div.className="pdfCard";
    div.innerHTML=`<div class="bridgeTitle">${pdf.name}</div><div class="pdfStats">点検箇所 ${pdf.icons.length}件</div><div class="cardActions"></div>`;
    const actions=div.querySelector(".cardActions");
    const edit=document.createElement("button");edit.textContent="編集";edit.onclick=async()=>{app.currentPdfId=pdf.id;save();await openPdf(pdf.id);show("editor");};
    const del=document.createElement("button");del.textContent="PDF削除";del.className="danger";del.onclick=async()=>{await deletePdfRecord(pdf.id);};
    actions.append(edit,del);$("pdfList").appendChild(div);
  });
}
async function deletePdfRecord(pdfId){
  const b=currentBridge();
  if(!b)return;
  const pdf=b.pdfs.find(p=>p.id===pdfId);
  if(!pdf)return;
  if(!confirm(`PDF「${pdf.name}」を削除しますか？\nこのPDF上の点検箇所・ペン記入・紐付く写真も削除されます。`))return;
  const photoIds=[...new Set((pdf.icons||[]).flatMap(i=>i.photoIds||[]))];
  if(!fileDb)await openFileDb();
  for(const pid of photoIds){await deletePhotoBlob(pid);}
  b.photos=b.photos.filter(p=>!photoIds.includes(p.id));
  b.pdfs=b.pdfs.filter(p=>p.id!==pdfId);
  if(app.currentPdfId===pdfId){
    app.currentPdfId=b.pdfs[0]?.id||null;
    view.pdf=null;view.page=1;view.pages=0;view.selected=null;view.pendingIcon=null;
    if($("empty"))$("empty").style.display="flex";
    if($("pageInfo"))$("pageInfo").textContent="PDF未読込";
    if($("iconLayer"))$("iconLayer").innerHTML="";
    if($("pdfCanvas"))$("pdfCanvas").getContext("2d").clearRect(0,0,$("pdfCanvas").width,$("pdfCanvas").height);
    if($("drawCanvas"))$("drawCanvas").getContext("2d").clearRect(0,0,$("drawCanvas").width,$("drawCanvas").height);
  }
  try{
    if(pdf.key){if(!fileDb)await openFileDb();await deletePdfFile(pdf.key);}
  }catch(err){console.warn("IndexedDB内PDF削除に失敗",err);}
  save();
  renderPdfList();renderPdfSelect();renderSave();
}
function renderPdfSelect(){
  const b=currentBridge();$("pdfSelect").innerHTML="";
  if(!b)return;
  b.pdfs.forEach(pdf=>{const o=document.createElement("option");o.value=pdf.id;o.textContent=pdf.name;$("pdfSelect").appendChild(o);});
  if(app.currentPdfId)$("pdfSelect").value=app.currentPdfId;
}
$("pdfInput").onchange=async e=>{
  let b=currentBridge();
  if(!b){
    const name=$("newBridgeName").value.trim()||"新規橋梁";
    const id=safe(name);
    if(!app.bridges[id])app.bridges[id]={id,name,pdfs:[],photos:[],photoSeq:1,iconSeq:1};
    app.currentBridgeId=id;
    b=currentBridge();
  }
  const files=[...e.target.files].filter(f=>f && (f.type==="application/pdf" || f.name.toLowerCase().endsWith(".pdf")));
  if(!files.length){ e.target.value=""; return alert("PDFファイルを選択してください。"); }
  try{
    if(!fileDb)await openFileDb();
    for(const file of files){
      const id=uid();
      const key=`pdf_${b.id}_${id}`;
      await putPdfFile(key,file);
      b.pdfs.push({id,name:file.name,key,icons:[],drawings:[],actions:[]});
      app.currentPdfId=id;
    }
    save();
    renderPdfSelect();
    if(app.currentPdfId){
      await openPdf(app.currentPdfId);
      show("editor");
    }
  }catch(err){
    alert("PDF追加に失敗しました: "+(err.message||err));
  }
  e.target.value="";
};
function dataUrlToArrayBuffer(dataUrl){const b64=dataUrl.split(",")[1];const bin=atob(b64);const arr=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)arr[i]=bin.charCodeAt(i);return arr.buffer}
$("pdfSelect").onchange=()=>openPdf($("pdfSelect").value);
async function openPdf(id){
  const pdf=currentBridge().pdfs.find(p=>p.id===id);
  if(!pdf)return;
  app.currentPdfId=id;
  renderPdfSelect();
  try{
    let buf;
    if(pdf.key){
      if(!fileDb)await openFileDb();
      const blob=await getPdfFile(pdf.key);
      if(!blob)throw new Error("端末内に保存したPDF本体が見つかりません。もう一度PDFを追加してください。");
      buf=await blob.arrayBuffer();
    }else if(pdf.data){
      buf=dataUrlToArrayBuffer(pdf.data);
    }else{
      throw new Error("PDFデータがありません。");
    }
    view.pdf=await pdfjsLib.getDocument({data:buf}).promise;
    view.pages=view.pdf.numPages;
    view.page=1;
    view.selected=null;
    await renderPage();
  }catch(err){
    alert("PDFを開けませんでした: "+(err.message||err));
  }
}
function buildPageInfo(){$("pageInfo").textContent=view.pages?`${view.page} / ${view.pages}ページ`:"PDF未読込"}
$("prevPage").onclick=()=>goPage(view.page-1);$("nextPage").onclick=()=>goPage(view.page+1);
async function goPage(n){if(!view.pdf||n<1||n>view.pages)return;view.page=n;view.selected=null;await renderPage();}
async function renderPage(){
  const page=await view.pdf.getPage(view.page);
  const v0=page.getViewport({scale:1});
  // iPad/iPhoneのSafariはcanvasの解像度に上限があるため、鮮明さと安全マージンを両立させる
  const dpr=Math.min(window.devicePixelRatio||1,2);
  const wrapWidth=$("canvasWrap").clientWidth||1024;
  let sc=Math.min(2.2,(wrapWidth*dpr*1.4)/v0.width);
  const MAX_DIM=4000;
  if(v0.width*sc>MAX_DIM)sc=MAX_DIM/v0.width;
  if(v0.height*sc>MAX_DIM)sc=MAX_DIM/v0.height;
  sc=Math.max(sc,.5);
  const v=page.getViewport({scale:sc});
  ["pdfCanvas","drawCanvas"].forEach(id=>{$(id).width=v.width;$(id).height=v.height;});
  view.w=v.width;view.h=v.height;
  $("stage").style.width=v.width+"px";$("stage").style.height=v.height+"px";$("iconLayer").style.width=v.width+"px";$("iconLayer").style.height=v.height+"px";
  $("empty").style.display="none";buildPageInfo();
  await page.render({canvasContext:$("pdfCanvas").getContext("2d"),viewport:v}).promise;
  fit();renderAll();
}
function fit(){let vw=$("canvasWrap").clientWidth,vh=$("canvasWrap").clientHeight;view.scale=Math.min(vw/view.w,vh/view.h)*.98;view.tx=(vw-view.w*view.scale)/2;view.ty=10;applyTransform();}
function applyTransform(){$("stage").style.transform=`translate(${view.tx}px,${view.ty}px) scale(${view.scale})`;}
$("resetView").onclick=()=>fit();
function toPdf(x,y){let r=$("canvasWrap").getBoundingClientRect();return{x:(x-r.left-view.tx)/view.scale,y:(y-r.top-view.ty)/view.scale};}
function setTool(t){view.tool=t;view.relocate=null;document.querySelectorAll(".tool").forEach(b=>b.classList.remove("active"));({move:"moveTool",photo:"photoTool",pen:"penTool",eraser:"eraserTool"}[t]&&$(({move:"moveTool",photo:"photoTool",pen:"penTool",eraser:"eraserTool"}[t])).classList.add("active"));$("drawCanvas").style.pointerEvents=(t==="pen"||t==="eraser")?"auto":"none";}
$("moveTool").onclick=()=>setTool("move");$("photoTool").onclick=()=>setTool("photo");$("penTool").onclick=()=>setTool("pen");$("eraserTool").onclick=()=>setTool("eraser");

$("canvasWrap").onpointerdown=e=>{
  if(e.target && e.target.closest && e.target.closest(".photoIcon")) return;
  $("canvasWrap").setPointerCapture(e.pointerId);view.pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});view.down={x:e.clientX,y:e.clientY,t:Date.now(),tool:view.tool,pointerId:e.pointerId};
  const p=toPdf(e.clientX,e.clientY);
  if(view.relocate){moveIcon(view.relocate,p);return}
  if(view.tool==="photo")return;
  if(view.tool==="pen"||view.tool==="eraser"){startStroke(e);return}
  view.pan={x:e.clientX,y:e.clientY};
};
$("canvasWrap").onpointermove=e=>{
  if(!view.pointers.has(e.pointerId))return;view.pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
  if((view.tool==="pen"||view.tool==="eraser")&&view.drawing){moveStroke(e);return}
  if(view.tool==="photo")return;
  if(view.tool!=="move")return;
  const pts=[...view.pointers.values()];
  if(pts.length===1&&view.pan){view.tx+=e.clientX-view.pan.x;view.ty+=e.clientY-view.pan.y;view.pan={x:e.clientX,y:e.clientY};applyTransform();}
  else if(pts.length>=2){const d=Math.hypot(pts[0].x-pts[1].x,pts[0].y-pts[1].y),c={x:(pts[0].x+pts[1].x)/2,y:(pts[0].y+pts[1].y)/2};if(view.pinch){const before=toPdf(c.x,c.y);view.scale=Math.min(6,Math.max(.15,view.scale*d/view.pinch.d));const r=$("canvasWrap").getBoundingClientRect();view.tx=c.x-r.left-before.x*view.scale;view.ty=c.y-r.top-before.y*view.scale;applyTransform();}view.pinch={d,c};}
};
$("canvasWrap").onpointerup=$("canvasWrap").onpointercancel=e=>{
  if(e.target && e.target.closest && e.target.closest(".photoIcon")){
    view.pointers.delete(e.pointerId);view.pan=null;view.pinch=null;view.down=null;
    return;
  }
  if((view.tool==="pen"||view.tool==="eraser")&&view.drawing)endStroke();
  if(view.down&&view.down.tool==="photo"&&view.down.pointerId===e.pointerId){
    const dx=e.clientX-view.down.x,dy=e.clientY-view.down.y;
    if(Math.hypot(dx,dy)<16)createPhotoIcon(toPdf(e.clientX,e.clientY)); else setTool("move");
  }else if(view.down&&view.down.tool==="move"&&view.pointers.size===1){
    const dx=e.clientX-view.down.x,dy=e.clientY-view.down.y,dt=Date.now()-view.down.t;
    if(Math.abs(dx)>80&&Math.abs(dx)>Math.abs(dy)*1.15&&dt<1200)goPage(dx<0?view.page+1:view.page-1);
  }
  view.pointers.delete(e.pointerId);view.pan=null;view.pinch=null;view.down=null;
};
function pdfData(){return currentPdf()}
function createPhotoIcon(p){
  const pdf=pdfData();if(!pdf)return alert("PDFを開いてください");
  if(view.pendingIcon)return;
  if(view.lastIconAt && Date.now()-view.lastIconAt<700)return;
  view.lastIconAt=Date.now();
  const b=currentBridge();
  if(b.iconSeq==null)b.iconSeq=1;
  const id=uid();
  const icon={id,no:b.iconSeq++,page:view.page,x:p.x/view.w,y:p.y/view.h,photoIds:[],member:"",damageType:"",rank:"",comment:"",updatedAt:Date.now()};
  pdf.icons.push(icon);pdf.actions.push({type:"addIcon",id});view.selected=id;view.pendingIcon=id;renderAll();setTool("move");$("cameraInput").click();save();
}
$("cameraInput").onchange=async e=>{const icon=pdfData()?.icons.find(i=>i.id===view.pendingIcon);if(icon&&e.target.files.length){await addPhotos(icon,[...e.target.files]);openPhotoModal(icon.id);}view.pendingIcon=null;e.target.value="";save();}
$("addPhotoInput").onchange=async e=>{const icon=pdfData()?.icons.find(i=>i.id===view.selected);if(icon&&e.target.files.length){await addPhotos(icon,[...e.target.files]);openPhotoModal(icon.id);}e.target.value="";save();}
async function addPhotos(icon,files){
  const b=currentBridge(),added=[];
  if(!fileDb)await openFileDb();
  for(const f of files){
    try{
      const blob=await resizeImage(f);
      const id=uid();
      const name=`${safe(b.name)}_${String(b.photoSeq++).padStart(3,"0")}.jpg`;
      await putPhotoBlob(id,blob);
      b.photos.push({id,name,takenAt:Date.now()});
      icon.photoIds.push(id);
      added.push(id);
    }catch(err){alert("写真の保存に失敗しました: "+(err.message||err));}
  }
  if(added.length)pdfData().actions.push({type:"addPhotos",iconId:icon.id,photoIds:added});
  renderAll();
}
function resizeImage(file){
  return new Promise((resolve,reject)=>{
    const r=new FileReader();
    r.onload=()=>{
      const img=new Image();
      img.onload=()=>{
        const sc=Math.min(1,1800/img.width),cv=document.createElement("canvas");
        cv.width=Math.round(img.width*sc);cv.height=Math.round(img.height*sc);
        cv.getContext("2d").drawImage(img,0,0,cv.width,cv.height);
        cv.toBlob(blob=>{if(blob)resolve(blob);else reject(new Error("画像の変換に失敗しました"));},"image/jpeg",.86);
      };
      img.onerror=()=>reject(new Error("画像の読み込みに失敗しました"));
      img.src=r.result;
    };
    r.onerror=()=>reject(new Error("ファイルの読み込みに失敗しました"));
    r.readAsDataURL(file);
  });
}
function iconPhotos(icon){const b=currentBridge();return icon.photoIds.map(id=>b.photos.find(p=>p.id===id)).filter(Boolean)}
async function renderIcons(){
  const layer=$("iconLayer");layer.innerHTML="";
  const pdf=pdfData();
  updateIconCounter();
  if(!pdf)return;
  const icons=pdf.icons.filter(i=>i.page===view.page);
  icons.forEach(icon=>{
    const ps=iconPhotos(icon);
    const d=document.createElement("div");
    const rankClass=icon.rank?` rank-${icon.rank}`:"";
    d.className="photoIcon "+(ps.length?"hasPhoto":"noPhoto")+rankClass+(icon.id===view.selected?" selected":"");
    d.style.left=(icon.x*view.w)+"px";d.style.top=(icon.y*view.h)+"px";
    d.innerHTML=ps.length?`<img data-photo-id="${ps[0].id}"><span class="num">${icon.no}</span>`:`<span class="num">${icon.no}</span>`;
    d.onpointerdown=e=>{e.stopPropagation();};
    d.onpointerup=e=>{e.stopPropagation();};
    d.onclick=e=>{e.stopPropagation();view.selected=icon.id;renderAll();openPhotoModal(icon.id)};
    layer.appendChild(d);
  });
  for(const icon of icons){
    const ps=iconPhotos(icon);
    if(!ps.length)continue;
    const img=layer.querySelector(`img[data-photo-id="${ps[0].id}"]`);
    if(!img)continue;
    getPhotoUrl(ps[0].id).then(url=>{if(url&&img.isConnected)img.src=url;});
  }
}
function updateIconCounter(){
  const el=$("iconCounter");if(!el)return;
  const pdf=pdfData();
  if(!pdf){el.textContent="";return;}
  const total=pdf.icons.length,missing=pdf.icons.filter(i=>!i.photoIds.length).length;
  el.textContent=`点検箇所:${total}　写真なし:${missing}`;
}
async function openPhotoModal(id){
  const icon=pdfData()?.icons.find(i=>i.id===id);if(!icon)return;
  const ps=iconPhotos(icon);
  $("photoModalTitle").textContent=`点検箇所 No.${icon.no}`+(icon.rank?`（ランク${icon.rank.toUpperCase()}）`:"")+`：${ps.length}枚`;
  $("takeMorePhoto").textContent=ps.length?"続けて撮影":"撮影";
  $("iconMember").value=icon.member||"";
  $("iconDamageType").value=icon.damageType||"";
  $("iconRank").value=icon.rank||"";
  $("iconComment").value=icon.comment||"";
  await renderModalPhotos(ps);
  $("photoModal").classList.remove("hidden");
}
async function renderModalPhotos(ps){
  $("modalPhotos").innerHTML=ps.length?ps.map(p=>`<div class="photoBox"><img data-photo-id="${p.id}"><span>${p.name}</span></div>`).join(""):"<p>まだ写真がありません。</p>";
  for(const p of ps){
    const url=await getPhotoUrl(p.id);
    const img=$("modalPhotos").querySelector(`img[data-photo-id="${p.id}"]`);
    if(img&&url)img.src=url;
  }
}
$("closeModal").onclick=()=>$("photoModal").classList.add("hidden");$("takeMorePhoto").onclick=()=>{$("photoModal").classList.add("hidden");$("addPhotoInput").click()};$("moveIconBtn").onclick=()=>{if(!view.selected)return;view.relocate=view.selected;$("photoModal").classList.add("hidden");setTool("move");alert("新しい位置をPDF上で1回タップしてください")};
function moveIcon(id,p){const icon=pdfData()?.icons.find(i=>i.id===id);if(!icon)return;pdfData().actions.push({type:"moveIcon",id,old:{page:icon.page,x:icon.x,y:icon.y}});icon.page=view.page;icon.x=p.x/view.w;icon.y=p.y/view.h;view.relocate=null;renderAll();save();}
$("deleteIconBtn").onclick=async()=>{
  const pdf=pdfData();if(!pdf||!view.selected)return;
  const icon=pdf.icons.find(i=>i.id===view.selected);
  if(!confirm("この点検箇所（写真・入力内容）を削除します。よろしいですか？"))return;
  if(icon){
    const b=currentBridge();
    if(!fileDb)await openFileDb();
    for(const pid of icon.photoIds){await deletePhotoBlob(pid);}
    b.photos=b.photos.filter(p=>!icon.photoIds.includes(p.id));
  }
  pdf.icons=pdf.icons.filter(i=>i.id!==view.selected);
  view.selected=null;
  $("photoModal").classList.add("hidden");
  renderAll();save();
};

function bindIconField(id,prop){
  const el=$(id);
  el.oninput=()=>{const icon=pdfData()?.icons.find(i=>i.id===view.selected);if(!icon)return;icon[prop]=el.value;};
  el.onchange=()=>{const icon=pdfData()?.icons.find(i=>i.id===view.selected);if(!icon)return;icon[prop]=el.value;icon.updatedAt=Date.now();save();renderAll();};
}
bindIconField("iconMember","member");
bindIconField("iconDamageType","damageType");
bindIconField("iconRank","rank");
bindIconField("iconComment","comment");

function startStroke(e){const p=toPdf(e.clientX,e.clientY);const er=view.tool==="eraser";view.drawing=true;view.stroke={page:view.page,pts:[{x:p.x/view.w,y:p.y/view.h}],color:er?"#fff":$("penColor").value,width:er?Number($("eraserSize").value):Number($("penSize").value),erase:er};}
function moveStroke(e){const p=toPdf(e.clientX,e.clientY);view.stroke.pts.push({x:p.x/view.w,y:p.y/view.h});draw(true)}
function endStroke(){if(view.stroke&&view.stroke.pts.length>1){pdfData().drawings.push(view.stroke);pdfData().actions.push({type:"draw"});}view.stroke=null;view.drawing=false;draw();save();}
function draw(includeCurrent=false){const ctx=$("drawCanvas").getContext("2d");ctx.clearRect(0,0,view.w,view.h);const pdf=pdfData();if(!pdf)return;let arr=(pdf.drawings||[]).filter(s=>s.page===view.page);if(includeCurrent&&view.stroke)arr=arr.concat([view.stroke]);arr.forEach(s=>{ctx.save();ctx.globalCompositeOperation=s.erase?"destination-out":"source-over";ctx.strokeStyle=s.color;ctx.lineWidth=s.width;ctx.lineCap="round";ctx.lineJoin="round";ctx.beginPath();ctx.moveTo(s.pts[0].x*view.w,s.pts[0].y*view.h);s.pts.slice(1).forEach(p=>ctx.lineTo(p.x*view.w,p.y*view.h));ctx.stroke();ctx.restore();});}
function renderAll(){renderIcons();draw();}
$("undoBtn").onclick=async()=>{
  const pdf=pdfData();if(!pdf)return;
  const a=pdf.actions.pop();if(!a)return alert("戻せる作業がありません");
  const b=currentBridge();
  if(!fileDb)await openFileDb();
  if(a.type==="draw")pdf.drawings.pop();
  if(a.type==="addIcon"){
    const ic=pdf.icons.find(i=>i.id===a.id);
    if(ic){
      for(const pid of ic.photoIds){await deletePhotoBlob(pid);}
      b.photos=b.photos.filter(p=>!ic.photoIds.includes(p.id));
    }
    pdf.icons=pdf.icons.filter(i=>i.id!==a.id);
  }
  if(a.type==="addPhotos"){
    const ic=pdf.icons.find(i=>i.id===a.iconId);
    if(ic)ic.photoIds=ic.photoIds.filter(id=>!a.photoIds.includes(id));
    for(const pid of a.photoIds){await deletePhotoBlob(pid);}
    b.photos=b.photos.filter(p=>!a.photoIds.includes(p.id));
  }
  if(a.type==="moveIcon"){
    const ic=pdf.icons.find(i=>i.id===a.id);
    if(ic){ic.page=a.old.page;ic.x=a.old.x;ic.y=a.old.y;}
  }
  renderAll();renderSave();save();
};
function emptyIcons(){const b=currentBridge();if(!b)return[];return b.pdfs.flatMap(pdf=>pdf.icons.filter(i=>i.photoIds.length===0))}
function validatePhotos(){const e=emptyIcons();if(e.length){alert(`写真が入っていない点検箇所が ${e.length} 個あります。写真を追加するか、不要な点検箇所を削除してください。`);return false}return true}
function renderSave(){
  const b=currentBridge();
  if(!b){$("saveSummary").textContent="橋梁未選択";$("photoList").innerHTML="";return}
  const rankCounts={a:0,b:0,c:0,d:0,e:0,"":0};
  b.pdfs.forEach(pdf=>pdf.icons.forEach(ic=>{const k=ic.rank||"";rankCounts[k]=(rankCounts[k]||0)+1;}));
  const rankSummary=["a","b","c","d","e"].map(r=>`${r.toUpperCase()}:${rankCounts[r]||0}`).join(" / ");
  $("saveSummary").innerHTML=`橋梁：<b>${b.name}</b><br>PDF：${b.pdfs.length}件　写真：${b.photos.length}枚　写真なし点検箇所：${emptyIcons().length}個<br>損傷程度の内訳：${rankSummary}　（未入力 ${rankCounts[""]||0}件）`;
  $("photoList").innerHTML=b.photos.map(p=>`<div class="photoBox"><img data-photo-id="${p.id}"><span>${p.name}</span></div>`).join("");
  b.photos.forEach(p=>{getPhotoUrl(p.id).then(url=>{const img=$("photoList").querySelector(`img[data-photo-id="${p.id}"]`);if(img&&url)img.src=url;});});
}
$("zipPhotos").onclick=async()=>{
  const b=currentBridge();if(!b)return;
  if(!validatePhotos())return;
  if(!b.photos.length)return alert("写真がありません");
  if(!fileDb)await openFileDb();
  const z=new JSZip();
  for(const p of b.photos){
    const blob=await getPhotoBlob(p.id);
    if(blob)z.file(p.name,blob);
  }
  download(await z.generateAsync({type:"blob"}),`${safe(b.name)}_写真.zip`);
};
$("csvOut").onclick=()=>{
  const b=currentBridge();if(!b)return;
  if(!validatePhotos())return;
  const rows=[["橋梁名","PDF名","ページ","点検箇所No","部材名","損傷種類","損傷程度","コメント","写真名","X","Y"]];
  b.pdfs.forEach(pdf=>pdf.icons.slice().sort((x,y)=>x.no-y.no).forEach(ic=>{
    rows.push([b.name,pdf.name,ic.page,ic.no,ic.member||"",ic.damageType||"",ic.rank||"",ic.comment||"",iconPhotos(ic).map(p=>p.name).join(" / "),ic.x.toFixed(4),ic.y.toFixed(4)]);
  }));
  download(new Blob(["﻿"+rows.map(r=>r.map(v=>`"${String(v??"").replace(/"/g,'""')}"`).join(",")).join("\n")],{type:"text/csv"}),`${safe(b.name)}_写真野帳.csv`);
};
$("openOneDrive").onclick=()=>window.open("https://onedrive.live.com/","_blank");
function download(blob,name){const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download=name;a.click();}

// ---------- 橋梁データ全体のバックアップ／復元（他端末への引継ぎ・機種変更対策） ----------
$("backupAllBtn").onclick=async()=>{
  try{
    if(!fileDb)await openFileDb();
    if(!Object.keys(app.bridges).length)return alert("バックアップする橋梁データがありません");
    const z=new JSZip();
    const pdfFolder=z.folder("pdfs");
    const photoFolder=z.folder("photos");
    for(const bId in app.bridges){
      const b=app.bridges[bId];
      for(const pdf of b.pdfs){
        if(pdf.key){
          const blob=await getPdfFile(pdf.key);
          if(blob)pdfFolder.file(pdf.key,blob);
        }
      }
      for(const p of b.photos){
        const blob=await getPhotoBlob(p.id);
        if(blob)photoFolder.file(p.id,blob);
      }
    }
    z.file("data.json",JSON.stringify(app));
    const blob=await z.generateAsync({type:"blob"});
    download(blob,`写真野帳バックアップ_${new Date().toISOString().slice(0,10)}.zip`);
  }catch(err){alert("バックアップ作成に失敗しました: "+(err.message||err));}
};
$("restoreInput").onchange=async e=>{
  const file=e.target.files[0];e.target.value="";
  if(!file)return;
  if(!confirm("バックアップを読み込みます。同じ橋梁名のデータは上書きされます。よろしいですか？"))return;
  try{
    if(!fileDb)await openFileDb();
    const z=await JSZip.loadAsync(file);
    const dataFile=z.file("data.json");
    if(!dataFile)throw new Error("data.jsonが見つかりません（対応形式のバックアップZIPではありません）");
    const meta=JSON.parse(await dataFile.async("string"));
    for(const bId in (meta.bridges||{})){
      const b=meta.bridges[bId];
      for(const pdf of (b.pdfs||[])){
        if(pdf.key){
          const zf=z.file(`pdfs/${pdf.key}`);
          if(zf){const blob=await zf.async("blob");await putPdfFile(pdf.key,blob);}
        }
      }
      for(const p of (b.photos||[])){
        const zf=z.file(`photos/${p.id}`);
        if(zf){const blob=await zf.async("blob");await putPhotoBlob(p.id,blob);}
      }
      app.bridges[bId]=b;
    }
    save();
    alert("バックアップを読み込みました。");
  }catch(err){alert("復元に失敗しました: "+(err.message||err));}
};

openFileDb().then(async()=>{await migrateLegacyData();load();}).catch(err=>alert('端末内データベースを開けませんでした: '+(err.message||err)));
