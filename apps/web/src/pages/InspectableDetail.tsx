import { Alert, Button, Card, Checkbox, Descriptions, Input, Select, Space, Table, Tag, message } from 'antd';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { uuidv7 } from '@inspectionflow/engine';
import { api, session } from '../api';
import { date, money, notifyError, useLoad } from '../hooks';
import { useI18n } from '../i18n';

interface DraftFinding {
  id: string;
  violationCode: string;
  remarks?: string;
  partyIds: string[];
  overrideSeverity?: string;
  overrideReason?: string;
}

const sevColor: Record<string, string> = { MINOR: 'blue', MAJOR: 'orange', CRITICAL: 'red' };

export function InspectableDetail() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const nav = useNavigate();
  const { t, label, lang, i18n } = useI18n();
  const { data } = useLoad(() => api.get<any>(`/v1/inspectables/${id}`), [id]);
  const { data: bundle } = useLoad(() => api.get<any>('/v1/config/bundle'));
  const canInspect = session.has('INSPECTOR', 'SENIOR_INSPECTOR');

  const [processCode, setProcessCode] = useState<string | undefined>(params.get('inspect') ?? undefined);
  const [findings, setFindings] = useState<DraftFinding[]>([]);
  const [resolved, setResolved] = useState<string[]>([]);
  const [remarks, setRemarks] = useState('');
  const [preview, setPreview] = useState<any>(null);
  const [busy, setBusy] = useState(false);

  const process = useMemo(() => bundle?.processes.find((p: any) => p.code === processCode), [bundle, processCode]);
  useEffect(() => setPreview(null), [findings, processCode]);

  const partyOptions = (data?.parties ?? []).map((p: any) => ({
    value: p.id,
    label: `${p.company_name ?? `${p.first_name} ${p.last_name ?? ''}`} · ${p.role}`,
  }));

  async function runPreview() {
    try {
      setPreview(
        await api.post('/v1/engine/evaluate', {
          processCode,
          inspectableId: id,
          findings: findings.map((f) => ({ violationCode: f.violationCode, partyIds: f.partyIds })),
        }),
      );
    } catch (e) {
      notifyError(e);
    }
  }

  async function submit() {
    setBusy(true);
    try {
      const res = await api.post<any>('/v1/inspections/submit', {
        id: uuidv7(),
        clientMutationId: uuidv7(),
        processCode,
        inspectableId: id,
        kind: params.get('task') ? (data.openFindings.length ? 'FOLLOW_UP' : 'SCHEDULED') : 'RANDOM',
        taskId: params.get('task') ?? undefined,
        completedAt: new Date().toISOString(),
        generalRemarks: remarks || undefined,
        resolvedFindingIds: resolved,
        findings: findings.map((f) => ({
          id: f.id,
          violationCode: f.violationCode,
          partyIds: f.partyIds,
          remarks: f.remarks,
          override: f.overrideSeverity ? { severity: f.overrideSeverity, reason: f.overrideReason ?? '' } : undefined,
        })),
      });
      message.success(`${res.logNumber}: ${label(res.status)}`);
      nav(`/inspections/${res.inspectionId}`);
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(false);
    }
  }

  if (!data) return <Card loading />;
  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Card title={`${i18n(data.name_i18n, data.name)} (${data.identifier})`}>
        <Descriptions size="small" column={{ xs: 1, md: 3 }}>
          <Descriptions.Item label={t('type')}>{data.type_code}</Descriptions.Item>
          <Descriptions.Item label={t('lastInspected')}>{date(data.last_inspected_at, lang)}</Descriptions.Item>
          <Descriptions.Item label={t('status')}>{data.status}</Descriptions.Item>
        </Descriptions>
        <Table
          size="small"
          rowKey="link_id"
          pagination={false}
          dataSource={data.parties}
          title={() => t('parties')}
          columns={[
            { title: t('name'), render: (_, p: any) => p.company_name ?? `${p.first_name} ${p.last_name ?? ''}` },
            { title: t('role'), dataIndex: 'role', render: (v, p: any) => <Space>{v}{p.is_primary && <Tag>primary</Tag>}</Space> },
            { title: 'Email', dataIndex: 'email' },
          ]}
        />
      </Card>

      <Card title={t('openFindings')}>
        <Table
          size="small"
          rowKey="id"
          pagination={false}
          dataSource={data.openFindings}
          locale={{ emptyText: t('empty') }}
          columns={[
            ...(canInspect
              ? [{
                  title: t('resolved'),
                  render: (_: unknown, f: any) => (
                    <Checkbox
                      checked={resolved.includes(f.id)}
                      onChange={(e) => setResolved((s) => (e.target.checked ? [...s, f.id] : s.filter((x) => x !== f.id)))}
                    />
                  ),
                }]
              : []),
            { title: t('code'), dataIndex: 'code' },
            { title: t('description'), render: (_, f: any) => i18n(f.description_i18n, f.code) },
            { title: t('severity'), dataIndex: 'final_severity', render: (v) => <Tag color={sevColor[v]}>{label(v)}</Tag> },
            { title: t('resolveBy'), dataIndex: 'resolve_by', render: (v) => date(v, lang) },
            { title: t('log'), dataIndex: 'log_number' },
          ]}
        />
      </Card>

      {canInspect && (
        <Card title={t('newInspection')}>
          <Space direction="vertical" style={{ width: '100%' }}>
            <Select
              style={{ width: '100%', maxWidth: 420 }}
              placeholder={t('process')}
              value={processCode}
              onChange={(v) => {
                setProcessCode(v);
                setFindings([]);
              }}
              options={(bundle?.processes ?? []).map((p: any) => ({ value: p.code, label: i18n(p.name_i18n, p.code) }))}
            />
            {process && (
              <>
                {findings.map((f, idx) => {
                  const v = process.violations.find((x: any) => x.code === f.violationCode);
                  const update = (patch: Partial<DraftFinding>) =>
                    setFindings((s) => s.map((x, i) => (i === idx ? { ...x, ...patch } : x)));
                  return (
                    <Card key={f.id} size="small" type="inner" title={`${f.violationCode} — ${i18n(v?.description_i18n, '')}`}
                      extra={<Button size="small" danger onClick={() => setFindings((s) => s.filter((_, i) => i !== idx))}>×</Button>}>
                      <Space direction="vertical" style={{ width: '100%' }}>
                        <Select mode="multiple" style={{ width: '100%' }} placeholder={t('party')} value={f.partyIds}
                          onChange={(partyIds) => update({ partyIds })} options={partyOptions} />
                        <Input placeholder={t('remarks')} value={f.remarks} onChange={(e) => update({ remarks: e.target.value })} />
                        {v?.rule?.severityOverride !== 'NOT_ALLOWED' && (
                          <Space wrap>
                            <Select allowClear style={{ width: 180 }} placeholder={t('override')} value={f.overrideSeverity}
                              onChange={(overrideSeverity) => update({ overrideSeverity })}
                              options={['MINOR', 'MAJOR', 'CRITICAL'].map((s) => ({ value: s, label: label(s) }))} />
                            {f.overrideSeverity && (
                              <Input style={{ width: 280 }} placeholder={t('reason')} value={f.overrideReason}
                                onChange={(e) => update({ overrideReason: e.target.value })} />
                            )}
                          </Space>
                        )}
                      </Space>
                    </Card>
                  );
                })}
                <Select
                  showSearch
                  style={{ width: '100%', maxWidth: 520 }}
                  placeholder={t('addFinding')}
                  value={null}
                  optionFilterProp="label"
                  onChange={(code: string) => setFindings((s) => [...s, { id: uuidv7(), violationCode: code, partyIds: [] }])}
                  options={process.violations
                    .filter((v: any) => !findings.some((f) => f.violationCode === v.code))
                    .map((v: any) => ({ value: v.code, label: `${v.code} — ${i18n(v.description_i18n, v.code)}` }))}
                />
                <Input.TextArea rows={2} placeholder={t('remarks')} value={remarks} onChange={(e) => setRemarks(e.target.value)} />
                <Space wrap>
                  <Button onClick={runPreview} disabled={!findings.length}>{t('preview')}</Button>
                  <Button type="primary" loading={busy} onClick={submit}>{t('submit')}</Button>
                </Space>
                {preview && (
                  <Alert
                    type={preview.review === 'NONE' ? 'success' : 'warning'}
                    message={`${t('category')}: ${label(preview.category)} · ${t('totalFine')}: ${money(preview.totalFine, lang)} ${t('aed')} · ${t('review')}: ${label(preview.review)} · ${t('followUp')}: ${preview.followUpDate ?? '-'}`}
                    description={preview.findings
                      .map((r: any) => `${r.violationCode}: #${r.occurrence} → ${label(r.actionCode)} (${label(r.severity)}), ${money(r.fine, lang)}`)
                      .join(' | ')}
                  />
                )}
              </>
            )}
          </Space>
        </Card>
      )}

      <Card title={t('history')}>
        <Table
          size="small"
          rowKey="id"
          dataSource={data.history}
          pagination={false}
          onRow={(r: any) => ({ onClick: () => nav(`/inspections/${r.id}`), style: { cursor: 'pointer' } })}
          columns={[
            { title: t('due'), dataIndex: 'completed_at', render: (v) => date(v, lang) },
            { title: t('log'), render: (_, r: any) => `${r.log_number} #${r.cycle_number}` },
            { title: t('inspector'), dataIndex: 'inspector' },
            { title: t('category'), dataIndex: 'category', render: (v) => label(v) },
            { title: t('status'), dataIndex: 'status', render: (v) => <Tag>{label(v)}</Tag> },
            { title: t('totalFine'), dataIndex: 'total_fine', render: (v) => money(v, lang) },
          ]}
        />
      </Card>
    </Space>
  );
}
