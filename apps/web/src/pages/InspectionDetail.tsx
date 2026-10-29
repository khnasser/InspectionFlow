import { Button, Card, Checkbox, Descriptions, Input, Space, Table, Tag, Timeline, message } from 'antd';
import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, session } from '../api';
import { date, money, notifyError, useLoad } from '../hooks';
import { useI18n } from '../i18n';

const sevColor: Record<string, string> = { MINOR: 'blue', MAJOR: 'orange', CRITICAL: 'red' };

export function InspectionDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const { t, label, lang, i18n } = useI18n();
  const { data, loading, reload } = useLoad(() => api.get<any>(`/v1/inspections/${id}`), [id]);
  const pendingStep = useMemo(() => {
    if (!data) return null;
    const firstOpen = (data.approvals ?? []).find((a: any) => !a.decision);
    return firstOpen && session.has(firstOpen.approver_role, 'ADMIN') ? firstOpen : null;
  }, [data]);
  const [comment, setComment] = useState('');
  const [rejectedOverrides, setRejectedOverrides] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  async function decide(decision: 'APPROVED' | 'REJECTED' | 'MORE_INFO') {
    setBusy(true);
    try {
      await api.post(`/v1/approvals/${pendingStep.id}/decide`, {
        decision,
        comment: comment || undefined,
        overrides: data.findingDetails
          .filter((f: any) => f.override_status === 'PENDING')
          .map((f: any) => ({ findingId: f.id, approve: !rejectedOverrides.includes(f.id) })),
      });
      message.success(t('done'));
      decision === 'APPROVED' ? reload() : nav('/reviews');
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(false);
    }
  }

  if (!data) return <Card loading={loading} />;
  const details: Record<string, any> = Object.fromEntries((data.findingDetails ?? []).map((f: any) => [f.id, f]));

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Card
        title={`${data.logNumber} · #${data.cycleNumber}`}
        extra={
          <Button onClick={() => api.openHtml(`/v1/inspections/${id}/report.html?lang=${lang}`).catch(notifyError)}>{t('report')}</Button>
        }
      >
        <Descriptions column={{ xs: 1, md: 3 }} size="small">
          <Descriptions.Item label={t('site')}>{`${i18n(data.inspectable_name_i18n, data.inspectable_name)} (${data.identifier})`}</Descriptions.Item>
          <Descriptions.Item label={t('process')}>{i18n(data.process_name, data.process_code)}</Descriptions.Item>
          <Descriptions.Item label={t('inspector')}>{data.inspector}</Descriptions.Item>
          <Descriptions.Item label={t('status')}><Tag>{label(data.status)}</Tag></Descriptions.Item>
          <Descriptions.Item label={t('category')}>{label(data.category)}</Descriptions.Item>
          <Descriptions.Item label={t('totalFine')}>{`${money(data.totalFine, lang)} ${t('aed')}`}</Descriptions.Item>
          <Descriptions.Item label={t('followUp')}>{data.followUpDate ?? '-'}</Descriptions.Item>
          <Descriptions.Item label={t('remarks')}>{data.general_remarks ?? '-'}</Descriptions.Item>
        </Descriptions>
      </Card>

      <Card title={t('findings')}>
        <Table
          rowKey="id"
          pagination={false}
          dataSource={data.findings}
          scroll={{ x: 760 }}
          columns={[
            { title: t('code'), dataIndex: 'violationCode' },
            { title: t('description'), render: (_, f: any) => i18n(details[f.id]?.description_i18n, f.violationCode) },
            { title: t('occurrence'), dataIndex: 'occurrence' },
            {
              title: t('severity'),
              render: (_, f: any) => (
                <Space size={4} wrap>
                  <Tag color={sevColor[f.severity]}>{label(f.severity)}</Tag>
                  {f.overrideStatus !== 'NONE' && <Tag>{`${t('override')}: ${label(f.overrideStatus)}`}</Tag>}
                </Space>
              ),
            },
            { title: t('action'), dataIndex: 'actionCode', render: (v) => label(v) },
            { title: t('fine'), dataIndex: 'fine', render: (v) => money(v, lang) },
            { title: t('resolveBy'), dataIndex: 'resolveBy' },
            ...(pendingStep
              ? [
                  {
                    title: t('approveOverride'),
                    render: (_: unknown, f: any) =>
                      details[f.id]?.override_status === 'PENDING' ? (
                        <Checkbox
                          checked={!rejectedOverrides.includes(f.id)}
                          onChange={(e) =>
                            setRejectedOverrides((s) => (e.target.checked ? s.filter((x) => x !== f.id) : [...s, f.id]))
                          }
                        >
                          {details[f.id]?.override_reason}
                        </Checkbox>
                      ) : null,
                  },
                ]
              : []),
          ]}
        />
      </Card>

      <Card title={t('approvals')}>
        <Timeline
          items={(data.approvals ?? []).map((a: any) => ({
            color: a.decision === 'APPROVED' ? 'green' : a.decision === 'REJECTED' ? 'red' : a.decision ? 'orange' : 'gray',
            children: (
              <Space size={6} wrap>
                <strong>{`${a.step_no}. ${label(a.approver_role)}`}</strong>
                {a.decision ? <Tag>{label(a.decision)}</Tag> : <Tag color="default">…</Tag>}
                {a.approver && <bdi>{a.approver}</bdi>}
                {a.decided_at && <span>{date(a.decided_at, lang)}</span>}
                {a.comment && <em>{a.comment}</em>}
              </Space>
            ),
          }))}
        />
        {pendingStep && (
          <Space direction="vertical" style={{ width: '100%' }}>
            <Input.TextArea rows={2} placeholder={t('comment')} value={comment} onChange={(e) => setComment(e.target.value)} />
            <Space wrap>
              <Button type="primary" loading={busy} onClick={() => decide('APPROVED')}>{t('approve')}</Button>
              <Button loading={busy} onClick={() => decide('MORE_INFO')} disabled={!comment}>{t('moreInfo')}</Button>
              <Button danger loading={busy} onClick={() => decide('REJECTED')}>{t('reject')}</Button>
            </Space>
          </Space>
        )}
      </Card>
    </Space>
  );
}
