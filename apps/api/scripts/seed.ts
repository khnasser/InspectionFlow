/**
 * Demo tenant for the MVP, modelled on typical regulator processes:
 *  - CONSTRUCTION_SAFETY: construction-safety compliance: FIR -> warning ->
 *    committee-reviewed penalty; severity follow-up 7/3/0 days; yearly reset per project.
 *  - COMMUNITY_COMPLIANCE: overcrowding (Community Compliance BRS): warning ->
 *    final warning -> penalty; 21/10 working days.
 *  - CS-02 uses the PRD fine formula base x multiplier^(n-1).
 *
 *   DATABASE_ADMIN_URL=postgres://postgres@localhost:5432/inspectionflow npm run seed -w @inspectionflow/api
 */
import { Client } from 'pg';

export const DEMO_TENANT = 'DEMO-AUTH';

const ar = (ar: string, en: string) => JSON.stringify({ 'ar-AE': ar, 'en-US': en });

export async function seed(adminUrl: string, tenantCode = DEMO_TENANT, opts: { tenantName?: string } = {}): Promise<{ tenantId: string }> {
  const c = new Client({ connectionString: adminUrl });
  await c.connect();
  const q = async (sql: string, params: unknown[] = []) => (await c.query(sql, params)).rows;
  const one = async (sql: string, params: unknown[] = []) => (await q(sql, params))[0];

  try {
    const existing = await one('SELECT id FROM tenants WHERE code = $1', [tenantCode]);
    if (existing) return { tenantId: existing.id };

    await c.query('BEGIN');
    const tenant = await one(
      `INSERT INTO tenants (code, name, name_i18n) VALUES ($1,$2,$3) RETURNING id`,
      [tenantCode, opts.tenantName ?? 'Demo Regulatory Authority', ar('هيئة رقابية تجريبية', opts.tenantName ?? 'Demo Regulatory Authority')],
    );
    const t = tenant.id as string;
    await c.query("SELECT set_config('app.tenant_id', $1, true)", [t]);

    // Roles
    const roleIds: Record<string, string> = {};
    const roles: Array<[string, string, string]> = [
      ['INSPECTOR', 'مفتش', 'Inspector'],
      ['SENIOR_INSPECTOR', 'مفتش أول', 'Senior inspector'],
      ['SECTION_MANAGER', 'مدير القسم', 'Section manager'],
      ['COMMITTEE', 'لجنة المخالفات', 'Penalty committee'],
      ['DIRECTOR', 'مدير الإدارة', 'Director'],
      ['CEO', 'الرئيس التنفيذي', 'CEO'],
      ['ADMIN', 'مسؤول النظام', 'Administrator'],
    ];
    for (const [code, a, e] of roles) {
      roleIds[code] = (await one(`INSERT INTO roles (tenant_id, code, name_i18n, is_system) VALUES ($1,$2,$3,true) RETURNING id`, [t, code, ar(a, e)])).id;
    }

    // Users
    const domain = tenantCode.toLowerCase().replace(/[^a-z0-9]/g, '') + '.inspectionflow.test';
    const users: Record<string, string> = {};
    const people: Array<[string, string, string, string[]]> = [
      ['ahmed', 'Ahmed Al Mansoori', 'أحمد المنصوري', ['INSPECTOR']],
      ['omar', 'Omar Haddad', 'عمر حداد', ['INSPECTOR']],
      ['sara', 'Sara Al Suwaidi', 'سارة السويدي', ['SECTION_MANAGER', 'SENIOR_INSPECTOR']],
      ['khalid', 'Khalid Al Falasi', 'خالد الفلاسي', ['COMMITTEE', 'DIRECTOR']],
      ['ceo', 'Mariam Al Hashimi', 'مريم الهاشمي', ['CEO']],
      ['admin', 'Platform Admin', 'مسؤول المنصة', ['ADMIN', 'SECTION_MANAGER']],
    ];
    for (const [key, en, a, rs] of people) {
      const u = await one(
        `INSERT INTO users (tenant_id, email, display_name, display_name_i18n, employee_id)
         VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [t, `${key}@${domain}`, en, ar(a, en), key.toUpperCase()],
      );
      users[key] = u.id;
      for (const r of rs) await q(`INSERT INTO user_roles (tenant_id, user_id, role_id) VALUES ($1,$2,$3)`, [t, u.id, roleIds[r]]);
    }
    const team = await one(
      `INSERT INTO teams (tenant_id, code, name_i18n, manager_id, group_email) VALUES ($1,'CS-TEAM',$2,$3,$4) RETURNING id`,
      [t, ar('قسم السلامة الإنشائية', 'Construction Safety'), users.sara, `cs@${domain}`],
    );
    for (const m of ['ahmed', 'omar']) {
      await q(`INSERT INTO team_members (tenant_id, team_id, user_id) VALUES ($1,$2,$3)`, [t, team.id, users[m]]);
    }
    await q(`UPDATE users SET manager_id = $1 WHERE id = ANY($2::uuid[])`, [users.sara, [users.ahmed, users.omar]]);

    // Actions (rank = severity order)
    const actions: Record<string, string> = {};
    const actionDefs: Array<[string, string, string, number]> = [
      ['FIR', 'تقرير تفتيش ميداني', 'Field inspection report', 1],
      ['WARNING', 'إنذار', 'Warning', 2],
      ['FINAL_WARNING', 'إنذار نهائي', 'Final warning', 3],
      ['PENALTY', 'مخالفة مالية', 'Penalty', 4],
      ['DOUBLE_PENALTY', 'مخالفة مضاعفة', 'Double penalty', 5],
      ['SUSPENSION', 'إيقاف', 'Suspension', 6],
    ];
    for (const [code, a, e, rank] of actionDefs) {
      actions[code] = (await one(`INSERT INTO action_master (tenant_id, code, name_i18n, rank) VALUES ($1,$2,$3,$4) RETURNING id`, [t, code, ar(a, e), rank])).id;
    }

    const penaltyFee = await one(
      `INSERT INTO fee_codes (tenant_id, code, name_i18n, kind, pricing) VALUES ($1,'PEN-GEN',$2,'PENALTY','{"type":"FIXED"}') RETURNING id`,
      [t, ar('غرامة مخالفة', 'Violation penalty')],
    );

    // Inspectable types and processes
    const projectType = await one(
      `INSERT INTO inspectable_types (tenant_id, code, name_i18n, identifier_label_i18n) VALUES ($1,'BUILDING_PROJECT',$2,$3) RETURNING id`,
      [t, ar('مشروع إنشائي', 'Building project'), ar('رقم المشروع', 'Project ID')],
    );
    const unitType = await one(
      `INSERT INTO inspectable_types (tenant_id, code, name_i18n, identifier_label_i18n) VALUES ($1,'RESIDENTIAL_UNIT',$2,$3) RETURNING id`,
      [t, ar('وحدة سكنية', 'Residential unit'), ar('رقم الوحدة', 'Unit no.')],
    );
    const safety = await one(
      `INSERT INTO inspection_processes (tenant_id, code, name_i18n, billing_type, allowed_kinds, repetition_strategy, workflow_key, routine_interval_days)
       VALUES ($1,'CONSTRUCTION_SAFETY',$2,'ROUTINE','{SCHEDULED,RANDOM,FOLLOW_UP,MANAGEMENT_ORDER}','INSPECTABLE_PER_YEAR','inspection-standard',30)
       RETURNING id`,
      [t, ar('تفتيش الامتثال - السلامة الإنشائية', 'Construction safety compliance')],
    );
    const community = await one(
      `INSERT INTO inspection_processes (tenant_id, code, name_i18n, billing_type, allowed_kinds, repetition_strategy, billing_party_role, workflow_key)
       VALUES ($1,'COMMUNITY_COMPLIANCE',$2,'ROUTINE','{SCHEDULED,RANDOM,FOLLOW_UP,COMPLAINT}','INSPECTABLE','OWNER','inspection-standard')
       RETURNING id`,
      [t, ar('تفتيش الامتثال المجتمعي', 'Community compliance')],
    );
    await q(
      `INSERT INTO approval_thresholds (tenant_id, process_id, min_amount, max_amount, approval_chain) VALUES
         ($1,$2,0,50000,'{SECTION_MANAGER,COMMITTEE}'),
         ($1,$2,50000.01,NULL,'{SECTION_MANAGER,COMMITTEE,CEO}')`,
      [t, safety.id],
    );

    type Step = [number, number | null, string, 'MINOR' | 'MAJOR' | 'CRITICAL', number, boolean, boolean];
    const violation = async (
      processId: string,
      code: string,
      category: string,
      descAr: string,
      descEn: string,
      severity: string,
      rule: { fineMode?: 'LADDER' | 'MULTIPLIER'; base?: number; mult?: number; cap?: number; followUp: string; calendar?: boolean; window?: number | null },
      ladder: Step[],
      parameters: unknown = null,
    ) => {
      const vt = await one(
        `INSERT INTO violation_templates (tenant_id, code, process_id, category, description_i18n, default_severity, parameters)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [t, code, processId, category, ar(descAr, descEn), severity, parameters ? JSON.stringify(parameters) : null],
      );
      await q(
        `INSERT INTO violation_rules (tenant_id, violation_template_id, repeat_window_days, fine_mode, base_fine, fine_multiplier,
                                      fine_cap, follow_up_days, calendar_days)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [t, vt.id, rule.window ?? null, rule.fineMode ?? 'LADDER', rule.base ?? null, rule.mult ?? null, rule.cap ?? null, rule.followUp, rule.calendar ?? true],
      );
      for (const [from, to, action, sev, fine, mgr, committee] of ladder) {
        await q(
          `INSERT INTO violation_action_ladder (tenant_id, violation_template_id, from_occurrence, to_occurrence, action_id, severity,
                                                fee_code_id, fine_amount, requires_manager_review, requires_committee_review)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [t, vt.id, from, to, actions[action], sev, penaltyFee.id, fine, mgr, committee],
        );
      }
    };

    const cedFollowUp = '{"MINOR":7,"MAJOR":3,"CRITICAL":0}';
    await violation(safety.id, 'CS-01', 'Working at height', 'عدم توفير حماية الحواف للعمل على المرتفعات', 'No edge protection for work at height', 'MAJOR',
      { followUp: cedFollowUp }, [
        [1, 1, 'FIR', 'MINOR', 0, false, false],
        [2, 2, 'WARNING', 'MAJOR', 0, true, false],
        [3, null, 'PENALTY', 'CRITICAL', 5000, true, true],
      ]);
    await violation(safety.id, 'CS-02', 'PPE', 'عمال بدون معدات الحماية الشخصية', 'Workers without personal protective equipment', 'MAJOR',
      { fineMode: 'MULTIPLIER', base: 1000, mult: 2, cap: 20000, followUp: cedFollowUp }, [
        [1, 2, 'PENALTY', 'MAJOR', 0, true, false],
        [3, null, 'DOUBLE_PENALTY', 'CRITICAL', 0, true, true],
      ]);
    await violation(safety.id, 'CS-03', 'Housekeeping', 'سوء التنظيم ومخلفات البناء في الممرات', 'Poor housekeeping, debris in access routes', 'MINOR',
      { followUp: cedFollowUp }, [
        [1, 1, 'FIR', 'MINOR', 0, false, false],
        [2, null, 'WARNING', 'MAJOR', 0, true, false],
      ]);
    await violation(community.id, 'OC', 'Occupancy', 'اكتظاظ: عدد السكان يتجاوز العدد المسموح', 'Overcrowding: occupants exceed the permitted number', 'CRITICAL',
      { followUp: '{"MINOR":21,"MAJOR":10,"CRITICAL":10}', calendar: false, window: 365 }, [
        [1, 1, 'WARNING', 'MAJOR', 0, true, false],
        [2, 2, 'FINAL_WARNING', 'MAJOR', 0, true, false],
        [3, null, 'PENALTY', 'CRITICAL', 10000, true, true],
      ], [{ code: 'OCCUPANTS', type: 'NUMBER', min: 0, label: { 'ar-AE': 'عدد السكان', 'en-US': 'Number of occupants' } }]);

    // Checklist for construction safety
    const cl = await one(
      `INSERT INTO checklists (tenant_id, process_id, code, name_i18n, status, effective_from) VALUES ($1,$2,'CS-SITE',$3,'PUBLISHED',now()) RETURNING id`,
      [t, safety.id, ar('قائمة فحص سلامة الموقع', 'Site safety checklist')],
    );
    const sec = await one(
      `INSERT INTO checklist_sections (tenant_id, checklist_id, code, name_i18n, order_num) VALUES ($1,$2,'GEN',$3,1) RETURNING id`,
      [t, cl.id, ar('عام', 'General')],
    );
    const items: Array<[string, string, string]> = [
      ['EDGE', 'حماية الحواف متوفرة', 'Edge protection in place'],
      ['PPE', 'جميع العمال يرتدون معدات الحماية', 'All workers wear PPE'],
      ['ACCESS', 'الممرات خالية من العوائق', 'Access routes clear'],
      ['PERMIT', 'تصريح العمل معروض في الموقع', 'Work permit displayed on site'],
    ];
    let order = 1;
    for (const [code, a, e] of items) {
      await q(
        `INSERT INTO checklist_items (tenant_id, section_id, code, label_i18n, field_type, order_num) VALUES ($1,$2,$3,$4,'YES_NO_NA',$5)`,
        [t, sec.id, code, ar(a, e), order++],
      );
    }

    // Parties and inspectables
    const party = async (company: string, companyAr: string, email: string, license: string) => {
      const p = await one(
        `INSERT INTO parties (tenant_id, type, company_name, name_i18n, email, phone) VALUES ($1,'COMPANY',$2,$3,$4,'+97140000000') RETURNING id`,
        [t, company, ar(companyAr, company), email],
      );
      await q(
        `INSERT INTO party_identifiers (tenant_id, party_id, id_type, id_value_hash, id_value_plain, issuer)
         VALUES ($1,$2,'TRADE_LICENSE', encode(digest($3,'sha256'),'hex'), $3, 'Licensing Authority')`,
        [t, p.id, license],
      );
      return p.id as string;
    };
    const owner = await party('Gulf Logistics Parks LLC', 'حدائق الخليج اللوجستية ذ.م.م', `owner@${domain}`, 'TL-100245');
    const contractor = await party('Al Bina Contracting', 'البناء للمقاولات', `contractor@${domain}`, 'TL-200871');
    const consultant = await party('Arch Consult Engineering', 'آرك للاستشارات الهندسية', `consultant@${domain}`, 'TL-300112');
    const landlord = await party('Marina Homes Real Estate', 'مارينا هومز العقارية', `landlord@${domain}`, 'TL-400990');

    const inspectable = async (typeId: string, identifier: string, name: string, nameAr: string, lat: number, lng: number) =>
      (await one(
        `INSERT INTO inspectables (tenant_id, type_id, identifier, name, name_i18n, latitude, longitude, address)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'Al Quoz Industrial Area, Dubai') RETURNING id`,
        [t, typeId, identifier, name, ar(nameAr, name), lat, lng],
      )).id as string;
    const p1 = await inspectable(projectType.id, 'P-1001', 'Logistics warehouse extension', 'توسعة المستودع اللوجستي', 25.0112, 55.0921);
    const p2 = await inspectable(projectType.id, 'P-1002', 'Staff accommodation block B', 'مبنى سكن الموظفين ب', 25.0201, 55.1012);
    const v1 = await inspectable(unitType.id, 'V-2201', 'Villa 2201, Cluster 4', 'فيلا 2201، المجمع 4', 25.0301, 55.1203);

    const link = (inspectableId: string, partyId: string, role: string, primary: boolean) =>
      q(`INSERT INTO inspectable_party_links (tenant_id, inspectable_id, party_id, role, is_primary) VALUES ($1,$2,$3,$4,$5)`,
        [t, inspectableId, partyId, role, primary]);
    await link(p1, owner, 'OWNER', true);
    await link(p1, contractor, 'CONTRACTOR', false);
    await link(p1, consultant, 'CONSULTANT', false);
    await link(p2, owner, 'OWNER', true);
    await link(p2, contractor, 'CONTRACTOR', false);
    await link(v1, landlord, 'OWNER', true);

    // Scheduled work for Ahmed: an open SCHEDULED log + INSPECT task per site
    let n = 1;
    for (const [inspectableId, processId, code] of [[p1, safety.id, 'CONSTRUCTION_SAFETY'], [p2, safety.id, 'CONSTRUCTION_SAFETY'], [v1, community.id, 'COMMUNITY_COMPLIANCE']]) {
      const log = await one(
        `INSERT INTO inspection_logs (tenant_id, log_number, inspectable_id, process_id, kind, owner_id)
         VALUES ($1,$2,$3,$4,'SCHEDULED',$5) RETURNING id`,
        [t, `${code}-${new Date().getUTCFullYear()}-S${String(n++).padStart(5, '0')}`, inspectableId, processId, users.sara],
      );
      await q(
        `INSERT INTO tasks (tenant_id, task_type, log_id, assignee_id, original_assignee_id, due_at, form_key)
         VALUES ($1,'INSPECT',$2,$3,$3, now() + interval '1 day','routine-inspection')`,
        [t, log.id, users.ahmed],
      );
    }

    await c.query('COMMIT');
    return { tenantId: t };
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    await c.end();
  }
}

if (require.main === module) {
  const url = process.env.DATABASE_ADMIN_URL;
  if (!url) {
    console.error('DATABASE_ADMIN_URL is required');
    process.exit(1);
  }
  seed(url)
    .then(({ tenantId }) => console.log(`Seeded tenant ${DEMO_TENANT} (${tenantId}). Users: ahmed|omar|sara|khalid|ceo|admin@demoauth.inspectionflow.test`))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
