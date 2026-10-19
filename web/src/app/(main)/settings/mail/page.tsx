"use client";

import { CredForm } from "@/components/admin/CredForm";
import { Section } from "@/components/admin/kit";
import { Skeleton } from "@/components/ui";
import { useApi } from "@/lib/api";
import type { SettingsOverview } from "@/lib/admin";

/** 메일 발송 — 담당자 검토 요청 · 계정 안내 메일이 이 계정으로 나간다. 이 앱은 메일을 받지 않는다. */
export default function MailSettings() {
  const { data: s, loading, reload } = useApi<SettingsOverview>("/api/admin/settings");
  if (loading || !s) return <Skeleton rows={4} />;
  return (
    <Section title="메일 발송" desc="SB 검토 요청 · 계정 안내 메일은 이 계정으로 로그인해 나갑니다. [테스트] 는 로그인까지만 하고 메일은 보내지 않습니다.">
      <div className="mb-4 grid gap-3 sm:grid-cols-2">
        <div className="rounded-xl bg-surface-2 px-4 py-3">
          <div className="text-[12px] font-semibold text-ink-3">보내는 사람</div>
          <div className="mt-0.5 text-[14px]">{s.sender.system_from ? `${s.sender.system_from_name} <${s.sender.system_from}>` : "본인 계정"}</div>
        </div>
        <div className="rounded-xl bg-surface-2 px-4 py-3">
          <div className="text-[12px] font-semibold text-ink-3">내 회신 주소</div>
          <div className="mt-0.5 text-[14px]">{s.sender.my_address || <span className="text-err">찾지 못함 — 로그인 아이디를 메일 주소로 쓰면 잡힙니다</span>}</div>
        </div>
      </div>
      {s.sender.relay_owner ? (
        <CredForm title={s.sender.relay ? "공용 발송 계정 (SMTP 로그인)" : "내 발송 계정 (SMTP)"} userLabel="메일 주소"
                  username={s.sender.email} hasPassword={s.sender.has_password}
                  savePath="/api/admin/settings/smtp" testPath="/api/admin/settings/smtp/test" onSaved={reload} />
      ) : (
        <p className="text-[13px] text-ink-3">공용 발송 계정을 쓰고 있어 개인별로 등록할 것은 없습니다.</p>
      )}
    </Section>
  );
}
