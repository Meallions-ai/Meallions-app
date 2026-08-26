// components/PwaRegister.jsx
// 서비스워커 등록만 담당하는 작은 클라이언트 컴포넌트입니다.
"use client";

import { useEffect } from "react";

export default function PwaRegister() {
  useEffect(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }
  }, []);
  return null;
}
