// ============================================================
// MEALLIONS 도시락 앱 — Supabase 연동 API
// npm install @supabase/supabase-js 설치 후 사용하세요.
//
// 기존 App.jsx의 useState(로컬 상태) 대신 아래 함수들로
// 데이터를 읽고/쓰면, 새로고침·재접속 후에도 데이터가
// 그대로 유지됩니다. 비밀번호는 supabase.auth가 자체적으로
// bcrypt 해싱해 저장하므로 이 코드에서 직접 다룰 필요가
// 없습니다 (평문 저장 없음).
// ============================================================

import { createClient } from "@supabase/supabase-js";

export const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,       // 예: https://xxxx.supabase.co
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY   // Supabase 프로젝트의 anon public key
);

// ---------------- 인증 ----------------

// 회원가입: 이메일 형식 아이디를 쓰거나, 아이디@meallions.local 같은
// 가짜 도메인을 붙여 Supabase Auth의 이메일 필드에 맞출 수 있습니다.
export async function signUp({ loginId, password, parentName, phone, address, children }) {
  const email = `${loginId}@meallions.local`; // 가입은 계속 이 방식으로 (실제 이메일은 내정보에서 나중에 등록)
  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) throw error;

  const userId = data.user.id;

  const { error: profileError } = await supabase.from("profiles").insert({
    id: userId,
    role: "parent",
    parent_name: parentName,
    phone,
    address,
    login_id: loginId, // 나중에 이메일을 실제 이메일로 바꿔도 로그인은 계속 이 아이디로 할 수 있도록 저장
    privacy_consented_at: new Date(), // 가입 화면에서 개인정보처리방침 동의 체크를 해야만 가입이 진행되므로, 이 시점을 동의 시각으로 기록
  });
  if (profileError) throw profileError;

  const childRows = children.map((c) => ({
    profile_id: userId,
    name: c.name,
    gender: c.gender,
    age: c.age,
    allergy: c.allergy || "없음",
  }));
  const { error: childError } = await supabase.from("children").insert(childRows);
  if (childError) throw childError;

  return userId;
}

export async function signIn({ loginId, password }) {
  // 아이디로 "현재" 로그인 이메일을 찾아요. (처음엔 가짜 이메일이지만, 내정보에서 실제 이메일로
  // 바꾼 학부모는 이 조회로 최신 이메일을 찾아서 로그인이 계속 아이디로 되게 해줘요.)
  let email = `${loginId}@meallions.local`; // 조회 실패 시 예전 방식으로 폴백
  try {
    const { data: resolved } = await supabase.rpc("resolve_login_email", { p_login_id: loginId });
    if (resolved) email = resolved;
  } catch (e) {
    // 함수가 아직 없는(마이그레이션 전) 환경이면 그냥 예전 방식으로 진행
  }
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error; // "등록되지 않은 아이디" 또는 "비밀번호 불일치"는 여기서 잡아 화면에 표시
  return data.session;
}

export async function signOut() {
  await supabase.auth.signOut();
}

// 로그인 상태 유지: Supabase는 기본적으로 세션을 localStorage에
// 안전하게 저장하고 자동 갱신합니다. "로그인 유지" 체크박스는
// persistSession: true 옵션(기본값)으로 이미 구현됩니다.
export async function getCurrentSession() {
  const { data } = await supabase.auth.getSession();
  return data.session;
}

// ---------------- 비밀번호 찾기 / 복구 이메일 ----------------

// 지금 로그인한 사용자의 실제 인증 이메일을 확인합니다. "@meallions.local"로 끝나면
// 아직 복구 이메일을 등록하지 않은 상태라는 뜻이에요.
export async function getCurrentAuthEmail() {
  const { data } = await supabase.auth.getUser();
  return data?.user?.email || null;
}

// 학부모가 내정보에서 실제 이메일을 등록/변경합니다. Supabase가 확인 메일을 보내고,
// 그 메일의 링크를 클릭해야 최종 반영돼요.
export async function updateRecoveryEmail(newEmail) {
  const { error } = await supabase.auth.updateUser({ email: newEmail });
  if (error) throw error;
}

// 로그인 화면의 "비밀번호를 잊으셨나요?"에서 아이디를 입력하면 호출합니다.
// 복구 이메일이 등록된 계정이면 재설정 링크를 보내고, 아니면 안내만 해줘요.
export async function requestPasswordReset(loginId, redirectTo) {
  let email = `${loginId}@meallions.local`;
  try {
    const { data: resolved } = await supabase.rpc("resolve_login_email", { p_login_id: loginId });
    if (resolved) email = resolved;
  } catch (e) {}
  if (email.endsWith("@meallions.local")) {
    return { sent: false, reason: "no_recovery_email" };
  }
  const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo });
  if (error) throw error;
  return { sent: true };
}

// 재설정 이메일의 링크를 눌러 돌아온 뒤, 새 비밀번호를 저장합니다.
export async function updatePasswordAfterReset(newPassword) {
  const { error } = await supabase.auth.updateUser({ password: newPassword });
  if (error) throw error;
}

// ---------------- 관리자: 전체 학부모 데이터 (프로필+자녀+해당월 신청/결제) ----------------

// 최근 몇 달간의 신청 횟수·매출 추이를 계산합니다 (관리자 화면 그래프용).
export async function getMonthlyStats(monthsBack = 6) {
  const { data: orders, error: ordersErr } = await supabase.from("orders").select("year_month, selected_days");
  if (ordersErr) throw ordersErr;
  const { data: payments, error: paymentsErr } = await supabase.from("payments").select("amount, status, paid_at").eq("status", "paid");
  if (paymentsErr) throw paymentsErr;

  const orderTotals = {};
  for (const o of orders || []) {
    orderTotals[o.year_month] = (orderTotals[o.year_month] || 0) + (o.selected_days?.length || 0);
  }
  const revenueTotals = {};
  for (const p of payments || []) {
    if (!p.paid_at) continue;
    const d = new Date(p.paid_at);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    revenueTotals[key] = (revenueTotals[key] || 0) + Number(p.amount);
  }
  const allKeys = new Set([...Object.keys(orderTotals), ...Object.keys(revenueTotals)]);
  const sortedKeys = [...allKeys].sort().slice(-monthsBack);
  return sortedKeys.map((key) => ({ yearMonth: key, orders: orderTotals[key] || 0, revenue: revenueTotals[key] || 0 }));
}

export async function getAdminData(yearMonth) {
  const { data: profiles, error: profileErr } = await supabase
    .from("profiles")
    .select("*, children(*)")
    .eq("role", "parent");
  if (profileErr) throw profileErr;

  const { data: orders, error: orderErr } = await supabase
    .from("orders")
    .select("profile_id, selected_days")
    .eq("year_month", yearMonth);
  if (orderErr) throw orderErr;

  // 결제는 자녀 1명당 1건이고, 사이클이 달을 넘나들 수 있어 특정 달로 필터링하지 않고
  // 자녀별로 "가장 최근 결제 건"만 가져와요 (그게 곧 지금 진행 중인 사이클의 결제 상태예요).
  const allChildIds = profiles.flatMap((p) => p.children.map((c) => c.id));
  const { data: payments, error: payErr } = await supabase
    .from("payments")
    .select("*")
    .in("child_id", allChildIds.length ? allChildIds : ["00000000-0000-0000-0000-000000000000"])
    .order("submitted_at", { ascending: false });
  if (payErr) throw payErr;

  const orderMap = Object.fromEntries((orders || []).map((o) => [o.profile_id, o.selected_days]));
  const paymentMap = {};
  for (const row of payments || []) {
    if (!paymentMap[row.child_id]) paymentMap[row.child_id] = row;
  }

  // 자녀별 "마지막 결제 이후 신청 누적 횟수(사이클 진행률)" 계산
  const { data: allOrders, error: allOrdersErr } = await supabase.from("orders").select("profile_id, year_month, selected_days");
  if (allOrdersErr) throw allOrdersErr;
  const ordersByProfile = {};
  for (const o of allOrders || []) {
    if (!ordersByProfile[o.profile_id]) ordersByProfile[o.profile_id] = [];
    ordersByProfile[o.profile_id].push(o);
  }
  const computeCycleUsed = (profileId, child) => {
    const cutoff = getCycleCutoff(child);
    let count = 0;
    for (const o of ordersByProfile[profileId] || []) {
      const [y, m] = o.year_month.split("-").map(Number);
      for (const day of o.selected_days || []) {
        if (new Date(y, m - 1, day) > cutoff) count++;
      }
    }
    return count;
  };

  // 삭제(비활성화)된 자녀라도 결제기록이 남아있으면 "탈퇴한 자녀 결제내역"으로 따로 보여줍니다.
  const removedChildPayments = [];
  for (const p of profiles) {
    for (const c of p.children.filter((c) => c.active === false)) {
      const pay = paymentMap[c.id];
      if (pay) removedChildPayments.push({ parentName: p.parent_name, child: c, payment: pay });
    }
  }

  return {
    accounts: profiles.map((p) => ({
      id: p.id,
      parentName: p.parent_name,
      phone: p.phone,
      address: p.address,
      children: p.children
        .filter((c) => c.active !== false)
        .map((c) => ({
          ...c,
          cycleUsed: computeCycleUsed(p.id, c),
          payment: paymentMap[c.id] || { status: "unpaid", amount: 0 },
        })),
      bankedCredits: p.banked_credits,
      order: orderMap[p.id] || [],
    })),
    removedChildPayments,
  };
}

// ---------------- 프로필 / 자녀 ----------------

export async function getMyProfile(userId) {
  const { data, error } = await supabase
    .from("profiles")
    .select("*, children(*)")
    .eq("id", userId)
    .single();
  if (error) throw error;
  return { ...data, children: (data.children || []).filter((c) => c.active !== false) };
}

export async function updateAddress(userId, address) {
  const { error } = await supabase.from("profiles").update({ address }).eq("id", userId);
  if (error) throw error;
}

// 주의: 예전 버전은 자녀를 통째로 지우고 다시 넣었는데, 이러면 삭제된 자녀의
// child_id를 참조하는 결제(payments) 기록까지 cascade로 함께 사라졌습니다.
// 이제는 (1) id가 있는 기존 자녀는 update, (2) id가 없는 새 자녀는 insert,
// (3) 화면에서 빠진(=삭제 누른) 기존 자녀는 지우지 않고 active=false로만 비활성화합니다.
export async function updateChildren(userId, children) {
  const { data: existing, error: fetchErr } = await supabase
    .from("children")
    .select("id")
    .eq("profile_id", userId)
    .eq("active", true);
  if (fetchErr) throw fetchErr;

  const keptIds = new Set(children.filter((c) => c.id).map((c) => c.id));
  const toDeactivate = (existing || []).filter((c) => !keptIds.has(c.id)).map((c) => c.id);

  if (toDeactivate.length > 0) {
    const { error: deactivateErr } = await supabase.from("children").update({ active: false }).in("id", toDeactivate);
    if (deactivateErr) throw deactivateErr;
  }

  for (const c of children) {
    if (c.id) {
      const { error } = await supabase
        .from("children")
        .update({ name: c.name, gender: c.gender, age: c.age, allergy: c.allergy })
        .eq("id", c.id);
      if (error) throw error;
    } else {
      const { error } = await supabase
        .from("children")
        .insert({ profile_id: userId, name: c.name, gender: c.gender, age: c.age, allergy: c.allergy, active: true });
      if (error) throw error;
    }
  }
}

// ---------------- 신청/스킵 (월별) ----------------

export async function getOrder(userId, yearMonth) {
  const { data } = await supabase
    .from("orders")
    .select("selected_days")
    .eq("profile_id", userId)
    .eq("year_month", yearMonth)
    .maybeSingle();
  return data?.selected_days || null;
}

export async function saveOrder(userId, yearMonth, selectedDays) {
  const { error } = await supabase
    .from("orders")
    .upsert(
      { profile_id: userId, year_month: yearMonth, selected_days: selectedDays, updated_at: new Date() },
      { onConflict: "profile_id,year_month" }
    );
  if (error) throw error;
}

// ---------------- 결제 (자녀 1명당 1건씩 — 다자녀 가정은 자녀별로 각각 결제) ----------------

export async function submitPayment(userId, childId, yearMonth, amount, promo = null) {
  // promo: { code, discountAmount } 또는 null
  const { error } = await supabase.from("payments").insert({
    profile_id: userId,
    child_id: childId,
    year_month: yearMonth,
    amount,
    method: "etransfer",
    status: "pending",
    submitted_at: new Date(),
    notified: true,
    promo_code: promo?.code || null,
    discount_amount: promo?.discountAmount || 0,
  });
  if (error) throw error;
  // 결제를 제출한 시점부터 이 자녀의 다음 12회 사이클을 새로 셉니다.
  const { error: resetErr } = await supabase
    .from("children")
    .update({ cycle_paid_through: new Date() })
    .eq("id", childId);
  if (resetErr) throw resetErr;

  if (promo?.code) {
    // 사용 횟수 +1 (동시성 위험은 낮은 소규모 서비스라 단순 read-then-write로 처리)
    const { data: row } = await supabase.from("promo_codes").select("used_count").eq("code", promo.code).single();
    if (row) {
      await supabase.from("promo_codes").update({ used_count: row.used_count + 1 }).eq("code", promo.code);
    }
  }
}

// 프로모 코드를 검증합니다 — 존재/활성/만료/사용횟수를 확인하고, 유효하면 코드 정보를 반환합니다.
// 반환: { valid: true, code, discountType, discountValue } 또는 { valid: false, reason }
export async function validatePromoCode(code) {
  const trimmed = (code || "").trim().toUpperCase();
  if (!trimmed) return { valid: false, reason: "empty" };
  const { data, error } = await supabase
    .from("promo_codes")
    .select("*")
    .eq("code", trimmed)
    .eq("active", true)
    .maybeSingle();
  if (error) throw error;
  if (!data) return { valid: false, reason: "not_found" };
  if (data.expires_at && new Date(data.expires_at) < new Date()) return { valid: false, reason: "expired" };
  if (data.max_uses != null && data.used_count >= data.max_uses) return { valid: false, reason: "max_uses" };
  return { valid: true, code: data.code, discountType: data.discount_type, discountValue: data.discount_value };
}

// ---------------- 프로모 코드 관리 (관리자 전용, RLS가 강제) ----------------

export async function getPromoCodes() {
  const { data, error } = await supabase.from("promo_codes").select("*").order("created_at", { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function createPromoCode({ code, discountType, discountValue, expiresAt, maxUses }) {
  const { error } = await supabase.from("promo_codes").insert({
    code: code.trim().toUpperCase(),
    discount_type: discountType,
    discount_value: discountValue,
    expires_at: expiresAt || null,
    max_uses: maxUses || null,
    active: true,
  });
  if (error) throw error;
}

export async function updatePromoCodeActive(id, active) {
  const { error } = await supabase.from("promo_codes").update({ active }).eq("id", id);
  if (error) throw error;
}

export async function deletePromoCode(id) {
  const { error } = await supabase.from("promo_codes").delete().eq("id", id);
  if (error) throw error;
}

// 자녀별로 "마지막 결제 이후 실제 신청한 날짜 수"를 계산합니다 (달과 무관하게 누적).
// 12에 도달하면 다음 결제 대상이에요.
// 자녀의 사이클 계산 기준 시점 — "마지막 결제 시점"과 "관리자가 지정한 서비스 시작일" 중 더 늦은 쪽을 씁니다.
// (예: 7/1에 결제했지만 실제 서비스는 7/14부터 원하면, 관리자가 서비스 시작일을 7/14로 설정해서
//  그 이전 신청 건은 다음 사이클 계산에서 빠지게 할 수 있어요.)
function getCycleCutoff(child) {
  const paidThrough = new Date(child.cycle_paid_through);
  if (!child.service_start_date) return paidThrough;
  const serviceStart = new Date(child.service_start_date + "T00:00:00");
  return serviceStart > paidThrough ? serviceStart : paidThrough;
}

// 자녀별 "사이클 시작 이후 사용(신청)/스킵 횟수"를 함께 계산해요.
// 스킵은 이미 지나간 배송일 중 신청하지 않은 날짜만 셉니다 (아직 안 지난 날은 스킵이 아니라 "미정"이에요).
export async function getCycleUsage(profileId, children) {
  const { data: orders, error } = await supabase
    .from("orders")
    .select("year_month, selected_days")
    .eq("profile_id", profileId);
  if (error) throw error;

  // 스킵 횟수까지 계산하려면 그 기간의 실제 배송일(메뉴) 목록이 필요해서, 사이클 시작 시점부터 지금(+다음달 선신청분)까지의 메뉴를 불러와요.
  const now = new Date();
  const minCutoff = children.reduce((min, c) => {
    const cutoff = getCycleCutoff(c);
    return !min || cutoff < min ? cutoff : min;
  }, null);
  const monthsSet = new Set();
  if (minCutoff) {
    const d = new Date(minCutoff.getFullYear(), minCutoff.getMonth(), 1);
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 1); // 다음 달 선(先)신청분까지 포함
    while (d <= end) {
      monthsSet.add(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
      d.setMonth(d.getMonth() + 1);
    }
  }
  const { data: menuRows, error: menuErr } = monthsSet.size
    ? await supabase.from("menus").select("year_month, day, is_holiday").in("year_month", [...monthsSet])
    : { data: [], error: null };
  if (menuErr) throw menuErr;

  const ordersByYM = {};
  for (const o of orders || []) ordersByYM[o.year_month] = new Set(o.selected_days || []);

  const cycleUsage = {};
  for (const child of children) {
    const cutoff = getCycleCutoff(child);
    let used = 0;
    let skipped = 0;
    for (const row of menuRows || []) {
      if (row.is_holiday) continue;
      const [y, m] = row.year_month.split("-").map(Number);
      const date = new Date(y, m - 1, row.day);
      if (date <= cutoff) continue;
      const isSelected = ordersByYM[row.year_month]?.has(row.day);
      if (isSelected) used++;
      else if (date <= now) skipped++;
    }
    cycleUsage[child.id] = { used, skipped };
  }
  return cycleUsage;
}


// 자녀들의 "현재 진행 중인(가장 최근) 결제 건"을 한 번에 가져옵니다.
// 사이클이 달을 넘나들 수 있어서, 특정 year_month가 아니라 자녀별 최신 결제 기록을 기준으로 삼아요.
export async function getLatestPayments(childIds) {
  if (!childIds || childIds.length === 0) return {};
  const { data, error } = await supabase
    .from("payments")
    .select("*")
    .in("child_id", childIds)
    .order("submitted_at", { ascending: false });
  if (error) throw error;
  const latestByChild = {};
  for (const row of data || []) {
    if (!latestByChild[row.child_id]) latestByChild[row.child_id] = row; // 이미 있으면(더 최신이 먼저 나왔으므로) 건너뜀
  }
  return latestByChild;
}

// 학부모가 스스로 제출한 "입금확인중" 결제를 관리자 승인 전에 취소할 때 사용합니다.
// (이미 관리자가 승인해 "결제완료" 상태가 된 건은 여기서 취소할 수 없고, 관리자의 승인취소로만 되돌릴 수 있어요.)
// 참고: 취소해도 사이클 시작점은 되돌리지 않아요 — 이미 새 사이클로 넘어간 신청 건이 있을 수 있기 때문입니다.
export async function cancelPendingPayment(paymentId) {
  const { error } = await supabase
    .from("payments")
    .delete()
    .eq("id", paymentId)
    .eq("status", "pending");
  if (error) throw error;
}

export async function approvePayment(paymentId) {
  const { error } = await supabase
    .from("payments")
    .update({ status: "paid", paid_at: new Date(), notified: false })
    .eq("id", paymentId);
  if (error) throw error;
}

export async function revokePayment(paymentId) {
  const { error } = await supabase
    .from("payments")
    .update({ status: "pending", paid_at: null, notified: true })
    .eq("id", paymentId);
  if (error) throw error;
}

export async function dismissPaymentNotice(paymentId) {
  const { error } = await supabase
    .from("payments")
    .update({ notified: true })
    .eq("id", paymentId);
  if (error) throw error;
}

// ---------------- 메뉴 / 공지 (관리자 전용 쓰기, RLS가 강제) ----------------

export async function getMenus(yearMonth) {
  const { data, error } = await supabase.from("menus").select("*").eq("year_month", yearMonth);
  if (error) throw error;
  const map = {};
  data.forEach((row) => (map[row.day] = { main: row.main, side: row.side, fruit: row.fruit, isHoliday: row.is_holiday, holidayLabel: row.holiday_label }));
  return map;
}

export async function upsertMenuDay(yearMonth, day, menu) {
  const { error } = await supabase.from("menus").upsert(
    {
      year_month: yearMonth,
      day,
      main: menu.main || "",
      side: menu.side || "",
      fruit: menu.fruit || "",
      is_holiday: menu.isHoliday || false,
      holiday_label: menu.holidayLabel || null,
    },
    { onConflict: "year_month,day" }
  );
  if (error) throw error;
}

export async function deleteMenuDay(yearMonth, day) {
  const { error } = await supabase.from("menus").delete().eq("year_month", yearMonth).eq("day", day);
  if (error) throw error;
}

export async function getNotices() {
  const { data, error } = await supabase.from("notices").select("*").order("created_at", { ascending: false });
  if (error) throw error;
  return data;
}

// id를 클라이언트에서 생성(crypto.randomUUID())해 넘기면 새 글, 기존 id면 수정으로 동작합니다.
export async function upsertNotice({ id, title, body, dateLabel }) {
  const { error } = await supabase.from("notices").upsert({ id, title, body, date_label: dateLabel });
  if (error) throw error;
}

export async function deleteNotice(id) {
  const { error } = await supabase.from("notices").delete().eq("id", id);
  if (error) throw error;
}

// ---------------- 이트랜스퍼 설정 ----------------

export async function getEtransferInfo() {
  const { data, error } = await supabase.from("settings").select("value").eq("key", "etransfer_info").single();
  if (error) throw error;
  return data.value;
}

export async function updateEtransferInfo(info) {
  const { error } = await supabase.from("settings").update({ value: info }).eq("key", "etransfer_info");
  if (error) throw error;
}

// ---------------- 가격 / 할당량 / 배송 요일 설정 (관리자가 화면에서 직접 조정) ----------------

export async function getPricing() {
  const { data, error } = await supabase.from("settings").select("value").eq("key", "pricing").single();
  if (error) throw error;
  return data.value; // { monthlyFee, taxRate, totalQuota }
}

export async function updatePricing(pricing) {
  const { error } = await supabase.from("settings").update({ value: pricing }).eq("key", "pricing");
  if (error) throw error;
}

export async function getDeliveryWeekdays() {
  const { data, error } = await supabase.from("settings").select("value").eq("key", "delivery_weekdays").single();
  if (error) throw error;
  return data.value; // 예: [1,2,4] (0=일 ... 6=토)
}

export async function updateDeliveryWeekdays(weekdays) {
  const { error } = await supabase.from("settings").update({ value: weekdays }).eq("key", "delivery_weekdays");
  if (error) throw error;
}

// ---------------- 자녀 사이클 수동 조정 (관리자 전용) ----------------

// 특정 자녀의 사이클 시작점을 관리자가 직접 리셋합니다 (예: 이벤트성 무료 리필, 오류 정정 등).
export async function resetChildCycle(childId) {
  const { error } = await supabase.from("children").update({ cycle_paid_through: new Date() }).eq("id", childId);
  if (error) throw error;
}

// 관리자가 자녀의 "실제 서비스 시작일"을 지정합니다. (예: 결제는 7/1에 했지만 7/14부터 이용 시작)
// null을 넘기면 제한을 다시 없앨 수 있어요.
export async function updateChildServiceStartDate(childId, dateStr) {
  const { error } = await supabase.from("children").update({ service_start_date: dateStr || null }).eq("id", childId);
  if (error) throw error;
}

// 자녀별로 사이클 횟수(기본 12회)를 다르게 지정합니다. (예: 여름방학 후 복귀하는 아이는 남은 횟수만 설정)
// quota에 null을 넘기면 다시 전체 기본값(관리자 설정의 사이클 횟수)을 따르게 됩니다.
export async function updateChildTotalQuota(childId, quota) {
  const { error } = await supabase.from("children").update({ total_quota: quota }).eq("id", childId);
  if (error) throw error;
}

// 관리자가 실수로 사이클 횟수를 잘못 설정했다가 정정한 경우 등, 학부모가 이미 체크해둔 신청 내역을
// 통째로 지워서 처음부터 다시 신청받고 싶을 때 씁니다. 신청은 자녀별이 아니라 가정(학부모 계정)
// 전체가 공유하는 값이라, year_month 목록(보통 이번 달 + 다음 달)을 받아 그 달들만 비워요.
export async function resetOrdersForMonths(profileId, yearMonths) {
  const { error } = await supabase
    .from("orders")
    .update({ selected_days: [] })
    .eq("profile_id", profileId)
    .in("year_month", yearMonths);
  if (error) throw error;
}

// ---------------- 관리자 계정 관리 ----------------

// 다른 학부모 계정을 관리자로 승격하거나, 관리자를 다시 학부모로 되돌립니다.
export async function updateProfileRole(profileId, role) {
  const { error } = await supabase.from("profiles").update({ role }).eq("id", profileId);
  if (error) throw error;
}

export async function getAllProfilesForRoleManagement() {
  const { data, error } = await supabase.from("profiles").select("id, parent_name, phone, role").order("parent_name");
  if (error) throw error;
  return data || [];
}

// ---------------- 관리자 활동 로그 ----------------

// ---------------- 푸시 알림 ----------------

// VAPID 공개키 — npx web-push generate-vapid-keys 로 생성한 뒤 여기에 붙여넣어주세요.
// (공개키라서 코드에 그대로 노출돼도 안전해요. 비밀키는 Supabase 엣지 함수 시크릿에만 저장해요.)
const VAPID_PUBLIC_KEY = "여기에_생성한_VAPID_PUBLIC_KEY를_붙여넣으세요";

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}

// 지금 이 브라우저가 푸시 알림을 구독 중인지 확인 (알림 켜기/끄기 토글 상태 표시용)
export async function getPushSubscriptionStatus() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return "unsupported";
  const registration = await navigator.serviceWorker.ready;
  const sub = await registration.pushManager.getSubscription();
  return sub ? "subscribed" : "unsubscribed";
}

// 알림 켜기 — 브라우저 권한을 요청하고, 구독 정보를 서버(push_subscriptions)에 저장해요.
export async function subscribeToPush(profileId) {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    throw new Error("이 브라우저는 푸시 알림을 지원하지 않아요.");
  }
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error("알림 권한이 허용되지 않았어요.");
  }
  const registration = await navigator.serviceWorker.ready;
  let sub = await registration.pushManager.getSubscription();
  if (!sub) {
    sub = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
    });
  }
  const json = sub.toJSON();
  const { error } = await supabase.from("push_subscriptions").upsert(
    {
      profile_id: profileId,
      endpoint: json.endpoint,
      p256dh: json.keys.p256dh,
      auth: json.keys.auth,
    },
    { onConflict: "endpoint" }
  );
  if (error) throw error;
}

// 알림 끄기 — 이 브라우저의 구독을 해제하고 서버에서도 지워요.
export async function unsubscribeFromPush() {
  if (!("serviceWorker" in navigator)) return;
  const registration = await navigator.serviceWorker.ready;
  const sub = await registration.pushManager.getSubscription();
  if (sub) {
    await supabase.from("push_subscriptions").delete().eq("endpoint", sub.endpoint);
    await sub.unsubscribe();
  }
}

// 실제 발송 — Supabase 엣지 함수(send-push-notification)를 호출해요.
// targetProfileIds를 생략하면 구독된 모든 학부모에게, 배열로 주면 그 사람들에게만 보내요.
export async function sendPushNotification({ title, body, url, tag, targetProfileIds }) {
  const { data, error } = await supabase.functions.invoke("send-push-notification", {
    body: { title, body, url, tag, targetProfileIds },
  });
  if (error) throw error;
  return data;
}

export async function logAdminActivity(adminId, adminName, action, targetDescription, metadata = null) {
  // 로그 기록 실패로 정작 하려던 작업(승인, 가격 변경 등)까지 막히면 안 되니, 여기 오류는 조용히 무시해요.
  try {
    await supabase.from("admin_activity_log").insert({
      admin_id: adminId,
      admin_name: adminName,
      action,
      target_description: targetDescription,
      metadata,
    });
  } catch (e) {
    console.error("활동 로그 기록 실패:", e);
  }
}

export async function getAdminActivityLog(limit = 100) {
  const { data, error } = await supabase
    .from("admin_activity_log")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data || [];
}

// ---------------- 이용 후기 (결제 완료 직후 팝업, 기존 feedbacks 테이블 재사용) ----------------

export async function submitReview({ profileId, serviceRating, qualityRating, kidsRating, comment }) {
  const { error } = await supabase.from("feedbacks").insert({
    profile_id: profileId,
    service_rating: serviceRating || null,
    quality_rating: qualityRating || null,
    kids_rating: kidsRating || null,
    message: comment || null,
  });
  if (error) throw error;
}

// 관리자 화면에서 리뷰 모아보기용 (평균 별점 + 최근 코멘트)
export async function getReviews() {
  const { data, error } = await supabase
    .from("feedbacks")
    .select("*, profiles(parent_name)")
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data || [];
}

// ---------------- 전체 백업 (관리자 전용) ----------------
// Supabase 무료 플랜은 자동 백업이 없어서, 여기서 모든 원본 데이터를 통째로 받아
// 관리자가 파일로 저장해둘 수 있게 합니다. 앱에 문제가 생겨도 이 파일 하나로
// 학부모/자녀/신청내역/결제내역/메뉴/공지/프로모코드를 전부 복구 참고할 수 있어요.
export async function exportFullBackup() {
  const [profiles, children, orders, payments, menus, notices, promoCodes, settings] = await Promise.all([
    supabase.from("profiles").select("*"),
    supabase.from("children").select("*"),
    supabase.from("orders").select("*"),
    supabase.from("payments").select("*"),
    supabase.from("menus").select("*"),
    supabase.from("notices").select("*"),
    supabase.from("promo_codes").select("*"),
    supabase.from("settings").select("*"),
  ]);
  const errors = [profiles, c
