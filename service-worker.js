const C="fieldbook-v22";
const ASSETS=[
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./manifest.webmanifest",
  "./icon.svg",
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js"
];

self.addEventListener("install",e=>{
  e.waitUntil(
    caches.open(C).then(c=>c.addAll(ASSETS)).then(()=>self.skipWaiting())
  );
});

self.addEventListener("activate",e=>{
  e.waitUntil(
    caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==C).map(k=>caches.delete(k))))
      .then(()=>self.clients.claim())
  );
});

// キャッシュがあればすぐ返しつつ、裏でネットワークから最新版を取得してキャッシュを更新する
// （現場でオフラインでも起動でき、電波があるときは自動で最新化される）
self.addEventListener("fetch",e=>{
  if(e.request.method!=="GET")return;
  e.respondWith(
    caches.match(e.request).then(cached=>{
      const fetchPromise=fetch(e.request).then(res=>{
        if(res&&res.status===200){
          const copy=res.clone();
          caches.open(C).then(c=>c.put(e.request,copy));
        }
        return res;
      }).catch(()=>cached);
      return cached||fetchPromise;
    })
  );
});
