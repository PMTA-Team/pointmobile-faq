/**
 * 서버 안 메모리 캐시 — 시간이 지나면 잊는다. 로그인한 사람만 보는 응답이라 Vercel CDN 캐시는 쓸 수 없어서 여기 둔다.
 * 서버리스 인스턴스마다 따로라 '자주 묻는 것을 잠깐 기억'하는 용도다. 바뀐 걸 바로 보여야 하는 곳은 forget() 으로 지운다
 * (다른 인스턴스의 것은 TTL 이 지나면 사라진다).
 */
const store = new Map<string, { exp: number; v: Promise<unknown> }>();
const MAX = 500;

export function memo<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const hit = store.get(key);
  if (hit && hit.exp > now) return hit.v as Promise<T>;
  const v = fn();
  store.set(key, { exp: now + ttlMs, v });
  v.catch(() => store.delete(key));          // 실패한 것은 기억하지 않는다
  if (store.size > MAX) {
    for (const [k, e] of store) if (e.exp <= now) store.delete(k);
    while (store.size > MAX) store.delete(store.keys().next().value!);
  }
  return v;
}

/** prefix 로 시작하는 기억을 지운다. */
export function forget(prefix: string): void {
  for (const k of store.keys()) if (k.startsWith(prefix)) store.delete(k);
}
