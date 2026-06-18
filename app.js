document.addEventListener("gesturestart",e=>e.preventDefault());
let lastTouchEnd=0;document.addEventListener("touchend",e=>{let now=Date.now();if(now-lastTouchEnd<=300)e.preventDefault();lastTouchEnd=now},{passive:false});
pdfjsLib.GlobalWorkerOptions.workerSrc="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
const $=id=>document.getElementById(id);

const app={bridges:{},currentBridgeId:null,currentPdfId:null};
const view={pdf:null,page:1,pages:0,w:0,h:0,scale:1,tx:0,ty:0,tool:"move",selected:null,pendingIcon:null,relocate:null,pointers:new Map(),down:null,pan:null,pinch:null,drawing:false,stroke:null};

let fileDb=null;
const FILE_DB_NAME="fieldbook_v21_files";
function openFileDb(){
  return new Promise((resolve,reject)=>{
    const req=indexedDB.open(FILE_DB_NAME,1);
    req.onupgradeneeded=e=>{
      const db=e.target.result;
      if(!db.objectStoreNames.contains("pdfs"))db.createObjectStore("pdfs");
    };
    req.onsuccess=e=>{fileDb=e.target.result;resolve(fileDb)};
    req.onerror=e=>reject(e);
  });
}
function putPdfFile(key,file){
  return new Promise((resolve,reject)=>{
    const tx=fileDb.transaction("pdfs","readwrite");
    tx.objectStore("pdfs").put(file,key);
    tx.oncomplete=()=>resolve();
    tx.onerror=e=>reject(e);
  });
}
function getPdfFile(key){
  return new Promise((resolve,reject)=>{
    const tx=fileDb.transaction("pdfs","readonly");
    const req=tx.objectStore("pdfs").get(key);
    req.onsuccess=()=>resolve(req.result);
    req.onerror=e=>reject(e);
  });
}


function uid(){return Date.now().toString(36)+Math.random().toString(36).slice(2,7)}
function safe(s){return String(s||"橋梁").replace(/[\\/:*?"<>| \u3000]/g,"_")}
function save(){localStorage.setItem("fieldbook_v20",JSON.stringify(app));renderLists();}
function load(){try{Object.assign(app,JSON.parse(localStorage.getItem("fieldbook_v20")||"{}"))}catch(e){} renderLists();}
function currentBridge(){return app.bridges[app.currentBridgeId]}
function currentPdf(){const b=currentBridge();return b?b.pdfs.find(p=>p.id===app.currentPdfId):null}
function show(id){document.querySelectorAll(".page").forEach(p=>p.classList.remove("active"));$(id).classList.add("active");if(id==="savePage")renderSave();}
$("homeBtn").onclick=()=>show("home");$("editBtn").onclick=()=>show("editor");$("saveBtn").onclick=()=>show("savePage");

$("createBridgeBtn").onclick=()=>{
  const name=$("newBridgeName").value.trim();
  if(!name)return alert("橋梁名を入力してください");
  const id=safe(name);
  if(!app.bridges[id])app.bridges[id]={id,name,pdfs:[],photos:[],photoSeq:1};
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
    div.innerHTML=`<div class="bridgeTitle">${pdf.name}</div><div class="pdfStats">ページ記録あり / 写真アイコン ${pdf.icons.length}個</div><div class="cardActions"></div>`;
    const actions=div.querySelector(".cardActions");
    const edit=document.createElement("button");edit.textContent="編集";edit.onclick=async()=>{app.currentPdfId=pdf.id;save();await openPdf(pdf.id);show("editor");};
    actions.appendChild(edit);$("pdfList").appendChild(div);
  });
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
    if(!app.bridges[id])app.bridges[id]={id,name,pdfs:[],photos:[],photoSeq:1};
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
function fileToDataUrl(file){return new Promise(res=>{const r=new FileReader();r.onload=()=>res(r.result);r.readAsDataURL(file);})}
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
  const sc=Math.min(1.9,Math.max(1200,$("canvasWrap").clientWidth*1.9)/v0.width);
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
  const id=uid();const icon={id,page:view.page,x:p.x/view.w,y:p.y/view.h,photoIds:[]};
  pdf.icons.push(icon);pdf.actions.push({type:"addIcon",id});view.selected=id;view.pendingIcon=id;renderAll();setTool("move");$("cameraInput").click();save();
}
$("cameraInput").onchange=async e=>{const icon=pdfData()?.icons.find(i=>i.id===view.pendingIcon);if(icon&&e.target.files.length){await addPhotos(icon,[...e.target.files]);openPhotoModal(icon.id);}view.pendingIcon=null;e.target.value="";save();}
$("addPhotoInput").onchange=async e=>{const icon=pdfData()?.icons.find(i=>i.id===view.selected);if(icon&&e.target.files.length){await addPhotos(icon,[...e.target.files]);openPhotoModal(icon.id);}e.target.value="";save();}
async function addPhotos(icon,files){const b=currentBridge(),added=[];for(const f of files){const src=await resizeImage(f);const id=uid();const name=`${safe(b.name)}_${String(b.photoSeq++).padStart(3,"0")}.jpg`;b.photos.push({id,name,src});icon.photoIds.push(id);added.push(id);}if(added.length)pdfData().actions.push({type:"addPhotos",iconId:icon.id,photoIds:added});renderAll();}
function resizeImage(file){return new Promise(res=>{const r=new FileReader();r.onload=()=>{const img=new Image();img.onload=()=>{const sc=Math.min(1,1800/img.width),cv=document.createElement("canvas");cv.width=Math.round(img.width*sc);cv.height=Math.round(img.height*sc);cv.getContext("2d").drawImage(img,0,0,cv.width,cv.height);res(cv.toDataURL("image/jpeg",.86));};img.src=r.result;};r.readAsDataURL(file);})}
function iconPhotos(icon){const b=currentBridge();return icon.photoIds.map(id=>b.photos.find(p=>p.id===id)).filter(Boolean)}
function renderIcons(){const layer=$("iconLayer");layer.innerHTML="";const pdf=pdfData();if(!pdf)return;pdf.icons.filter(i=>i.page===view.page).forEach((icon,idx)=>{const ps=iconPhotos(icon);const d=document.createElement("div");d.className="photoIcon "+(ps.length?"hasPhoto":"noPhoto")+(icon.id===view.selected?" selected":"");d.style.left=(icon.x*view.w)+"px";d.style.top=(icon.y*view.h)+"px";d.innerHTML=ps.length?`<img src="${ps[0].src}"><span class="num">${idx+1}</span>`:`<span class="num">${idx+1}</span>`;d.onpointerdown=e=>{e.stopPropagation();};d.onpointerup=e=>{e.stopPropagation();};d.onclick=e=>{e.stopPropagation();view.selected=icon.id;renderAll();openPhotoModal(icon.id)};layer.appendChild(d);});}
function openPhotoModal(id){const icon=pdfData()?.icons.find(i=>i.id===id);if(!icon)return;const ps=iconPhotos(icon);$("photoModalTitle").textContent=`写真アイコン：${ps.length}枚`;$("takeMorePhoto").textContent=ps.length?"続けて撮影":"撮影";$("modalPhotos").innerHTML=ps.length?ps.map(p=>`<div class="photoBox"><img src="${p.src}"><span>${p.name}</span></div>`).join(""):"<p>まだ写真がありません。</p>";$("photoModal").classList.remove("hidden");}
$("closeModal").onclick=()=>$("photoModal").classList.add("hidden");$("takeMorePhoto").onclick=()=>{$("photoModal").classList.add("hidden");$("addPhotoInput").click()};$("moveIconBtn").onclick=()=>{if(!view.selected)return;view.relocate=view.selected;$("photoModal").classList.add("hidden");setTool("move");alert("新しい位置をPDF上で1回タップしてください")};
function moveIcon(id,p){const icon=pdfData()?.icons.find(i=>i.id===id);if(!icon)return;pdfData().actions.push({type:"moveIcon",id,old:{page:icon.page,x:icon.x,y:icon.y}});icon.page=view.page;icon.x=p.x/view.w;icon.y=p.y/view.h;view.relocate=null;renderAll();save();}
$("deleteIconBtn").onclick=()=>{const pdf=pdfData();if(!pdf||!view.selected)return;pdf.icons=pdf.icons.filter(i=>i.id!==view.selected);view.selected=null;$("photoModal").classList.add("hidden");renderAll();save();};

function startStroke(e){const p=toPdf(e.clientX,e.clientY);const er=view.tool==="eraser";view.drawing=true;view.stroke={page:view.page,pts:[{x:p.x/view.w,y:p.y/view.h}],color:er?"#fff":$("penColor").value,width:er?Number($("eraserSize").value):Number($("penSize").value),erase:er};}
function moveStroke(e){const p=toPdf(e.clientX,e.clientY);view.stroke.pts.push({x:p.x/view.w,y:p.y/view.h});draw(true)}
function endStroke(){if(view.stroke&&view.stroke.pts.length>1){pdfData().drawings.push(view.stroke);pdfData().actions.push({type:"draw"});}view.stroke=null;view.drawing=false;draw();save();}
function draw(includeCurrent=false){const ctx=$("drawCanvas").getContext("2d");ctx.clearRect(0,0,view.w,view.h);const pdf=pdfData();if(!pdf)return;let arr=(pdf.drawings||[]).filter(s=>s.page===view.page);if(includeCurrent&&view.stroke)arr=arr.concat([view.stroke]);arr.forEach(s=>{ctx.save();ctx.globalCompositeOperation=s.erase?"destination-out":"source-over";ctx.strokeStyle=s.color;ctx.lineWidth=s.width;ctx.lineCap="round";ctx.lineJoin="round";ctx.beginPath();ctx.moveTo(s.pts[0].x*view.w,s.pts[0].y*view.h);s.pts.slice(1).forEach(p=>ctx.lineTo(p.x*view.w,p.y*view.h));ctx.stroke();ctx.restore();});}
function renderAll(){renderIcons();draw();}
$("undoBtn").onclick=()=>{const pdf=pdfData();if(!pdf)return;const a=pdf.actions.pop();if(!a)return alert("戻せる作業がありません");const b=currentBridge();if(a.type==="draw")pdf.drawings.pop();if(a.type==="addIcon"){const ic=pdf.icons.find(i=>i.id===a.id);if(ic)b.photos=b.photos.filter(p=>!ic.photoIds.includes(p.id));pdf.icons=pdf.icons.filter(i=>i.id!==a.id);}if(a.type==="addPhotos"){const ic=pdf.icons.find(i=>i.id===a.iconId);if(ic)ic.photoIds=ic.photoIds.filter(id=>!a.photoIds.includes(id));b.photos=b.photos.filter(p=>!a.photoIds.includes(p.id));}if(a.type==="moveIcon"){const ic=pdf.icons.find(i=>i.id===a.id);if(ic){ic.page=a.old.page;ic.x=a.old.x;ic.y=a.old.y;}}renderAll();renderSave();save();};
function emptyIcons(){const b=currentBridge();if(!b)return[];return b.pdfs.flatMap(pdf=>pdf.icons.filter(i=>i.photoIds.length===0))}
function validatePhotos(){const e=emptyIcons();if(e.length){alert(`写真が入っていないアイコンが ${e.length} 個あります。写真を追加するか、不要なアイコンを削除してください。`);return false}return true}
function renderSave(){const b=currentBridge();if(!b){$("saveSummary").textContent="橋梁未選択";$("photoList").innerHTML="";return}$("saveSummary").innerHTML=`橋梁：<b>${b.name}</b><br>PDF：${b.pdfs.length}件　写真：${b.photos.length}枚　写真なしアイコン：${emptyIcons().length}個`;$("photoList").innerHTML=b.photos.map(p=>`<div class="photoBox"><img src="${p.src}"><span>${p.name}</span></div>`).join("")}
$("zipPhotos").onclick=async()=>{const b=currentBridge();if(!b)return;if(!validatePhotos())return;if(!b.photos.length)return alert("写真がありません");const z=new JSZip();b.photos.forEach(p=>z.file(p.name,p.src.split(",")[1],{base64:true}));download(await z.generateAsync({type:"blob"}),`${safe(b.name)}_写真.zip`)};
$("csvOut").onclick=()=>{const b=currentBridge();if(!b)return;if(!validatePhotos())return;const rows=[["橋梁名","PDF名","ページ","アイコン番号","写真名","X","Y"]];b.pdfs.forEach(pdf=>pdf.icons.forEach((ic,idx)=>rows.push([b.name,pdf.name,ic.page,idx+1,iconPhotos(ic).map(p=>p.name).join(" / "),ic.x.toFixed(4),ic.y.toFixed(4)])));download(new Blob(["\ufeff"+rows.map(r=>r.map(v=>`"${String(v??"").replace(/"/g,'""')}"`).join(",")).join("\n")],{type:"text/csv"}),`${safe(b.name)}_写真野帳.csv`)};
$("openOneDrive").onclick=()=>window.open("https://onedrive.live.com/","_blank");
function download(blob,name){const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download=name;a.click();}
openFileDb().then(()=>load()).catch(err=>alert('端末内データベースを開けませんでした: '+(err.message||err)));
