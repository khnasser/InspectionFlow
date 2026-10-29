import { Alert, Button, Card, Space, Statistic, Table, Tag } from 'antd';
import { useState } from 'react';
import { api } from '../api';
import { notifyError, useLoad } from '../hooks';
import { useI18n } from '../i18n';

export function Team() {
  const { t } = useI18n();
  const { data, loading } = useLoad(() => api.get<any[]>('/v1/team/dashboard'));
  const [audit, setAudit] = useState<{ ok: boolean; rows: number } | null>(null);
  const totals = (data ?? []).reduce(
    (acc, r) => ({ open: acc.open + r.open_tasks, overdue: acc.overdue + r.overdue, today: acc.today + r.due_today }),
    { open: 0, overdue: 0, today: 0 },
  );
  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Space size="large" wrap>
        <Card><Statistic title={t('openTasks')} value={totals.open} /></Card>
        <Card><Statistic title={t('overdue')} value={totals.overdue} valueStyle={{ color: totals.overdue ? '#cf1322' : undefined }} /></Card>
        <Card><Statistic title={t('dueToday')} value={totals.today} /></Card>
      </Space>
      <Card title={t('team')}>
        <Table
          rowKey="user_id"
          loading={loading}
          pagination={false}
          dataSource={data ?? []}
          columns={[
            { title: t('name'), dataIndex: 'display_name' },
            { title: t('openTasks'), dataIndex: 'open_tasks' },
            { title: t('overdue'), dataIndex: 'overdue', render: (v) => (v ? <Tag color="red">{v}</Tag> : 0) },
            { title: t('dueToday'), dataIndex: 'due_today' },
            { title: t('delegatedTo'), dataIndex: 'delegated_to', render: (v) => (v ? <Tag color="gold">{v}</Tag> : '-') },
          ]}
        />
      </Card>
      <Card>
        <Space direction="vertical">
          <Button
            onClick={async () => {
              try {
                setAudit(await api.get('/v1/audit/verify'));
              } catch (e) {
                notifyError(e);
              }
            }}
          >
            {t('auditCheck')}
          </Button>
          {audit && <Alert type={audit.ok ? 'success' : 'error'} message={`${audit.ok ? t('verified') : 'BROKEN'} · ${audit.rows}`} />}
        </Space>
      </Card>
    </Space>
  );
}
