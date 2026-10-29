export type Lang = 'ar' | 'en';

const d = {
  signIn: ['تسجيل الدخول', 'Sign in'],
  server: ['عنوان الخادم', 'Server URL'],
  tenant: ['الجهة', 'Organisation'],
  email: ['البريد الإلكتروني', 'Email'],
  tasks: ['مهامي', 'My tasks'],
  sync: ['مزامنة', 'Sync'],
  pending: ['بانتظار الإرسال', 'Waiting to send'],
  offline: ['غير متصل', 'Offline'],
  online: ['متصل', 'Online'],
  failed: ['تحتاج تصحيح', 'Needs fixing'],
  noTasks: ['لا توجد مهام. اسحب للتحديث أو اضغط مزامنة.', 'No tasks. Sync to refresh.'],
  due: ['الاستحقاق', 'Due'],
  inspect: ['بدء التفتيش', 'Start inspection'],
  openFindings: ['مخالفات سابقة مفتوحة', 'Open earlier findings'],
  resolved: ['تم التصحيح', 'Resolved'],
  checklist: ['قائمة الفحص', 'Checklist'],
  yes: ['نعم', 'Yes'],
  no: ['لا', 'No'],
  na: ['لا ينطبق', 'N/A'],
  addViolation: ['إضافة مخالفة', 'Add violation'],
  findings: ['المخالفات', 'Findings'],
  parties: ['الطرف المسؤول', 'Responsible party'],
  remarks: ['ملاحظات', 'Remarks'],
  result: ['النتيجة المبدئية', 'Provisional outcome'],
  occurrence: ['التكرار', 'Occurrence'],
  fine: ['الغرامة', 'Fine'],
  total: ['الإجمالي', 'Total'],
  review: ['المراجعة', 'Review'],
  followUp: ['المتابعة', 'Follow-up'],
  signer: ['اسم ممثل العميل', 'Client representative'],
  sign: ['توقيع العميل', 'Client signature'],
  clear: ['مسح', 'Clear'],
  refused: ['رفض التوقيع', 'Refused to sign'],
  submit: ['حفظ وإرسال', 'Save and send'],
  queued: ['تم الحفظ. سيُرسل عند توفر الاتصال.', 'Saved. It will be sent when online.'],
  sent: ['تم الإرسال', 'Sent'],
  back: ['رجوع', 'Back'],
  signOut: ['خروج', 'Sign out'],
  aed: ['درهم', 'AED'],
  serverNote: ['النتيجة النهائية يحددها الخادم عند الإرسال.', 'The server confirms the final outcome on submit.'],
} as const;

export type Key = keyof typeof d;
export const tr = (lang: Lang, k: Key) => d[k][lang === 'ar' ? 0 : 1];

const labels: Record<string, [string, string]> = {
  MINOR: ['بسيطة', 'Minor'],
  MAJOR: ['جسيمة', 'Major'],
  CRITICAL: ['حرجة', 'Critical'],
  FIR: ['تقرير ميداني', 'FIR'],
  WARNING: ['إنذار', 'Warning'],
  FINAL_WARNING: ['إنذار نهائي', 'Final warning'],
  PENALTY: ['غرامة', 'Penalty'],
  DOUBLE_PENALTY: ['غرامة مضاعفة', 'Double penalty'],
  NONE: ['لا يلزم', 'Not required'],
  MANAGER: ['المدير', 'Manager'],
  COMMITTEE: ['اللجنة', 'Committee'],
  INSPECT: ['تفتيش', 'Inspection'],
};
export const label = (lang: Lang, code?: string | null) => (code ? labels[code]?.[lang === 'ar' ? 0 : 1] ?? code : '-');
export const i18n = (lang: Lang, v?: Record<string, string> | null, fb = '') =>
  v ? v[lang === 'ar' ? 'ar-AE' : 'en-US'] ?? Object.values(v)[0] ?? fb : fb;
