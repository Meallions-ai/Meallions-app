// MEALLIONS 도시락 — 서비스워커
// 1) PWA 설치(홈 화면 추가) 조건을 만족시키기 위한 최소 구현
// 2) 공지사항/메뉴판 업데이트를 앱을 안 켜도 알 수 있도록 푸시 알림 수신 처리

const CACHE_NAME = "meallions-shell-v1";

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// 네트워크 우선, 실패하면 캐시 — 결제/신청 데이터는 항상 최신이어야 하므로
// 페이지 자체를 캐시에 오래 저장하지 않습니다.
self.addEventListener("fetch", (event) => {
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});

// ---------------- 푸시 알림 수신 ----------------
// 서버(Supabase 엣지 함수)에서 보낸 푸시 메시지를 받아 알림을 띄워요.
// payload 형식: { title, body, url }
self.addEventListener("push", (event) => {
  let payload = { title: "MEALLIONS 도시락", body: "새 소식이 있어요.", url: "/" };
  try {
    if (event.data) payload = { ...payload, ...event.data.json() };
  } catch (e) {
    // JSON이 아니면 텍스트 그대로 본문에 사용
    if (event.data) payload.body = event.data.text();
  }

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      data: { url: payload.url || "/" },
      tag: payload.tag || "meallions-notice", // 같은 tag면 알림이 쌓이지 않고 최신 것으로 교체돼요
    })
  );
});

// 알림을 탭하면 앱 창을 열거나 이미 열려있으면 포커스만 이동
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ("focus" in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })
  );
});
