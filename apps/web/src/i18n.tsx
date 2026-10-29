import { createContext, ReactNode, useContext, useEffect, useMemo, useState } from 'react';

export type Lang = 'ar' | 'en';

const dict = {
  appName: { ar: 'إنسبكشن فلو', en: 'InspectionFlow' },
  signIn: { ar: 'تسجيل الدخول', en: 'Sign in' },
  signOut: { ar: 'تسجيل الخروج', en: 'Sign out' },
  tenant: { ar: 'الجهة', en: 'Organisation' },
  user: { ar: 'المستخدم', en: 'User' },
  devNote: { ar: 'وضع التطوير: الدخول بدون كلمة مرور. في الإنتاج يتم الدخول عبر Keycloak أو الهوية الرقمية.', en: 'Development mode: password-less sign-in. Production uses Keycloak or UAE PASS.' },
  myTasks: { ar: 'مهامي', en: 'My tasks' },
  reviews: { ar: 'المراجعات', en: 'Reviews' },
  inspectables: { ar: 'المواقع والأصول', en: 'Sites & assets' },
  payments: { ar: 'إشعارات الدفع', en: 'Payment advices' },
  team: { ar: 'لوحة الفريق', en: 'Team dashboard' },
  delegate: { ar: 'تفويض المهام', en: 'Delegate tasks' },
  includeDelegated: { ar: 'إظهار المهام المفوضة إليّ', en: 'Show tasks delegated to me' },
  type: { ar: 'النوع', en: 'Type' },
  site: { ar: 'الموقع', en: 'Site' },
  process: { ar: 'العملية', en: 'Process' },
  due: { ar: 'تاريخ الاستحقاق', en: 'Due' },
  status: { ar: 'الحالة', en: 'Status' },
  overdue: { ar: 'متأخرة', en: 'Overdue' },
  open: { ar: 'فتح', en: 'Open' },
  inspect: { ar: 'تفتيش', en: 'Inspect' },
  claim: { ar: 'استلام', en: 'Claim' },
  log: { ar: 'السجل', en: 'Log' },
  inspector: { ar: 'المفتش', en: 'Inspector' },
  totalFine: { ar: 'إجمالي الغرامات', en: 'Total fines' },
  aed: { ar: 'درهم', en: 'AED' },
  approve: { ar: 'اعتماد', en: 'Approve' },
  reject: { ar: 'رفض', en: 'Reject' },
  moreInfo: { ar: 'طلب معلومات إضافية', en: 'Request more info' },
  comment: { ar: 'ملاحظة', en: 'Comment' },
  findings: { ar: 'المخالفات', en: 'Findings' },
  code: { ar: 'الرمز', en: 'Code' },
  description: { ar: 'الوصف', en: 'Description' },
  occurrence: { ar: 'التكرار', en: 'Occurrence' },
  severity: { ar: 'الخطورة', en: 'Severity' },
  action: { ar: 'الإجراء', en: 'Action' },
  fine: { ar: 'الغرامة', en: 'Fine' },
  resolveBy: { ar: 'تاريخ التصحيح', en: 'Resolve by' },
  override: { ar: 'تعديل الخطورة', en: 'Severity override' },
  approveOverride: { ar: 'قبول التعديل', en: 'Accept override' },
  approvals: { ar: 'مراحل الاعتماد', en: 'Approval steps' },
  report: { ar: 'التقرير', en: 'Report' },
  search: { ar: 'بحث', en: 'Search' },
  identifier: { ar: 'المعرف', en: 'Identifier' },
  name: { ar: 'الاسم', en: 'Name' },
  lastInspected: { ar: 'آخر تفتيش', en: 'Last inspected' },
  parties: { ar: 'الأطراف', en: 'Parties' },
  role: { ar: 'الدور', en: 'Role' },
  openFindings: { ar: 'المخالفات المفتوحة', en: 'Open findings' },
  history: { ar: 'سجل التفتيش', en: 'Inspection history' },
  newInspection: { ar: 'تفتيش جديد', en: 'New inspection' },
  addFinding: { ar: 'إضافة مخالفة', en: 'Add finding' },
  preview: { ar: 'معاينة النتيجة', en: 'Preview outcome' },
  submit: { ar: 'إرسال', en: 'Submit' },
  resolved: { ar: 'تم التصحيح', en: 'Resolved' },
  remarks: { ar: 'الملاحظات', en: 'Remarks' },
  number: { ar: 'الرقم', en: 'Number' },
  party: { ar: 'الطرف', en: 'Party' },
  amount: { ar: 'المبلغ', en: 'Amount' },
  payLink: { ar: 'رابط الدفع', en: 'Pay link' },
  openTasks: { ar: 'مهام مفتوحة', en: 'Open tasks' },
  dueToday: { ar: 'مستحقة اليوم', en: 'Due today' },
  delegatedTo: { ar: 'مفوض إلى', en: 'Delegated to' },
  reassign: { ar: 'إعادة إسناد', en: 'Reassign' },
  delegateTo: { ar: 'تفويض إلى', en: 'Delegate to' },
  period: { ar: 'الفترة', en: 'Period' },
  reason: { ar: 'السبب', en: 'Reason' },
  save: { ar: 'حفظ', en: 'Save' },
  cancel: { ar: 'إلغاء', en: 'Cancel' },
  done: { ar: 'تم', en: 'Done' },
  empty: { ar: 'لا توجد بيانات', en: 'Nothing here' },
  category: { ar: 'التصنيف', en: 'Category' },
  review: { ar: 'المراجعة', en: 'Review' },
  followUp: { ar: 'تاريخ المتابعة', en: 'Follow-up' },
  chain: { ar: 'مسار الاعتماد', en: 'Approval route' },
  violation: { ar: 'المخالفة', en: 'Violation' },
  verified: { ar: 'سلسلة التدقيق سليمة', en: 'Audit chain intact' },
  auditCheck: { ar: 'فحص سجل التدقيق', en: 'Verify audit log' },
} as const;

export type Key = keyof typeof dict;

const labels: Record<string, Record<Lang, string>> = {
  MINOR: { ar: 'بسيطة', en: 'Minor' },
  MAJOR: { ar: 'جسيمة', en: 'Major' },
  CRITICAL: { ar: 'حرجة', en: 'Critical' },
  INSPECT: { ar: 'تفتيش', en: 'Inspection' },
  REVIEW: { ar: 'مراجعة', en: 'Review' },
  MORE_INFO: { ar: 'معلومات إضافية', en: 'More info' },
  OPEN: { ar: 'مفتوحة', en: 'Open' },
  CLAIMED: { ar: 'مستلمة', en: 'Claimed' },
  APPROVED: { ar: 'معتمد', en: 'Approved' },
  UNDER_REVIEW: { ar: 'قيد المراجعة', en: 'Under review' },
  COMMITTEE_REVIEW: { ar: 'لدى اللجنة', en: 'With committee' },
  REJECTED: { ar: 'مرفوض', en: 'Rejected' },
  ISSUED: { ar: 'صادر', en: 'Issued' },
  PAID: { ar: 'مدفوع', en: 'Paid' },
  PARTIAL: { ar: 'مدفوع جزئياً', en: 'Partly paid' },
  NO_FINDINGS: { ar: 'بدون مخالفات', en: 'No findings' },
  WARNING: { ar: 'إنذار', en: 'Warning' },
  PENALTY_CRITICAL: { ar: 'مخالفة حرجة', en: 'Critical penalty' },
  FIR: { ar: 'تقرير ميداني', en: 'FIR' },
  FINAL_WARNING: { ar: 'إنذار نهائي', en: 'Final warning' },
  PENALTY: { ar: 'غرامة', en: 'Penalty' },
  DOUBLE_PENALTY: { ar: 'غرامة مضاعفة', en: 'Double penalty' },
  SECTION_MANAGER: { ar: 'مدير القسم', en: 'Section manager' },
  COMMITTEE: { ar: 'اللجنة', en: 'Committee' },
  CEO: { ar: 'الرئيس التنفيذي', en: 'CEO' },
  NONE: { ar: 'لا يلزم', en: 'Not required' },
  MANAGER: { ar: 'المدير', en: 'Manager' },
  PENDING: { ar: 'بانتظار الاعتماد', en: 'Pending approval' },
};

interface Ctx {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: (k: Key) => string;
  label: (code?: string | null) => string;
  i18n: (value?: Record<string, string> | null, fallback?: string) => string;
}

const I18nContext = createContext<Ctx>(null as unknown as Ctx);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLang] = useState<Lang>(() => {
    try {
      return (localStorage.getItem('inspectionflow.lang') as Lang) || 'ar';
    } catch {
      return 'ar';
    }
  });
  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
    try {
      localStorage.setItem('inspectionflow.lang', lang);
    } catch {
      /* ignore */
    }
  }, [lang]);
  const value = useMemo<Ctx>(
    () => ({
      lang,
      setLang,
      t: (k) => dict[k][lang],
      label: (code) => (code ? labels[code]?.[lang] ?? code : '-'),
      i18n: (v, fallback = '') => (v ? v[lang === 'ar' ? 'ar-AE' : 'en-US'] ?? Object.values(v)[0] ?? fallback : fallback),
    }),
    [lang],
  );
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export const useI18n = () => useContext(I18nContext);
